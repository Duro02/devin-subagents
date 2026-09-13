import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
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
  /** small JSON file persisting the registered codex thread */
  notifyPath: string;
  /** codex binary for `codex queue` delivery */
  codexCommand: string;
  /** seed thread from config (static setups) */
  thread?: string;
  onLog?: (line: string) => void;
}

const INBOX_CAP = 100;
const MSG_CAP = 1800;
const MAILBOX_ROTATE = 1_000_000;
/** after a queue failure, hold off retrying for this long */
const QUEUE_RETRY_MS = 60_000;

/**
 * Delivery hub for subagent-originated notices.
 *
 * Sources: the per-session `report` MCP tool (children append JSONL to the
 * mailbox file; an fs.watch drains it) and bridge-side events (turn_end,
 * permission_request) delivered directly.
 *
 * Sink order: when a codex thread is registered (`notify` tool or config),
 * each entry is pushed via `codex queue --thread <t> --message <m>` — the
 * message lands in the parent session as a queued user message. Without a
 * thread, or when queue delivery fails, entries pile into an inbox that
 * tool results piggyback (`inbox` field) so nothing is silently lost.
 */
export class NotifyHub {
  readonly mailboxPath: string;
  private notifyPath: string;
  private codexCommand: string;
  private onLog?: (line: string) => void;
  private thread?: string;
  private inbox: MailEntry[] = [];
  private delivered = 0;
  private offset = 0;
  private remainder = "";
  private watcher?: FSWatcher;
  private drainTimer?: NodeJS.Timeout;
  private queueRetryAt = 0;
  private logged = new Set<string>();

  constructor(opts: NotifyOptions) {
    this.mailboxPath = opts.mailboxPath;
    this.notifyPath = opts.notifyPath;
    this.codexCommand = opts.codexCommand;
    this.onLog = opts.onLog;
    this.thread = opts.thread ?? this.loadThread();

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

  private loadThread(): string | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.notifyPath, "utf8")) as {
        thread?: unknown;
      };
      return typeof raw.thread === "string" && raw.thread.trim()
        ? raw.thread
        : undefined;
    } catch {
      return undefined;
    }
  }

  private persistThread(): void {
    const tmp = this.notifyPath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify({ thread: this.thread ?? null }));
      renameSync(tmp, this.notifyPath);
    } catch (e) {
      this.log(`notify: cannot write ${this.notifyPath}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private log(line: string): void {
    this.onLog?.(line);
  }

  /** Log each distinct failure once — a broken queue must not spam stderr. */
  private logOnce(line: string): void {
    const key = line.slice(0, 80);
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(line);
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
        this.deliver(JSON.parse(line) as MailEntry);
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

  /**
   * Route one notice. Queue delivery is fire-and-forget: a failed spawn
   * or non-zero exit re-files the entry into the inbox so it still
   * reaches the agent via piggyback.
   */
  deliver(e: MailEntry): void {
    if (!e || typeof e.text !== "string" || !e.text) return;
    if (!this.thread || Date.now() < this.queueRetryAt) {
      this.pushInbox(e);
      return;
    }
    const text = `[devin-subagents] ${e.name}: ${e.text}`.slice(0, MSG_CAP);
    let p;
    try {
      p = spawn(
        this.codexCommand,
        ["queue", "--thread", this.thread, "--message", text],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (err) {
      this.failQueue(e, `codex queue spawn: ${err instanceof Error ? err.message : err}`);
      return;
    }
    let errBuf = "";
    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      this.failQueue(e, msg);
    };
    p.stderr?.on("data", (d) => (errBuf += d));
    p.on("error", (err) => fail(`codex queue spawn: ${err.message}`));
    p.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        this.delivered++;
      } else {
        this.failQueue(
          e,
          `codex queue exited ${code}: ${errBuf.trim().slice(0, 200)}`,
        );
      }
    });
  }

  private failQueue(e: MailEntry, msg: string): void {
    this.logOnce(`notify: ${msg}`);
    this.queueRetryAt = Date.now() + QUEUE_RETRY_MS;
    this.pushInbox(e);
  }

  private pushInbox(e: MailEntry): void {
    this.inbox.push(e);
    if (this.inbox.length > INBOX_CAP) {
      this.inbox.splice(0, this.inbox.length - INBOX_CAP);
    }
  }

  /** Entries not (yet) delivered via queue; consumes them for piggyback. */
  drainInbox(): MailEntry[] {
    this.drainMailbox();
    return this.inbox.splice(0);
  }

  register(thread: string): Record<string, unknown> {
    const t = thread.trim();
    if (!t) throw new Error("thread must be a non-empty string");
    this.thread = t;
    this.queueRetryAt = 0;
    this.persistThread();
    // A thread just arrived: push anything that piled up in the inbox.
    for (const e of this.inbox.splice(0)) this.deliver(e);
    this.drainMailbox();
    return this.status();
  }

  unregister(): Record<string, unknown> {
    this.thread = undefined;
    this.persistThread();
    return this.status();
  }

  status(): Record<string, unknown> {
    return {
      thread: this.thread ?? null,
      delivered: this.delivered,
      inbox: this.inbox.length,
      mailbox: this.mailboxPath,
    };
  }

  close(): void {
    this.watcher?.close();
    if (this.drainTimer) clearTimeout(this.drainTimer);
  }
}
