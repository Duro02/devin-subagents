import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { Json, PermissionRequest } from "./acp.js";

export type SubStatus =
  | "running" // a prompt turn is in flight
  | "idle" // session exists, waiting between turns
  | "stopped" // interrupted or finished, kept for resume
  | "dead"; // agent process exited; resumable via session/load

export interface BufferedEvent {
  seq: number;
  at: string;
  kind: string;
  data: Json;
}

export interface SubSession {
  name: string;
  sessionId: string;
  cwd: string;
  status: SubStatus;
  createdAt: string;
  events: BufferedEvent[];
  head: number; // seq of the newest event (cursor for incremental poll)
  readCursor: number; // seq consumed by the last devin_poll
  lastStopReason?: string;
  pendingPermission?: {
    requestId: number | string;
    toolCall: Json;
    options: { optionId: string; name: string; kind: string }[];
  };
  notify?: () => void; // resolves a waiting devin_poll early
}

interface StateFile {
  sessions: Record<string, { sessionId: string; cwd: string }>;
}

const BUFFER_CAP = Number(process.env.DEVIN_SUBAGENT_BUFFER ?? 500);

export class Registry {
  private sessions = new Map<string, SubSession>();

  constructor(private statePath: string) {}

  /** sessionIds persisted by earlier bridge runs, for `devin_resume`. */
  persisted(): Record<string, { sessionId: string; cwd: string }> {
    try {
      if (!existsSync(this.statePath)) return {};
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as StateFile;
      return raw.sessions ?? {};
    } catch {
      return {};
    }
  }

  get(name: string): SubSession | undefined {
    return this.sessions.get(name);
  }

  names(): string[] {
    return [...this.sessions.keys()];
  }

  register(name: string, sessionId: string, cwd: string): SubSession {
    const s: SubSession = {
      name,
      sessionId,
      cwd,
      status: "idle",
      createdAt: new Date().toISOString(),
      events: [],
      head: 0,
      readCursor: 0,
    };
    this.sessions.set(name, s);
    this.persist();
    return s;
  }

  /** Re-attach a persisted sessionId after a fresh session/load. */
  revive(name: string, sessionId: string, cwd: string): SubSession {
    const s = this.register(name, sessionId, cwd);
    s.status = "idle";
    return s;
  }

  mark(name: string, status: SubStatus, stopReason?: string): void {
    const s = this.sessions.get(name);
    if (!s) return;
    s.status = status;
    if (stopReason !== undefined) s.lastStopReason = stopReason;
  }

  markAllDead(): void {
    for (const s of this.sessions.values()) {
      if (s.status === "running" || s.status === "idle") s.status = "dead";
    }
  }

  append(name: string, kind: string, data: Json): void {
    const s = this.sessions.get(name);
    if (!s) return;
    s.head += 1;
    s.events.push({ seq: s.head, at: new Date().toISOString(), kind, data });
    if (s.events.length > BUFFER_CAP) {
      s.events.splice(0, s.events.length - BUFFER_CAP);
    }
    s.notify?.();
  }

  setPermission(name: string, req: PermissionRequest): void {
    const s = this.sessions.get(name);
    if (!s) return;
    s.pendingPermission = {
      requestId: req.requestId,
      toolCall: req.toolCall,
      options: req.options,
    };
    s.notify?.();
  }

  clearPermission(name: string): void {
    const s = this.sessions.get(name);
    if (s) s.pendingPermission = undefined;
  }

  /**
   * Events with seq > since (or since the last poll when since is omitted).
   * Also advances the read cursor.
   */
  drain(
    name: string,
    since?: number,
  ): { events: BufferedEvent[]; cursor: number; dropped: number } | undefined {
    const s = this.sessions.get(name);
    if (!s) return undefined;
    const from = since ?? s.readCursor;
    const events = s.events.filter((e) => e.seq > from);
    s.readCursor = s.head;
    const oldest = s.events[0]?.seq ?? 0;
    const dropped = Math.max(0, Math.min(from, oldest - 1));
    return { events, cursor: s.head, dropped };
  }

  /**
   * Wait until a new event arrives for `name` or `ms` elapses.
   * Resolves false on timeout, true if woken by an event.
   */
  waitForEvent(name: string, ms: number): Promise<boolean> {
    const s = this.sessions.get(name);
    if (!s || ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        s.notify = undefined;
        resolve(false);
      }, ms);
      s.notify = () => {
        clearTimeout(timer);
        s.notify = undefined;
        resolve(true);
      };
    });
  }

  persist(): void {
    const sessions: StateFile["sessions"] = {};
    for (const s of this.sessions.values()) {
      sessions[s.name] = { sessionId: s.sessionId, cwd: s.cwd };
    }
    // merge in sessions known from earlier runs but not loaded this time
    for (const [name, v] of Object.entries(this.persisted())) {
      sessions[name] ??= v;
    }
    const tmp = this.statePath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
      renameSync(tmp, this.statePath);
    } catch {
      /* state file is best-effort; resume also works via devin_list */
    }
  }
}
