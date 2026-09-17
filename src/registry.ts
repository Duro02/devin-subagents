import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { Json, PermissionRequest } from "./acp.js";
import {
  createObservation,
  recordObservation,
  type Observation,
} from "./observe.js";

export type SubStatus =
  | "starting" // claimed name, session/new (or session/load) in flight
  | "running" // a prompt turn is in flight (or queued turns remain)
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
  sessionId: string; // "" while status === "starting"
  cwd: string;
  status: SubStatus;
  createdAt: string;
  events: BufferedEvent[];
  head: number; // seq of the newest event (cursor for incremental poll)
  readCursor: number; // seq consumed by the last poll
  lastStopReason?: string;
  /** persistent inspect snapshot state — survives drains and eviction */
  obs: Observation;
  turnSeq: number; // total turns started (1-based turn ids)
  activeTurn: number; // turn id currently in flight, 0 = none
  queue: string[]; // FIFO of prompt texts waiting for the active turn
  availableModes?: string[];
  currentMode?: string;
  availableModels?: string[];
  currentModel?: string;
  /** a set_mode/set_model RPC is in flight — prompts must not start */
  configuring: boolean;
  pendingPermission?: {
    requestId: number | string;
    toolCall: Json;
    options: { optionId: string; name: string; kind: string }[];
  };
  /**
   * report() events awaiting delivery to a wait() call, oldest first.
   * Kept separately from `events` so delivery is independent of ring-buffer
   * eviction and of any caller's read cursor. Entries with
   * seq <= reportDeliveredSeq are already consumed; the array is bounded
   * (delivered entries are dropped first when trimming).
   */
  reportLog: { seq: number; data: Json }[];
  /** highest report seq already returned by a wait() call */
  reportDeliveredSeq: number;
  waiters: Set<() => void>; // waiting poll callers to wake on change
}

/** cap on buffered report() notices pending delivery to wait() */
const REPORT_LOG_CAP = 64;

interface StateFile {
  sessions: Record<
    string,
    { sessionId: string; cwd: string; mode?: string; model?: string }
  >;
}

export interface RegistryOptions {
  bufferCap?: number;
  onLog?: (line: string) => void;
}

export class Registry {
  private sessions = new Map<string, SubSession>();
  private bufferCap: number;
  private onLog?: (line: string) => void;

  constructor(private statePath: string, opts: RegistryOptions = {}) {
    const cap = opts.bufferCap ?? 500;
    this.bufferCap = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 500;
    this.onLog = opts.onLog;
  }

  /** sessions persisted by earlier bridge runs, for `resume`. */
  persisted(): Record<
    string,
    { sessionId: string; cwd: string; mode?: string; model?: string }
  > {
    try {
      if (!existsSync(this.statePath)) return {};
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as StateFile;
      return raw.sessions ?? {};
    } catch (e) {
      this.onLog?.(
        `state: cannot read ${this.statePath}: ${e instanceof Error ? e.message : e}`,
      );
      return {};
    }
  }

  get(name: string): SubSession | undefined {
    return this.sessions.get(name);
  }

