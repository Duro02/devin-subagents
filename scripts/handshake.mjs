// Smoke test: spawn `devin acp`, run the ACP initialize handshake, print
// advertised capabilities. No auth required — session creation is.
// Usage: node scripts/handshake.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const bin = process.env.DEVIN_BIN ?? "devin";
const args = (process.env.DEVIN_ACP_ARGS ?? "acp").split(" ");

const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
const rl = createInterface({ input: child.stdout });

const timer = setTimeout(() => {
  console.error("TIMEOUT: no response from devin acp within 10s");
  child.kill();
  process.exit(2);
}, 10_000);

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 1) {
    clearTimeout(timer);
    console.log(JSON.stringify(msg.result, null, 2));
    child.kill();
    process.exit(0);
  }
});

child.stderr.on("data", (d) => process.stderr.write(d));
child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "devin-subagents-smoke", version: "0.0.0" },
    },
  }) + "\n",
);
