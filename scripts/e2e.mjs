// End-to-end lifecycle test: drives the bridge over real MCP stdio exactly
// like Codex would. Exercises spawn → poll → send → interrupt → stop →
// resume → list against a live `devin acp`.
// Usage: node scripts/e2e.mjs   (requires devin auth; uses DEVIN_MODEL)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";

const WORKDIR = "/tmp/devin-sub-test";
mkdirSync(WORKDIR, { recursive: true });

const bridge = spawn("node", ["dist/index.js"], {
  env: {
    ...process.env,
    DEVIN_MODEL: process.env.DEVIN_MODEL ?? "swe-2-max",
    DEVIN_SUBAGENT_PERMISSION: "auto",
    DEVIN_SUBAGENT_STATE: `${WORKDIR}/.devin-subagents.json`,
  },
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
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});

const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const note = (method) =>
  bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

const tool = async (name, args = {}) => {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res?.content?.[0]?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (res?.isError) throw new Error(`${name}: ${text}`);
  return parsed;
};

const brief = (e) => {
  const d = e.data ?? {};
  if (e.kind === "agent_message_chunk" || e.kind === "user_message_chunk")
    return (d.content?.text ?? "").slice(0, 120).replace(/\n/g, " ");
  if (e.kind === "tool_call")
    return `${d.title ?? d.toolCallId ?? ""} (${d.kind ?? ""})`;
  if (e.kind === "tool_call_update")
    return `${d.toolCallId ?? ""} -> ${d.status ?? ""}`;
  if (e.kind === "turn_start") return (d.text ?? "").slice(0, 80);
  return JSON.stringify(d).slice(0, 120);
};

async function pollUntilTurnEnd(name, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await tool("devin_poll", { name, wait_ms: 5000 });
    for (const e of r.events ?? []) {
      console.log(`    [${name}#${e.seq}] ${e.kind}: ${brief(e)}`);
      if (e.kind === "turn_end") return r;
    }
    if (r.status !== "running" && (r.events ?? []).length === 0) return r;
  }
  throw new Error(`pollUntilTurnEnd(${name}) timed out`);
}

const step = (s) => console.log(`\n=== ${s} ===`);

try {
  step("MCP initialize");
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  note("notifications/initialized");
  console.log("  server:", init.serverInfo.name, init.serverInfo.version);

  step("spawn alpha (echo task, smart mode default)");
  const a = await tool("devin_spawn", {
    name: "alpha",
    cwd: WORKDIR,
    task:
      "Run `echo subagent-alpha-alive` using your exec tool, then report its " +
      "output verbatim. Do not create or modify any files.",
  });
  console.log("  ->", JSON.stringify(a));
  await pollUntilTurnEnd("alpha");

  step("send alpha a follow-up (2nd turn)");
  await tool("devin_send", {
    name: "alpha",
    text: "Reply with exactly this token and nothing else: TURN2-DONE",
  });
  await pollUntilTurnEnd("alpha");

  step("spawn beta (slow task) then interrupt mid-turn");
  await tool("devin_spawn", {
    name: "beta",
    cwd: WORKDIR,
    task: "Run `sleep 60` using your exec tool, then say done.",
  });
  await tool("devin_poll", { name: "beta", wait_ms: 8000 }).then((r) =>
    r.events.forEach((e) => console.log(`    [beta#${e.seq}] ${e.kind}: ${brief(e)}`)),
  );
  await tool("devin_interrupt", { name: "beta" });
  await pollUntilTurnEnd("beta");

  step("stop alpha, resume it, verify context survived");
  await tool("devin_stop", { name: "alpha" });
  const rs = await tool("devin_resume", { name: "alpha" });
  console.log("  ->", JSON.stringify(rs));
  await tool("devin_send", {
    name: "alpha",
    text: "What token did I ask you to reply with earlier? Answer with just the token.",
  });
  await pollUntilTurnEnd("alpha");

  step("devin_list");
  const l = await tool("devin_list");
  console.log(JSON.stringify(l.subagents, null, 2));

  console.log("\nE2E PASSED");
  bridge.kill();
  process.exit(0);
} catch (e) {
  console.error("\nE2E FAILED:", e.message);
  bridge.kill();
  process.exit(1);
}
