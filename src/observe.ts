import type { Json } from "./acp.js";
import { textOf, toolInput, toolOutput } from "./project.js";

/**
 * Persistent per-session observation state behind poll's `detail:"inspect"`.
 *
 * Maintained incrementally on every buffered event (agent session/update
 * notifications AND bridge-local lifecycle records), so the snapshot is
 * independent of log reads and of ring-buffer eviction — unlike the event
 * log, nothing here is consumed or lost when events drain or age out.
 *
 * All timestamps are bridge-side receipt times (when the bridge observed
 * the event), not agent-reported times. Prior-turn data is kept but
 * annotated with its `turn` number rather than silently cleared, except
 * `latestText`, which is per-turn accumulated agent text and resets on
 * turn_start.
 */

export interface ToolObs {
  id: string;
  turn: number;
  title?: string;
  kind?: string;
  /** concise rendering of rawInput/input */
  input?: string;
  status: string;
  /** bridge receipt time of the first tool_call(_update) for this id */
  startedAt: string;
  /** bridge receipt time of the latest update for this id */
  updatedAt: string;
  /**
   * Set when the owning turn ended (or was interrupted/stopped/lost to an
   * agent exit) while the tool was still open — the tool never reported a
   * terminal status, so it is annotated rather than left "running".
   */
  endedWithTurn?: number;
}

export interface Observation {
  /** last actual agent output: message/thinking text or tool/plan reference */
  lastOutput?: {
    type: string;
    text?: string;
    id?: string;
    title?: string;
    at: string;
    turn: number;
  };
  /** current/latest turn's accumulated agent_message text (bounded tail) */
  latestText?: { text: string; at: string; turn: number };
  /**
   * same accumulation as latestText but kept to TURN_TEXT — the turn's
   * "deliverable" text, surfaced on wait()'s done result. Resets on
   * turn_start like latestText.
   */
  turnText?: { text: string; truncated: boolean; at: string; turn: number };
  lastError?: { message: string; at: string; turn: number };
  /** latest plan update's entries, kept whole for current-step lookup */
  plan?: { entries: Json[]; at: string; turn: number };
  /**
   * Tool calls merged by toolCallId: all open tools, plus up to
   * CLOSED_TOOLS_CAP closed records retained so a reused id on a later
   * turn is detected and reset. Log metadata lives on the stamped events
   * themselves — this map is never consulted at read time.
   */
  tools: Map<string, ToolObs>;
  /** the turn these times describe (latest turn_start / turn_end seen) */
  turnN: number;
  turnStartedAt?: string;
  turnEndedAt?: string;
  turnStopReason?: string;
  /** last agent-originated signal (any session/update, turn_end, agent_exit, permission_request) */
  lastActivityAt?: string;
  /** last actual-output update: message, thinking, tool_call(_update), plan */
  lastContentAt?: string;
}

/**
 * Bridge-local bookkeeping kinds: not agent activity. Everything else —
 * every session/update kind plus turn_end, agent_exit, permission_request —
 * originates from the agent and refreshes lastActivityAt.
 */
const LOCAL_KINDS = new Set([
  "turn_start",
  "queued",
  "interrupt",
  "stopped",
  "resumed",
  "permission_auto",
  "permission_granted",
  "permission_denied",
  "permission_answered",
  "permission_superseded",
  "model",
  "mode_skipped",
  "model_skipped",
  "mode_failed",
  "model_failed",
]);

/** Actual output: message/thinking text, tool lifecycle, plan. */
const CONTENT_KINDS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** statuses that keep a tool on the active list */
const OPEN_STATUS = new Set(["in_progress", "pending"]);

const isOpenTool = (t: ToolObs): boolean =>
  OPEN_STATUS.has(t.status) && t.endedWithTurn === undefined;

/**
 * Bound on *closed* tool records kept per session (retained only to detect
 * toolCallId reuse across turns). Open tools are never evicted — a flood of
 * completed ids must not drop a live call from the active list.
 */
const CLOSED_TOOLS_CAP = 256;
const OUTPUT_TEXT = 300;
const ERROR_TEXT = 500;
const LATEST_TEXT = 4000;
/** per-turn deliverable text kept for wait()'s done output */
const TURN_TEXT = 64_000;

const tail = (s: string, n: number) =>
  s.length > n ? `…${s.slice(-n)}` : s;

export function createObservation(): Observation {
  return { tools: new Map(), turnN: 0 };
}

