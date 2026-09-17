import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import path from "node:path";

export interface MailEntry {
  name: string;
  at: number;
  text: string;
}

export interface NotifyOptions {
  /** append-only file children (and the bridge) write notices into */
  mailboxPath: string;
  /**
   * called for every parsed mailbox entry (in addition to inbox) —
   * the controller feeds these into the session event log so `wait`
   * and `poll logs` can observe report() calls
   */
  onEntry?: (e: MailEntry) => void;
  onLog?: (line: string) => void;
}

const INBOX_CAP = 100;
const MAILBOX_ROTATE = 1_000_000;

/**
 * Delivery hub for subagent-originated notices.
 *
 * Sources: the per-session `report` MCP tool (children append JSONL to the
 * mailbox file; an fs.watch drains it) and bridge-side events (turn_end,
 * permission_request) delivered directly.
 *
 * Sink: an in-memory inbox that tool results piggyback (`inbox` field) so
 * nothing is silently lost. Push-style delivery is intentionally left to
 * each harness — the bridge only guarantees the generic inbox path.
 */
export class NotifyHub {
  readonly mailboxPath: string;
  private onEntry?: (e: MailEntry) => void;
  private onLog?: (line: string) => void;
  private inbox: MailEntry[] = [];
  private offset = 0;
  private remainder = "";
  private watcher?: FSWatcher;
  private drainTimer?: NodeJS.Timeout;

  constructor(opts: NotifyOptions) {
    this.mailboxPath = opts.mailboxPath;
    this.onEntry = opts.onEntry;
    this.onLog = opts.onLog;

    // The mailbox must exist before it can be watched.
    try {
      mkdirSync(path.dirname(this.mailboxPath), { recursive: true });
      if (!existsSync(this.mailboxPath)) writeFileSync(this.mailboxPath, "");
      this.watcher = watch(this.mailboxPath, () => this.scheduleDrain());
    } catch (e) {
      this.log(
        `notify: cannot watch ${this.mailboxPath}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private log(line: string): void {
    this.onLog?.(line);
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drainMailbox();
    }, 50);
  }

  /**
   * Consume new mailbox bytes since the last drain. Partial trailing
   * lines are kept for the next pass; a fully-consumed oversized file is
   * truncated. Called by fs.watch and opportunistically on tool calls.
   */
  drainMailbox(): void {
    let st;
    try {
      st = statSync(this.mailboxPath);
    } catch {
      return;
    }
    if (st.size < this.offset) this.offset = 0; // truncated externally
    if (st.size === this.offset) return;
    const fd = openSync(this.mailboxPath, "r");
    let buf: Buffer;
    try {
      buf = Buffer.alloc(st.size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = st.size;
    const chunk = this.remainder + buf.toString("utf8");
    const lines = chunk.split("\n");
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as MailEntry;
        this.onEntry?.(e);
        this.deliver(e);
      } catch {
        /* malformed line — skip */
      }
    }
    if (!this.remainder && st.size > MAILBOX_ROTATE) {
      try {
        writeFileSync(this.mailboxPath, "");
        this.offset = 0;
      } catch {
        /* leave it; next drain retries */
      }
    }
  }

  /** Route one notice into the inbox (the only sink). */
  deliver(e: MailEntry): void {
    if (!e || typeof e.text !== "string" || !e.text) return;
    this.inbox.push(e);
    if (this.inbox.length > INBOX_CAP) {
      this.inbox.splice(0, this.inbox.length - INBOX_CAP);
    }
  }

  /** Pending notices; consumes them for piggyback on tool results. */
  drainInbox(): MailEntry[] {
    this.drainMailbox();
    return this.inbox.splice(0);
  }

  close(): void {
    this.watcher?.close();
    if (this.drainTimer) clearTimeout(this.drainTimer);
  }
}
