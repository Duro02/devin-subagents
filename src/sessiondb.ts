import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Best-effort writer for the devin session DB's `hidden` flag.
 *
 * `devin acp` persists every session into
 * `<data-dir>/devin/cli/sessions.db`; interactive session pickers
 * (`/resume`, `devin list`) and the agent-side `session/list` all filter
 * on `sessions.hidden = 0`. Devin only sets the flag for its own internal
 * sessions (e.g. summarizers) — `session/new` exposes no switch — so the
 * bridge flips it directly for sessions it manages. The write is a short
 * UPDATE on a WAL-mode database devin also holds open; `busy_timeout`
 * covers the rare contention.
 *
 * Session rows are created lazily (first prompt persistence), so callers
 * re-offer ids until `markHidden` reports them applied. Every failure —
 * missing file, missing column (pre-V15 schema), missing `node:sqlite`
 * (Node < 22.5), locked/corrupt DB — disables the feature for the life of
 * the process after one log line; hiding is never load-bearing.
 */
export class SessionDb {
  private db?: import("node:sqlite").DatabaseSync;
  /** permanently disabled after a hard failure (never retry) */
  private broken = false;
  private loggedMissing = false;

  constructor(
    private dbPath: string,
    private onLog?: (line: string) => void,
  ) {}

  /** devin's session DB location for this platform. */
  static defaultPath(): string {
    const home = homedir();
    const base =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : process.platform === "win32"
          ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))
          : (process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"));
    return path.join(base, "devin", "cli", "sessions.db");
  }

  /**
   * Flip `hidden` to 1 for the given session ids.
   * Returns the subset now confirmed hidden (whether flipped by this call
   * or already hidden); ids without a row yet stay unconfirmed so the
   * caller retries later.
   */
  markHidden(ids: string[]): string[] {
    const db = this.open();
    if (!db || ids.length === 0) return [];
    try {
      const upd = db.prepare(
        "UPDATE sessions SET hidden = 1 WHERE id = ? AND hidden = 0",
      );
      const chk = db.prepare(
        "SELECT 1 AS ok FROM sessions WHERE id = ? AND hidden = 1",
      );
      const done: string[] = [];
      for (const id of ids) {
        upd.run(id);
        if (chk.get(id)) done.push(id);
      }
      return done;
    } catch (e) {
      // SQLITE_BUSY / SQLITE_LOCKED mean devin held the write lock this
      // instant — transient, so stay enabled and retry on the next flush.
      const code = (e as { errcode?: number }).errcode;
      if (code === 5 || code === 6) return [];
      this.disable(`update failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = undefined;
  }

  private open(): import("node:sqlite").DatabaseSync | undefined {
    if (this.broken) return undefined;
    if (this.db) return this.db;
    // Opening a missing path would create an empty sessions.db in devin's
    // data dir — never do that. Absence is retriable: the file appears
    // once devin first persists a session, so don't mark broken.
    if (!existsSync(this.dbPath)) {
      if (!this.loggedMissing) {
        this.loggedMissing = true;
        this.onLog?.(`sessiondb: ${this.dbPath} not found; hiding idle`);
      }
      return undefined;
    }
    try {
      const req = createRequire(import.meta.url);
      const { DatabaseSync } = req("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(this.dbPath);
      db.exec("PRAGMA busy_timeout = 2000");
      // `hidden` was introduced by schema migration V15; older devin
      // builds lack it — a missing column disables the feature cleanly.
      const has = db
        .prepare(
          "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'hidden'",
        )
        .get();
      if (!has) {
        db.close();
        throw new Error("sessions table has no `hidden` column");
      }
      this.db = db;
      return db;
    } catch (e) {
      this.disable(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }

  private disable(why: string): void {
    this.broken = true;
    this.close();
    this.onLog?.(`sessiondb: hiding disabled (${this.dbPath}: ${why})`);
  }
}
