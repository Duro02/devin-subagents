// Deterministic fake ACP agent used by tests. Speaks JSON-RPC 2.0 over
// stdio NDJSON, like `devin acp`. Behavior is driven by [[directives]]
// embedded in the prompt text and by env vars:
//
//   FAKE_ACP_INIT_DELAY=ms       delay the initialize response; with
//   FAKE_ACP_INIT_MARKER=<path>  only while the marker file exists (removed
//                                on use — simulates a one-shot slow start)
//   FAKE_ACP_NEW_DELAY=ms        delay every session/new response
//   FAKE_ACP_HANG="session/list,initialize"  never answer these methods
//   FAKE_ACP_NO_CAPS=1           omit modes/models from session/new|load
//   FAKE_ACP_NO_SETMODE=1        session/set_mode -> -32601 (forces the
//                                bridge's set_config_option mode fallback)
//   FAKE_ACP_FORCE_MODEL=<id>    set_config_option model confirms a
//                                different currentValue (mismatch check)
//   FAKE_ACP_CFG_DELAY=ms        delay set_config_option responses
//   FAKE_ACP_CFG_NO_ECHO=1       set_config_option responds {} (no
//                                configOptions echo -> unconfirmed)
//
// Protocol notes: like real devin, there is NO session/set_model — model
// changes go through session/set_config_option {configId:"model"} and the
// response echoes configOptions with the confirmed currentValue.
//
// Prompt directives:
//   [[sleep:ms]]   wait before emitting output / resolving
//   [[hang]]       never resolve; only session/cancel ends the turn
//   [[perm]]       emit session/request_permission, wait for the answer
//   [[die]]        exit(3) shortly after a chunk (simulates a crash)
//   [[chunks:N]]   emit N agent_message_chunk updates
//   [[think]]      emit an agent_thought_chunk
//   [[tool]]       emit tool_call + tool_call_update with text content
//   [[activetool]] emit an in_progress tool_call (tc-live) at turn start,
//                  before any sleep/hang; it never completes inside the turn
//   [[toolupd]]    emit a title-less tool_call_update for tc-live late in
//                  the turn (title must be backfilled by the bridge)
//   [[tools]]      emit overlapping tools: tc-a + tc-b tool_calls at turn
//                  start; late in the turn a title-less tc-b update lands,
//                  then tc-a completes; tc-b is deliberately left open so
//                  turn end must annotate it off the active list
//   [[failtool]]   emit tool_call + tool_call_update status:"failed" with a
//                  rawOutput error payload late in the turn
//   [[reuse]]      emit tool_call for a fixed id "tc-re" with a per-session
//                  counter in title/rawInput (step 1, step 2, …) then
//                  complete it — exercises id reuse across turns
//   [[plan]]       emit a plan update
//   [[usage]]      emit usage_update x3 (one exact duplicate)
//   [[big]]        emit a large tool output (truncation check)
//   [[mode]]       emit a current_mode_update mid-turn
import { createInterface } from "node:readline";
import { existsSync, rmSync } from "node:fs";

const HANG = new Set((process.env.FAKE_ACP_HANG ?? "").split(",").filter(Boolean));
const NEW_DELAY = Number(process.env.FAKE_ACP_NEW_DELAY ?? 0);
const INIT_DELAY = Number(process.env.FAKE_ACP_INIT_DELAY ?? 0);
const INIT_MARKER = process.env.FAKE_ACP_INIT_MARKER;
const CANCEL_DELAY = Number(process.env.FAKE_ACP_CANCEL_DELAY ?? 0);
const NO_CAPS = process.env.FAKE_ACP_NO_CAPS === "1";
const NO_SETMODE = process.env.FAKE_ACP_NO_SETMODE === "1";
const FORCE_MODEL = process.env.FAKE_ACP_FORCE_MODEL;
const CFG_DELAY = Number(process.env.FAKE_ACP_CFG_DELAY ?? 0);
const CFG_NO_ECHO = process.env.FAKE_ACP_CFG_NO_ECHO === "1";

/** One-shot init delay: only while the marker file exists. */
function initDelay() {
  if (INIT_DELAY <= 0) return 0;
  if (!INIT_MARKER) return INIT_DELAY;
  try {
    if (existsSync(INIT_MARKER)) {
      rmSync(INIT_MARKER);
      return INIT_DELAY;
    }
  } catch {
    /* treat as absent */
  }
  return 0;
}

