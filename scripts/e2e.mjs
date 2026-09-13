// End-to-end lifecycle test: drives the bridge over real MCP stdio exactly
// like Codex would. Exercises spawn → poll → queued send → interrupt → stop →
// resume → list against a live `devin acp`, with real assertions.
// The bridge is configured via a generated devin-subagents.config.json in a
// unique temp dir — no DEVIN_* env configuration.
// Usage: npm run e2e   (requires devin auth)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKDIR = mkdtempSync(path.join(tmpdir(), "devin-sub-e2e-"));
const NAMES = { a: `alpha-${process.pid}`, b: `beta-${process.pid}` };

const configPath = path.join(WORKDIR, "devin-subagents.config.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      command: "devin",
      args: ["acp"],
      permission: "auto",
      mode: "smart",
      model: "swe-2-max",
      statePath: "state.json",
      rpcTimeoutMs: 30000,
    },
    null,
    2,
  ),
);

const bridge = spawn("node", ["dist/index.js", "--config", configPath], {
  stdio: ["pipe", "pipe", "inherit"], // bridge stderr -> our stderr
});
const rl = createInterface({ input: bridge.stdout });

let seq = 0;
const pending = new Map();
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});

// Every bridge call is bounded: a hung RPC fails instead of stalling e2e.
const rpc = (method, params, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const note = (method) =>
  bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

const tool = async (name, args = {}, timeoutMs) => {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  const text = res?.content?.[0]?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (res?.isError) {
    const e = new Error(`${name}: ${text}`);
    e.result = res;
    throw e;
  }
  // structured output parity: object results must also be structuredContent
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (res?.structuredContent === undefined) {
      throw new Error(`${name}: missing structuredContent`);
    }
  }
  return parsed;
};

function assert(cond, msg) {
  if (!cond) throw new Error(`assert: ${msg}`);
}

// Normalized event kinds: message, thinking, tool, plan, usage, mode,
// queued, turn_start, turn_end, permission_*, resumed, interrupt, stopped,
// agent_exit, *_skipped/*_failed
const brief = (e) => {
  switch (e.type) {
    case "message":
    case "thinking":
      return (e.text ?? "").slice(0, 120).replace(/\n/g, " ");
    case "tool":
      return `${e.id ?? ""} ${e.title ?? ""} (${e.kind ?? ""}) -> ${e.status ?? ""}` +
        (e.output ? ` out=${String(e.output).slice(0, 80)}` : "");
    case "turn_start":
      return `turn=${e.turn} ${(e.text ?? "").slice(0, 80)}`;
    case "turn_end":
      return `turn=${e.turn} stopReason=${e.stopReason}`;
    case "usage":
      return `used=${e.used}/${e.size} in=${e.inputTokens} out=${e.outputTokens}`;
    default:
      return JSON.stringify(e).slice(0, 120);
  }
};

async function pollUntilTurnEnd(name, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  for (;;) {
    const r = await tool("poll", { name, wait_ms: 5000, detail: "logs" });
    for (const e of r.events ?? []) {
      seen.push(e);
      console.log(`    [${name}#${e.seq}] ${e.type}: ${brief(e)}`);
      if (e.type === "turn_end") return { ...r, allEvents: seen };
    }
    if (r.status !== "running" && r.status !== "starting" && (r.events ?? []).length === 0) {
      return { ...r, allEvents: seen };
    }
    if (Date.now() > deadline) {
      throw new Error(`pollUntilTurnEnd(${name}) timed out; status=${r.status}`);
    }
  }
}

// inspect snapshot: latest accumulated turn text
const lastText = async (name) =>
  (await tool("poll", { name })).snapshot?.latestText?.text ?? "";

const step = (s) => console.log(`\n=== ${s} ===`);
let failed = null;

// overall watchdog: never hang forever
const watchdog = setTimeout(() => {
  console.error("\nE2E FAILED: global watchdog (8min)");
  bridge.kill("SIGKILL");
  process.exit(2);
}, 8 * 60_000);