function toolRecord(
  obs: Observation,
  id: string,
  at: string,
  turn: number,
): ToolObs {
  let t = obs.tools.get(id);
  if (t && turn > t.turn) {
    // toolCallId reused by a later turn: reset the lifecycle fields so the
    // call counts as active again (status/timing/endedWithTurn from the old
    // turn must not hide it). Clear `input` — arguments belong to the old
    // invocation and must not be stamped onto the new turn's events;
    // title/kind stay as a fallback until the new event overwrites them.
    t.turn = turn;
    t.startedAt = at;
    t.status = "in_progress";
    t.endedWithTurn = undefined;
    t.input = undefined;
  }
  if (!t) {
    t = { id, turn, status: "in_progress", startedAt: at, updatedAt: at };
    obs.tools.set(id, t);
  }
  return t;
}

/**
 * Drop the oldest *closed* tool records until at most CLOSED_TOOLS_CAP
 * remain. Open tools are never evicted. Map iteration is insertion-ordered,
 * so the first closed ids encountered are the oldest.
 */
function evictClosedTools(obs: Observation): void {
  let closed = 0;
  for (const t of obs.tools.values()) if (!isOpenTool(t)) closed++;
  let drop = closed - CLOSED_TOOLS_CAP;
  if (drop <= 0) return;
  for (const [k, v] of obs.tools) {
    if (drop <= 0) break;
    if (!isOpenTool(v)) {
      obs.tools.delete(k);
      drop--;
    }
  }
}

/**
 * Annotate still-open tools so an ended turn leaves no stale "running"
 * rows. Only tools from turns <= `uptoTurn` are touched — a late/superseded
 * settlement must never retire a newer turn's live tools.
 */
function closeOpenTools(obs: Observation, uptoTurn: number): void {
  for (const t of obs.tools.values()) {
    if (
      OPEN_STATUS.has(t.status) &&
      t.endedWithTurn === undefined &&
      t.turn <= uptoTurn
    ) {
      t.endedWithTurn = uptoTurn;
    }
  }
  evictClosedTools(obs);
}

/**
 * Fold one buffered event into the observation. `ctx` carries the session's
 * turn counters; turn_start/turn_end use their own `data.turn` so a late or
 * superseded settlement can never misattribute times.
 */
export function recordObservation(
  obs: Observation,
  kind: string,
  data: Json,
  at: string,
  ctx: { activeTurn: number; turnSeq: number },
): void {
  const curTurn = ctx.activeTurn || ctx.turnSeq;
  if (!LOCAL_KINDS.has(kind)) obs.lastActivityAt = at;
  if (CONTENT_KINDS.has(kind)) obs.lastContentAt = at;

  switch (kind) {
    case "agent_message_chunk": {
      const text = textOf(data);
      obs.lastOutput = { type: "message", text: tail(text, OUTPUT_TEXT), at, turn: curTurn };
      const prev = obs.latestText;
      obs.latestText =
        prev && prev.turn === curTurn
          ? { text: tail(prev.text + text, LATEST_TEXT), at, turn: curTurn }
          : { text: tail(text, LATEST_TEXT), at, turn: curTurn };
      const tp = obs.turnText;
      const joined = tp && tp.turn === curTurn ? tp.text + text : text;
      obs.turnText = {
        text: tail(joined, TURN_TEXT),
        truncated: (tp?.truncated ?? false) || joined.length > TURN_TEXT,
        at,
        turn: curTurn,
      };
      break;
    }
    case "agent_thought_chunk":
      obs.lastOutput = { type: "thinking", text: tail(textOf(data), OUTPUT_TEXT), at, turn: curTurn };
      break;
    case "tool_call":
    case "tool_call_update": {
      const id = String(data.toolCallId ?? "");
      if (!id) break;
      const t = toolRecord(obs, id, at, curTurn);
      if (data.title !== undefined) t.title = String(data.title);
      if (data.kind !== undefined) t.kind = String(data.kind);
      const input = toolInput(data);
      if (input !== undefined) t.input = tail(input, OUTPUT_TEXT);
      if (data.status !== undefined) t.status = String(data.status);
      t.updatedAt = at;
      // Stamp resolved metadata onto the buffered event itself: replays of
      // this event must show what was known at ingest time — a later
      // completion or a reused toolCallId must not relabel old log entries.
      if (data.title === undefined && t.title !== undefined) {
        data.title = t.title;
      }
      if (data.kind === undefined && t.kind !== undefined) data.kind = t.kind;
      if (data.status === undefined) data.status = t.status;
      if (toolInput(data) === undefined && t.input !== undefined) {
        data.input = t.input;
      }
      evictClosedTools(obs);
      obs.lastOutput = { type: "tool", id, title: t.title, at, turn: t.turn };
      if (t.status === "failed") {
        const detail =
          toolOutput(data) ??
          (typeof data.error === "string" ? data.error : undefined);
        obs.lastError = {
          message: tail(
            `tool failed: ${t.title ?? id}${detail ? ` — ${detail}` : ""}`,
            ERROR_TEXT,
          ),
          at,
          turn: t.turn,
        };
      }
      break;
    }
    case "plan": {
      const entries = Array.isArray(data.entries) ? (data.entries as Json[]) : [];
      obs.plan = { entries, at, turn: curTurn };
      const cur = entries.find((e) => e?.status === "in_progress");
      obs.lastOutput = {
        type: "plan",
        text: cur ? String(cur.content ?? "") : `${entries.length} entries`,
        at,
        turn: curTurn,
      };
      break;
    }
    case "turn_start": {
      obs.turnN = Number(data.turn ?? ctx.turnSeq);
      obs.turnStartedAt = at;
      obs.turnEndedAt = undefined;
      obs.turnStopReason = undefined;
      obs.latestText = undefined; // per-turn accumulated text
      obs.turnText = undefined;
      break;
    }
    case "turn_end": {
      const turn = Number(data.turn ?? ctx.turnSeq);
      // a stale/superseded settlement must not clobber a newer turn's times
      if (turn >= obs.turnN) {
        obs.turnN = turn;
        // first terminal signal freezes the duration: an agent_exit that
        // already closed the turn keeps its earlier (death-time) endedAt.
        obs.turnEndedAt ??= at;
        obs.turnStopReason = String(data.stopReason ?? "");
      }
      if (data.error !== undefined) {
        obs.lastError = { message: String(data.error), at, turn };
      } else if (data.stopReason === "error") {
        obs.lastError = { message: "turn ended with error", at, turn };
      }
      closeOpenTools(obs, turn);
      break;
    }
    case "interrupt":
    case "stopped":
      closeOpenTools(obs, ctx.turnSeq);
      break;
    case "agent_exit":
      closeOpenTools(obs, ctx.turnSeq);
      // freeze a still-open turn at the death time — the duration must not
      // keep growing on a dead session (a turn_end may settle later or never)
      if (obs.turnStartedAt !== undefined && obs.turnEndedAt === undefined) {
        obs.turnEndedAt = at;
      }
      obs.lastError = {
        message: `agent process exited (code ${String(data.code ?? "unknown")})`,
        at,
        turn: ctx.turnSeq,
      };
      break;
    case "mode_failed":
    case "model_failed":
      if (data.error !== undefined) {
        obs.lastError = {
          message: `${kind}: ${String(data.error)}`,
          at,
          turn: ctx.turnSeq,
        };
      }
      break;
  }
}