const MODES = [
  { id: "smart", name: "Smart" },
  { id: "bypass", name: "Bypass" },
];
const MODELS = [
  { id: "swe-2-medium", name: "SWE-2 Medium" },
  { id: "swe-2-high", name: "SWE-2 High" },
  { id: "swe-2-max", name: "SWE-2 Max" },
];

let nextSess = 0;
let nextReq = 0;
const sessions = new Map(); // sessionId -> { cwd, mode, model, turn }
const pendingPerm = new Map(); // reqId -> { sessionId, promptId }

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const respond = (id, result) => send({ jsonrpc: "2.0", id, result: result ?? {} });
const respondErr = (id, code, message) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const update = (sessionId, u) =>
  notify("session/update", { sessionId, update: u });
const say = (sessionId, text, kind = "agent_message_chunk") =>
  update(sessionId, { sessionUpdate: kind, content: { type: "text", text } });

/** select-style configOptions, like devin surfaces them. */
const configOptions = (s) => [
  {
    id: "model",
    category: "model",
    name: "Model",
    options: MODELS.map((m) => ({ value: m.id, name: m.name })),
    currentValue: s.model,
  },
  {
    id: "mode",
    category: "mode",
    name: "Mode",
    options: MODES.map((m) => ({ value: m.id, name: m.name })),
    currentValue: s.mode,
  },
];

const caps = (s) =>
  NO_CAPS
    ? {}
    : {
        modes: { availableModes: MODES, currentModeId: s.mode },
        models: { availableModels: MODELS, currentModelId: s.model },
        configOptions: configOptions(s),
      };

const hangs = (method) =>
  HANG.has(method) || HANG.has(method.split("/").pop() ?? "");

function finishTurn(sessionId, promptId, stopReason) {
  const s = sessions.get(sessionId);
  if (s?.turn?.promptId === promptId) s.turn = null;
  for (const [rid, p] of pendingPerm) {
    if (p.promptId === promptId) pendingPerm.delete(rid);
  }
  respond(promptId, { stopReason });
}

function emitChunks(sessionId, text) {
  const cm = /\[\[chunks:(\d+)\]\]/.exec(text);
  const n = cm ? Number(cm[1]) : 0;
  for (let i = 1; i <= n; i++) say(sessionId, `chunk${i} `);
}

function runTurn(sessionId, promptId, text) {
  const s = sessions.get(sessionId);
  const turn = (s.turn = {
    promptId,
    timer: undefined,
    cancel() {
      clearTimeout(this.timer);
      // session/cancel acknowledges asynchronously — the prompt RPC keeps
      // the session "busy" until the reply lands.
      setTimeout(
        () => finishTurn(sessionId, promptId, "cancelled"),
        CANCEL_DELAY,
      );
    },
  });

  // An in-flight tool call emitted at turn start — it stays open for the
  // whole turn (sleep/hang included) and never reports a terminal status.
  if (text.includes("[[activetool]]")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-live",
      title: "exec: sleep 30",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "sleep 30" },
    });
  }

  // Two overlapping tool calls opened at turn start — both observable as
  // active mid-turn; their updates land late via emitAndFinish.
  if (text.includes("[[tools]]")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-a",
      title: "exec: ls -la",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "ls -la" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-b",
      title: "read: f.ts",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "f.ts" },
    });
  }

  if (text.includes("[[die]]")) {
    say(sessionId, "dying now");
    setTimeout(() => process.exit(3), 20);
    return;
  }
  if (text.includes("[[perm]]")) {
    const rid = `perm-${++nextReq}`;
    pendingPerm.set(rid, { sessionId, promptId });
    send({
      jsonrpc: "2.0",
      id: rid,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "tc-perm",
          title: "Run dangerous command",
          kind: "execute",
          status: "pending",
        },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "deny_once" },
        ],
      },
    });
    return; // resolves when the permission response arrives (or cancel)
  }
  if (text.includes("[[hang]]")) {
    say(sessionId, "hanging until cancelled");
    emitChunks(sessionId, text); // chunk floods still fire while hanging
    return; // only session/cancel resolves it
  }
  const m = /\[\[sleep:(\d+)\]\]/.exec(text);
  turn.timer = setTimeout(
    () => emitAndFinish(sessionId, text, () => finishTurn(sessionId, promptId, "end_turn")),
    m ? Number(m[1]) : 5,
  );
}