  names(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Synchronously reserve a name before any await, so two concurrent
   * spawn/resume calls can never both win it.
   */
  claim(name: string): SubSession {
    if (this.sessions.has(name)) {
      throw new Error(`subagent "${name}" already exists`);
    }
    const s: SubSession = {
      name,
      sessionId: "",
      cwd: "",
      status: "starting",
      createdAt: new Date().toISOString(),
      events: [],
      head: 0,
      readCursor: 0,
      obs: createObservation(),
      turnSeq: 0,
      activeTurn: 0,
      queue: [],
      configuring: false,
      reportLog: [],
      reportDeliveredSeq: 0,
      waiters: new Set(),
    };
    this.sessions.set(name, s);
    return s;
  }

  /** Fill in a claimed session once session/new|load returned. */
  activate(name: string, sessionId: string, cwd: string): SubSession {
    const s = this.sessions.get(name);
    if (!s) throw new Error(`subagent "${name}" was released`);
    s.sessionId = sessionId;
    s.cwd = cwd;
    s.status = "idle";
    this.persist();
    return s;
  }

  /**
   * Drop a claimed/registered session (spawn or resume failed).
   * `forget` also removes the name from the persisted state file — used
   * when a half-created session should not linger as resumable.
   */
  release(name: string, forget = false): void {
    const s = this.sessions.get(name);
    if (s) {
      for (const w of s.waiters) w();
      this.sessions.delete(name);
    }
    if (forget) this.persist(new Set([name]));
  }

  mark(name: string, status: SubStatus, stopReason?: string): void {
    const s = this.sessions.get(name);
    if (!s) return;
    s.status = status;
    if (stopReason !== undefined) s.lastStopReason = stopReason;
    for (const w of s.waiters) w();
  }

  markAllDead(code?: number | null): void {
    for (const s of this.sessions.values()) {
      if (s.status === "dead") continue;
      const droppedQueue = s.queue.length;
      s.status = "dead";
      s.activeTurn = 0;
      s.queue = [];
      s.pendingPermission = undefined;
      this.append(s.name, "agent_exit", { code, droppedQueue });
      for (const w of s.waiters) w();
    }
  }

  append(name: string, kind: string, data: Json): void {
    const s = this.sessions.get(name);
    if (!s) return;
    const at = new Date().toISOString();
    s.head += 1;
    s.events.push({ seq: s.head, at, kind, data });
    if (s.events.length > this.bufferCap) {
      s.events.splice(0, s.events.length - this.bufferCap);
    }
    if (kind === "report") {
      s.reportLog.push({ seq: s.head, data });
      if (s.reportLog.length > REPORT_LOG_CAP) {
        let excess = s.reportLog.length - REPORT_LOG_CAP;
        // drop already-delivered entries first; then, if still over, the
        // oldest undelivered ones (their data is still in `events` anyway)
        s.reportLog = s.reportLog.filter((r) => {
          if (excess > 0 && r.seq <= s.reportDeliveredSeq) {
            excess--;
            return false;
          }
          return true;
        });
        if (excess > 0) s.reportLog.splice(0, excess);
      }
    }
    // the inspect snapshot tracks every event — it must not depend on the
    // ring buffer (eviction) or on any caller's read cursor (consumption)
    recordObservation(s.obs, kind, data, at, s);
    for (const w of s.waiters) w();
  }

  setPermission(name: string, req: PermissionRequest): void {
    const s = this.sessions.get(name);
    if (!s) return;
    s.pendingPermission = {
      requestId: req.requestId,
      toolCall: req.toolCall,
      options: req.options,
    };
    for (const w of s.waiters) w();
  }

  clearPermission(name: string): void {
    const s = this.sessions.get(name);
    if (s) s.pendingPermission = undefined;
  }

  /**
   * Events with seq > since (or since the last logs poll when since is
   * omitted), capped at `limit` raw events when given.
   * An explicit `since` is a replay and does NOT move the stored read
   * cursor; a cursor-less poll advances readCursor only to `nextCursor`
   * (the last event actually returned), so a bounded page never silently
   * skips unconsumed records.
   * `dropped` = events the caller asked for that were evicted from the ring
   * buffer: seqs in (from, oldest).
   */
  drain(
    name: string,
    opts: { since?: number; limit?: number } = {},
  ):
    | {
        events: BufferedEvent[];
        cursor: number;
        nextCursor: number;
        hasMore: boolean;
        dropped: number;
      }
    | undefined {
    const s = this.sessions.get(name);
    if (!s) return undefined;
    const { since, limit } = opts;
    const from = since ?? s.readCursor;
    let events = s.events.filter((e) => e.seq > from);
    if (limit !== undefined && events.length > limit) {
      events = events.slice(0, limit);
    }
    const nextCursor = events.length ? events[events.length - 1].seq : from;
    const hasMore =
      s.events.length > 0 && s.events[s.events.length - 1].seq > nextCursor;
    if (since === undefined) s.readCursor = nextCursor;
    const oldest = s.events.length ? s.events[0].seq : s.head + 1;
    const dropped = Math.max(0, oldest - 1 - from);
    return { events, cursor: s.head, nextCursor, hasMore, dropped };
  }

  /**
   * Wait until a new event arrives for `name` or `ms` elapses.
   * Any number of polls may wait concurrently; each is woken independently.
   * An optional AbortSignal ends the wait early (resolves false) — it only
   * abandons this waiter, never the session or the turn behind it.
   * Resolves false on timeout/abort, true if woken by an event.
   */
  waitForEvent(
    name: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const s = this.sessions.get(name);
    if (!s || ms <= 0 || signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const settle = (woken: boolean) => {
        clearTimeout(timer);
        s.waiters.delete(cb);
        signal?.removeEventListener("abort", onAbort);
        resolve(woken);
      };
      const cb = () => settle(true);
      const onAbort = () => settle(false);
      const timer = setTimeout(() => settle(false), ms);
      s.waiters.add(cb);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  persist(except?: Set<string>): void {
    const sessions: StateFile["sessions"] = {};
    for (const s of this.sessions.values()) {
      // mode/model ride along so a cross-bridge resume can re-assert the
      // session's own selection instead of the bridge's defaults.
      if (s.sessionId) {
        sessions[s.name] = {
          sessionId: s.sessionId,
          cwd: s.cwd,
          ...(s.currentMode ? { mode: s.currentMode } : {}),
          ...(s.currentModel ? { model: s.currentModel } : {}),
        };
      }
    }
    // merge in sessions known from earlier runs but not loaded this time
    for (const [name, v] of Object.entries(this.persisted())) {
      if (!except?.has(name)) sessions[name] ??= v;
    }
    const tmp = this.statePath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
      renameSync(tmp, this.statePath);
    } catch (e) {
      this.onLog?.(
        `state: cannot write ${this.statePath}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}