const elapsedMs = (at: string, now: number) =>
  Math.max(0, now - Date.parse(at));

/**
 * Render the inspect snapshot. `elapsedMs`/`durationMs` are computed against
 * `now` so a running turn/tool reports its duration-so-far; ended rows keep
 * their final duration.
 */
export function buildSnapshot(obs: Observation, now: number): Json {
  const turn =
    obs.turnStartedAt !== undefined || obs.turnEndedAt !== undefined
      ? {
          n: obs.turnN,
          startedAt: obs.turnStartedAt ?? null,
          endedAt: obs.turnEndedAt ?? null,
          durationMs: obs.turnStartedAt
            ? (obs.turnEndedAt ? Date.parse(obs.turnEndedAt) : now) -
              Date.parse(obs.turnStartedAt)
            : null,
          stopReason: obs.turnStopReason ?? null,
        }
      : null;

  const activeTools = [...obs.tools.values()]
    .filter((t) => OPEN_STATUS.has(t.status) && t.endedWithTurn === undefined)
    .map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      input: t.input,
      status: t.status,
      turn: t.turn,
      startedAt: t.startedAt,
      updatedAt: t.updatedAt,
      elapsedMs: elapsedMs(t.startedAt, now),
    }));

  let currentPlanStep: Json | null = null;
  if (obs.plan) {
    const idx = obs.plan.entries.findIndex((e) => e?.status === "in_progress");
    if (idx >= 0) {
      const e = obs.plan.entries[idx];
      currentPlanStep = {
        content: e.content,
        status: e.status,
        priority: e.priority,
        index: idx + 1,
        total: obs.plan.entries.length,
        at: obs.plan.at,
        turn: obs.plan.turn,
      };
    }
  }

  return {
    turn,
    lastOutput: obs.lastOutput ?? null,
    latestText: obs.latestText ?? null,
    activeTools,
    currentPlanStep,
    lastError: obs.lastError ?? null,
    lastActivity: obs.lastActivityAt
      ? { at: obs.lastActivityAt, elapsedMs: elapsedMs(obs.lastActivityAt, now) }
      : null,
    lastContent: obs.lastContentAt
      ? { at: obs.lastContentAt, elapsedMs: elapsedMs(obs.lastContentAt, now) }
      : null,
  };
}