try {
  step("MCP initialize");
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  note("notifications/initialized");
  console.log("  server:", init.serverInfo.name, init.serverInfo.version);
  assert(init.serverInfo?.name === "devin-subagents", "serverInfo.name");

  step(`spawn ${NAMES.a} (echo task, smart mode default)`);
  const a = await tool("spawn", {
    name: NAMES.a,
    cwd: WORKDIR,
    task:
      "Run `echo subagent-alpha-alive` using your exec tool, then report its " +
      "output verbatim. Do not create or modify any files.",
  });
  console.log("  ->", JSON.stringify(a));
  assert(a.status === "running", "spawn status must be running");
  assert(a.sessionId, "spawn must return sessionId");
  assert(a.turn === 1, "spawn must start turn 1");
  assert(a.mode, "spawn should report the applied mode");
  assert(a.model === "swe-2-max", `spawn should confirm swe-2-max, got ${a.model}`);

  step("models tool: advertised ids + confirmed current");
  const ms = await tool("models");
  assert(
    Array.isArray(ms.availableModels) && ms.availableModels.includes("swe-2-max"),
    `models should list swe-2-max, got ${JSON.stringify(ms.availableModels)}`,
  );
  const msa = await tool("models", { name: NAMES.a });
  assert(msa.model === "swe-2-max", `session model should be swe-2-max, got ${msa.model}`);

  const d1 = await pollUntilTurnEnd(NAMES.a);
  assert(d1.status === "idle", `alpha must go idle, got ${d1.status}`);
  assert(d1.lastStopReason === "end_turn", `alpha stopReason=${d1.lastStopReason}`);
  const t1 = await lastText(NAMES.a);
  assert(
    t1.includes("subagent-alpha-alive"),
    `alpha text should echo the token, got: ${t1.slice(0, 200)}`,
  );
  assert(
    d1.allEvents.some((e) => e.type === "turn_end" && e.turn === 1),
    "turn_end for turn 1 required",
  );

  step("poll default detail is a persistent inspect snapshot");
  const sum = await tool("poll", { name: NAMES.a });
  assert(sum.events === undefined, "inspect must not carry events");
  assert(sum.snapshot && typeof sum.snapshot === "object", "inspect must carry snapshot");
  assert(typeof sum.cursor === "number", "inspect must carry a snapshot cursor");
  assert(sum.capturedAt, "inspect must carry capturedAt");
  assert(sum.snapshot.turn?.endedAt, "snapshot turn must be ended");
  assert(sum.snapshot.turn?.stopReason === "end_turn", "snapshot turn stopReason");
  assert(
    sum.snapshot.latestText?.text?.includes("subagent-alpha-alive"),
    "snapshot latestText should carry the turn's text",
  );
  assert(Array.isArray(sum.snapshot.activeTools), "snapshot activeTools must be an array");

  step("set_model on idle session (swe-2-max -> swe-2-high)");
  const sm = await tool("set_model", { name: NAMES.a, model: "swe-2-high" });
  assert(sm.model === "swe-2-high", `set_model must confirm, got ${JSON.stringify(sm)}`);

  step(`send ${NAMES.a} a follow-up (2nd turn)`);
  const s2 = await tool("send", {
    name: NAMES.a,
    text: "Reply with exactly this token and nothing else: TURN2-DONE",
  });
  assert(s2.status === "running" && s2.turn === 2, "send must start turn 2");
  const d2 = await pollUntilTurnEnd(NAMES.a);
  assert(d2.status === "idle", "alpha idle after turn 2");
  const t2 = await lastText(NAMES.a);
  assert(
    t2.includes("TURN2-DONE"),
    `alpha turn-2 text should contain TURN2-DONE, got: ${t2.slice(0, 200)}`,
  );

  step(`spawn ${NAMES.b} (slow task), queue a send, then interrupt mid-turn`);
  await tool("spawn", {
    name: NAMES.b,
    cwd: WORKDIR,
    task: "Run `sleep 60` using your exec tool, then say done.",
  });
  const bp = await tool("poll", { name: NAMES.b, wait_ms: 8000, detail: "logs" });
  bp.events.forEach((e) => console.log(`    [beta#${e.seq}] ${e.type}: ${brief(e)}`));
  const betaAll = [...(bp.events ?? [])];
  assert(bp.status === "running", "beta must be running");
  // send while running -> bridge FIFO queue
  const q = await tool("send", { name: NAMES.b, text: "never-should-run" });
  assert(q.queued === true, `send while running must queue, got ${JSON.stringify(q)}`);
  const ir = await tool("interrupt", { name: NAMES.b });
  assert(ir.note === "cancel sent", "interrupt while running must cancel");
  const db = await pollUntilTurnEnd(NAMES.b);
  betaAll.push(...db.allEvents);
  assert(db.status === "idle", `beta must be idle after interrupt, got ${db.status}`);
  assert(
    betaAll.some((e) => e.type === "turn_end" && e.stopReason === "cancelled"),
    "beta turn must end cancelled",
  );
  // the queued message must never start a turn: only turn 1 may exist
  assert(
    betaAll.every((e) => e.type !== "turn_start" || e.turn === 1),
    "queued message must be dropped by interrupt",
  );
  assert(betaAll.some((e) => e.type === "turn_start" && e.turn === 1),
    "beta turn 1 must have started");

  step(`stop ${NAMES.a}, resume it, verify context survived`);
  const st = await tool("stop", { name: NAMES.a });
  assert(st.status === "stopped", "stop must report stopped");
  let sendErr = null;
  try {
    await tool("send", { name: NAMES.a, text: "x" });
  } catch (e) {
    sendErr = e;
  }
  assert(sendErr && /resume/i.test(sendErr.message),
    "send on stopped must fail with a resume hint");
  const rs = await tool("resume", { name: NAMES.a });
  console.log("  ->", JSON.stringify(rs));
  assert(rs.sessionId === a.sessionId, "resume must keep the same sessionId");
  assert(rs.status === "idle", "resumed session must be idle");
  // resume preserves the session's own model selection (swe-2-high),
  // not the configured default
  const msr = await tool("models", { name: NAMES.a });
  assert(msr.model === "swe-2-high",
    `resume must preserve session model swe-2-high, got ${msr.model}`);
  await tool("send", {
    name: NAMES.a,
    text: "What token did I ask you to reply with earlier? Answer with just the token.",
  });
  const d3 = await pollUntilTurnEnd(NAMES.a);
  const t3 = await lastText(NAMES.a);
  assert(
    t3.includes("TURN2-DONE"),
    `resumed alpha lost context: ${t3.slice(0, 200)}`,
  );

  step("list");
  const l = await tool("list");
  console.log(JSON.stringify(l.subagents, null, 2));
  assert(l.agentAlive === true, "agentAlive must be true");
  const names = l.subagents.map((s) => s.name);
  assert(names.includes(NAMES.a) && names.includes(NAMES.b), "both subagents listed");
  assert(
    l.subagents.find((s) => s.name === NAMES.a).status === "idle",
    "alpha must be idle in list",
  );

  console.log("\nE2E PASSED");
} catch (e) {
  failed = e;
  console.error("\nE2E FAILED:", e.message);
} finally {
  clearTimeout(watchdog);
  bridge.kill();
  if (failed) {
    console.error(`workdir kept for inspection: ${WORKDIR}`);
  } else {
    rmSync(WORKDIR, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
