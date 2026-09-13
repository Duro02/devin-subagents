// Smoke test: spawn the configured ACP agent, run the initialize handshake,
// print advertised capabilities. No auth required — session creation is.
// Exits 0 only on a well-formed initialize result; JSON-RPC errors, early
// child exit, spawn failure, malformed output and timeouts all exit nonzero.
// Usage: npm run smoke -- [--config PATH]   (same flags as the bridge)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const dist = path.join(fileURLToPath(new URL(".", import.meta.url)), "../dist");
const { loadBridgeConfig, USAGE } = await import(
  pathToFileURL(path.join(dist, "config.js")).href
).catch(() => {
  console.error("dist/config.js missing — run `npm run build` first");
  process.exit(2);
});

let cfg;
try {
  const loaded = loadBridgeConfig(process.argv.slice(2));
  if (loaded.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  cfg = loaded.config;
  if (loaded.file) console.error(`config: ${loaded.file}`);
} catch (e) {
  console.error(`SMOKE FAILED: ${e.message}`);
  process.exit(2);
}

const child = spawn(cfg.command, cfg.args, { stdio: ["pipe", "pipe", "pipe"] });
const rl = createInterface({ input: child.stdout });

const die = (msg, code = 2) => {
  console.error(`SMOKE FAILED: ${msg}`);
  child.kill();
  process.exit(code);
};

const timer = setTimeout(() => {
  die("no response from agent within 10s");
}, 10_000);

child.on("error", (err) => die(`spawn failed: ${err.message}`));
child.on("exit", (code, signal) =>
  die(`agent exited before initialize (code=${code} signal=${signal})`),
);

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`non-JSON line: ${line.slice(0, 200)}`);
    return;
  }
  if (msg.id !== 1) return; // not our initialize response
  clearTimeout(timer);
  if (msg.error) {
    die(`initialize returned error: ${JSON.stringify(msg.error)}`);
  }
  if (!msg.result || typeof msg.result !== "object" || msg.result.protocolVersion === undefined) {
    die(`malformed initialize result: ${JSON.stringify(msg.result)}`);
  }
  console.log(JSON.stringify(msg.result, null, 2));
  child.kill();
  process.exit(0);
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
