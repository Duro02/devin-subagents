import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Controller } from "./controller.js";

const cfg = {
  bin: process.env.DEVIN_BIN ?? "devin",
  args: (process.env.DEVIN_ACP_ARGS ?? "acp").split(" ").filter(Boolean),
  cwd: process.cwd(),
  env: process.env.DEVIN_MODEL ? { DEVIN_MODEL: process.env.DEVIN_MODEL } : {},
  statePath:
    process.env.DEVIN_SUBAGENT_STATE ??
    `${process.cwd()}/.devin-subagents.json`,
  permissionPolicy: (process.env.DEVIN_SUBAGENT_PERMISSION ??
    "auto") as "auto" | "always" | "operator",
  // Subagents default to smart mode: workspace edits auto-approve and a fast
  // model auto-runs clearly-safe actions; riskier ones still come back as
  // permission requests (see DEVIN_SUBAGENT_PERMISSION for how we answer).
  defaultMode: process.env.DEVIN_SUBAGENT_MODE ?? "smart",
};

const ctl = new Controller(cfg);

const ok = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [
    { type: "text" as const, text: e instanceof Error ? e.message : String(e) },
  ],
});
const run = async (f: () => Promise<unknown> | unknown) => {
  try {
    return ok(await f());
  } catch (e) {
    return fail(e);
  }
};

const server = new McpServer({
  name: "devin-subagents",
  version: "0.1.0",
});

server.registerTool(
  "devin_spawn",
  {
    title: "Spawn a Devin subagent",
    description:
      "Create a new Devin session and start it on a task in the background. " +
      "Returns immediately; use devin_poll to watch progress. Multiple subagents can run in parallel.",
    inputSchema: {
      name: z
        .string()
        .describe("Unique handle for this subagent, e.g. 'coder-auth'"),
      task: z.string().describe("The task prompt for the subagent"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory for the session (default: bridge cwd)"),
      mode: z
        .string()
        .optional()
        .describe("Permission mode to set, e.g. 'bypass', if the agent advertises it"),
    },
  },
  ({ name, task, cwd, mode }) => run(() => ctl.spawn(name, task, cwd, mode)),
);

server.registerTool(
  "devin_send",
  {
    title: "Send a message to a subagent",
    description:
      "Send a follow-up prompt to a subagent. If a turn is already running the " +
      "message is submitted as a queued mid-turn prompt (picked up after the " +
      "current tool call); otherwise it starts a new turn.",
    inputSchema: {
      name: z.string().describe("Subagent handle from devin_spawn"),
      text: z.string().describe("Message text"),
    },
  },
  ({ name, text }) => run(() => ctl.send(name, text)),
);

server.registerTool(
  "devin_poll",
  {
    title: "Read new output from a subagent",
    description:
      "Incremental read of a subagent's session updates (agent text, tool calls, " +
      "turn results) since the last poll. Use wait_ms to block briefly for new events.",
    inputSchema: {
      name: z.string().describe("Subagent handle"),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(60000)
        .optional()
        .describe("Block up to this many ms for new events (default 0)"),
      since: z
        .number()
        .int()
        .optional()
        .describe("Return events after this seq instead of the stored read cursor"),
    },
  },
  ({ name, wait_ms, since }) => run(() => ctl.poll(name, wait_ms ?? 0, since)),
);

server.registerTool(
  "devin_interrupt",
  {
    title: "Interrupt a subagent",
    description:
      "Cancel the in-flight turn (ACP session/cancel). The session stays alive and resumable.",
    inputSchema: { name: z.string().describe("Subagent handle") },
  },
  ({ name }) => run(() => ctl.interrupt(name)),
);

server.registerTool(
  "devin_stop",
  {
    title: "Stop a subagent",
    description:
      "Interrupt any running turn and mark the subagent stopped. The session is " +
      "kept and can be continued later with devin_resume.",
    inputSchema: { name: z.string().describe("Subagent handle") },
  },
  ({ name }) => run(() => ctl.stop(name)),
);

server.registerTool(
  "devin_resume",
  {
    title: "Resume a subagent",
    description:
      "Reload a persisted Devin session (survives bridge restarts and Codex sessions).",
    inputSchema: { name: z.string().describe("Subagent handle or persisted name") },
  },
  ({ name }) => run(() => ctl.resume(name)),
);

server.registerTool(
  "devin_list",
  {
    title: "List subagents",
    description:
      "List live, persisted, and agent-side sessions with status.",
    inputSchema: {},
  },
  () => run(() => ctl.list()),
);

server.registerTool(
  "devin_permission",
  {
    title: "Answer a permission request",
    description:
      "Grant or deny a pending tool-permission request shown in devin_poll " +
      "(only used when the bridge runs with DEVIN_SUBAGENT_PERMISSION=operator). " +
      "Pass optionId to approve, omit to deny.",
    inputSchema: {
      name: z.string().describe("Subagent handle"),
      optionId: z
        .string()
        .optional()
        .describe("The optionId from pendingPermission.options to select"),
    },
  },
  ({ name, optionId }) => run(() => ctl.permission(name, optionId)),
);

server.registerTool(
  "devin_set_mode",
  {
    title: "Change a subagent's permission mode",
    description: "Switch the session's mode (e.g. 'bypass', 'smart').",
    inputSchema: {
      name: z.string().describe("Subagent handle"),
      mode: z.string().describe("Mode id from the session's availableModes"),
    },
  },
  ({ name, mode }) => run(() => ctl.setMode(name, mode)),
);

async function main(): Promise<void> {
  const shutdown = () => {
    ctl.acp.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Codex closed our stdin (session over): take the devin child with us.
  process.stdin.on("end", shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `devin-subagents ready (agent: ${cfg.bin} ${cfg.args.join(" ")}, ` +
      `permission=${cfg.permissionPolicy}, state=${cfg.statePath})\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