function emitAndFinish(sessionId, text, finish) {
  emitChunks(sessionId, text);
  if (text.includes("[[think]]")) say(sessionId, "thinking…", "agent_thought_chunk");
  if (text.includes("[[tool]]")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-9",
      title: "exec: ls",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "ls" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-9",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "file1\nfile2" } },
      ],
      rawOutput: { stdout: "file1\nfile2", exitCode: 0 },
    });
  }
  if (text.includes("[[toolupd]]")) {
    // title-less update for the [[activetool]] call — emitted late in the
    // turn so it lands in a later poll batch than the original tool_call.
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-live",
      status: "in_progress",
      rawInput: { command: "sleep 30", verbose: true },
    });
  }
  if (text.includes("[[tools]]")) {
    // late updates for the two calls opened at turn start
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-b",
      status: "in_progress",
      rawInput: { path: "f.ts", offset: 0 },
      // no title: must be backfilled by id
    });
    // a progress update for tc-a with no title AND no status — ingest must
    // stamp the then-current in_progress state; a later replay must not
    // relabel it "completed" just because tc-a finished afterwards.
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-a",
      content: [
        { type: "content", content: { type: "text", text: "a-progress" } },
      ],
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-a",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a1\na2" } }],
    });
    // tc-b intentionally left in_progress — the bridge must annotate it
    // when the turn ends rather than leave it "running" forever.
  }
  if (text.includes("[[failtool]]")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-fail",
      title: "exec: false",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "false" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-fail",
      status: "failed",
      rawOutput: { stderr: "boom: exited 1", exitCode: 1 },
    });
  }
  if (text.includes("[[reuse]]")) {
    // the same toolCallId each turn with a different title/input — old log
    // entries must keep the title/input they were ingested with
    const s = sessions.get(sessionId);
    const n = (s.reuseN = (s.reuseN ?? 0) + 1);
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-re",
      title: `exec: step ${n}`,
      kind: "execute",
      status: "in_progress",
      rawInput: { step: n },
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-re",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: `done ${n}` } },
      ],
    });
  }
  if (text.includes("[[big]]")) {
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-big",
      status: "completed",
      rawOutput: { stdout: "x".repeat(6000) },
    });
  }
  if (text.includes("[[plan]]")) {
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [{ content: "do it", priority: "medium", status: "in_progress" }],
    });
  }
  if (text.includes("[[usage]]")) {
    const u = {
      sessionUpdate: "usage_update",
      used: 100,
      size: 200,
      _meta: {
        "cognition.ai/inputTokens": 60,
        "cognition.ai/outputTokens": 40,
      },
    };
    update(sessionId, u);
    update(sessionId, u); // exact duplicate -> deduped in projection
    update(sessionId, {
      sessionUpdate: "usage_update",
      used: 150,
      size: 200,
      _meta: {
        "cognition.ai/inputTokens": 90,
        "cognition.ai/outputTokens": 60,
      },
    });
  }
  if (text.includes("[[mode]]")) {
    update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: "bypass" });
  }
  const clean = text.replace(/\[\[[^\]]*\]\]/g, "").trim();
  say(sessionId, `fake reply: ${clean || "ok"}`);
  finish();
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Response to an agent->client request (permission answer).
  if (msg.method === undefined) {
    const p = msg.id !== undefined ? pendingPerm.get(msg.id) : undefined;
    if (p) {
      pendingPerm.delete(msg.id);
      const outcome = msg.result?.outcome?.outcome;
      say(
        p.sessionId,
        outcome === "selected"
          ? `permission granted: ${msg.result.outcome.optionId}`
          : "permission cancelled",
      );
      finishTurn(
        p.sessionId,
        p.promptId,
        outcome === "selected" ? "end_turn" : "cancelled",
      );
    }
    return;
  }

  // Client->agent notification.
  if (msg.id === undefined) {
    if (msg.method === "session/cancel") {
      sessions.get(msg.params?.sessionId)?.turn?.cancel();
    }
    return;
  }

  if (hangs(msg.method)) return; // wedge: never respond

  switch (msg.method) {
    case "initialize": {
      const delay = initDelay();
      setTimeout(
        () =>
          respond(msg.id, {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            authMethods: [],
          }),
        delay,
      );
      return;
    }
    case "session/new": {
      setTimeout(() => {
        const id = `sess-${++nextSess}`;
        sessions.set(id, {
          cwd: msg.params?.cwd ?? "",
          mode: "smart",
          model: "swe-2-max",
          turn: null,
        });
        respond(msg.id, { sessionId: id, ...caps(sessions.get(id)) });
      }, NEW_DELAY);
      return;
    }
    case "session/load": {
      const sessionId = String(msg.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) {
        // devin's session DB survives restarts: a well-formed id always loads.
        sessions.set(sessionId, {
          cwd: msg.params?.cwd ?? "",
          mode: "smart",
          model: "swe-2-max",
          turn: null,
        });
      }
      respond(msg.id, { sessionId, ...caps(sessions.get(sessionId)) });
      return;
    }
    case "session/list": {
      respond(msg.id, {
        sessions: [...sessions].map(([sessionId, s]) => ({
          sessionId,
          cwd: s.cwd,
        })),
      });
      return;
    }
    case "session/set_mode": {
      if (NO_SETMODE) {
        return respondErr(msg.id, -32601, "Method not found");
      }
      const s = sessions.get(String(msg.params?.sessionId));
      const modeId = String(msg.params?.modeId ?? "");
      if (!s) return respondErr(msg.id, -32602, "unknown session");
      if (!NO_CAPS && !MODES.some((m) => m.id === modeId)) {
        return respondErr(msg.id, -32602, `unknown mode ${modeId}`);
      }
      s.mode = modeId;
      update(String(msg.params?.sessionId), {
        sessionUpdate: "current_mode_update",
        currentModeId: modeId,
      });
      respond(msg.id, { configOptions: configOptions(s) });
      return;
    }
    // Real devin has no session/set_model — model/mode changes go through
    // session/set_config_option; the response echoes configOptions with the
    // confirmed currentValue.
    case "session/set_config_option": {
      const s = sessions.get(String(msg.params?.sessionId));
      const configId = String(msg.params?.configId ?? "");
      const value = String(msg.params?.value ?? "");
      if (!s) return respondErr(msg.id, -32602, "unknown session");
      if (configId === "model") {
        if (!NO_CAPS && !MODELS.some((m) => m.id === value)) {
          return respondErr(msg.id, -32602, `unknown model ${value}`);
        }
      } else if (configId === "mode") {
        if (!NO_CAPS && !MODES.some((m) => m.id === value)) {
          return respondErr(msg.id, -32602, `unknown mode ${value}`);
        }
      } else {
        return respondErr(msg.id, -32602, `unknown configId ${configId}`);
      }
      const sessionId = String(msg.params?.sessionId);
      setTimeout(() => {
        if (configId === "model") {
          // FORCE_MODEL simulates an agent that confirms a different value
          // than requested — the bridge must catch the mismatch.
          s.model = FORCE_MODEL || value;
        } else {
          s.mode = value;
        }
        // A NO_CAPS agent accepts but echoes nothing — no confirmation.
        if (NO_CAPS || CFG_NO_ECHO) return respond(msg.id, {});
        update(sessionId, {
          sessionUpdate: "config_option_update",
          configOptions: configOptions(s),
        });
        respond(msg.id, { configOptions: configOptions(s) });
      }, CFG_DELAY);
      return;
    }
    case "session/prompt": {
      const sessionId = String(msg.params?.sessionId ?? "");
      const s = sessions.get(sessionId);
      if (!s) return respondErr(msg.id, -32602, `unknown session ${sessionId}`);
      if (s.turn) {
        return respondErr(msg.id, -32000, "prompt already in flight");
      }
      const text = (msg.params?.prompt ?? [])
        .map((b) => b?.text ?? "")
        .join("");
      runTurn(sessionId, msg.id, text);
      return;
    }
    default:
      respondErr(msg.id, -32601, `unknown method ${msg.method}`);
  }
});
