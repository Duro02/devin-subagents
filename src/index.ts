#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  Controller,
  WAIT_DEFAULT_MS,
  type ControllerConfig,
} from "./controller.js";
import { loadBridgeConfig, USAGE } from "./config.js";
import { BridgeTaskStore, runTaskWorker } from "./tasks.js";

function loadConfig(): ControllerConfig {
  const { config, file, specified, help } = loadBridgeConfig(
    process.argv.slice(2),
  );
  if (help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (file) process.stderr.write(`devin-subagents: config ${file}\n`);
  return {
    ...config,
    cwd: process.cwd(),
    // Values written in the config file are deliberate: fail a spawn whose
    // configured mode isn't advertised, rather than silently running a
    // different config. Built-in defaults degrade to *_skipped events.
    // Models always require exact agent confirmation at spawn.
    modeStrict: specified.has("mode"),
    onLog: (line) => process.stderr.write(`[devin] ${line}\n`),
  };
}

let ctl: Controller;
let cfg: ControllerConfig;

const ok = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
  ...(v !== null && typeof v === "object" && !Array.isArray(v)
    ? { structuredContent: v as Record<string, unknown> }
    : {}),
});
const fail = (e: unknown) => ({
  isError: true,
  content: [
    { type: "text" as const, text: e instanceof Error ? e.message : String(e) },
  ],
});
const run = async (f: () => Promise<unknown> | unknown) => {
  try {
    let v = await f();
    // Pending subagent notices ride along on every tool result so a
    // report() never sits unread just because no one asked.
    const inbox = ctl.notifyInbox();
    if (inbox.length) {
      v =
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? { ...(v as Record<string, unknown>), inbox }
          : { result: v ?? null, inbox };
    }
    return ok(v);
  } catch (e) {
    return fail(e);
  }
};

const nameParam = z
  .string()
  .describe("Subagent handle returned by spawn, e.g. 'coder-auth'");

/**
 * How long a finished task's result is retained when the caller didn't ask
 * for a ttl. Bounds memory for the internal tasks the SDK creates behind
 * plain (non-task) wait calls; clients requesting a ttl get it verbatim.
 */
const TASK_RESULT_TTL_MS = 600_000;

const taskStore = new BridgeTaskStore({
  onLog: (l) => process.stderr.write(`[devin] ${l}\n`),
});

const server = new McpServer(
  {
    name: "devin-subagents",
    version: "0.5.0",
  },
  {
    // Advertise MCP tasks: on clients that speak the protocol, task-aware
    // tools (wait) can run as real background tasks whose result is
    // delivered natively. Older clients just see normal tools.
    capabilities: { tasks: { requests: { tools: { call: {} } } } },
    taskStore,
  },
);

server.registerTool(
  "spawn",
  {
    title: "Spawn a Devin subagent",
    description:
      "Create a new Devin session and start it on a task in the background. " +
      "Returns immediately; use poll to watch progress. Multiple subagents can run in parallel.",
    inputSchema: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe("Unique handle for this subagent ([A-Za-z0-9._-])"),
      task: z.string().min(1).describe("The task prompt for the subagent"),
      cwd: z
        .string()
        .optional()
        .describe("Absolute working directory for the session (default: bridge cwd)"),
      mode: z
        .string()
        .optional()
        .describe("Permission mode to set (e.g. 'bypass'); default: config file 'mode' or 'smart'"),
      model: z
        .string()
        .optional()
        .describe("Model to confirm (e.g. 'swe-2-max'); default: config file 'model' or 'swe-2-max'"),
    },
  },
  ({ name, task, cwd, mode, model }) =>
    run(() => ctl.spawn(name, task, cwd, mode, model)),
);

server.registerTool(
  "send",
  {
    title: "Send a message to a subagent",
    description:
      "Send a follow-up prompt to a subagent. While a turn is running the " +
      "message is queued in FIFO order and starts as the next turn once the " +
      "current one finishes (turns are strictly serialized per session). " +
      "Stopped/dead subagents must be resumed first.",
    inputSchema: {
      name: nameParam,
      text: z.string().min(1).describe("Message text"),
    },
  },
  ({ name, text }) => run(() => ctl.send(name, text)),
);

server.registerTool(
  "poll",
  {
    title: "Inspect a subagent or read its event log",
    description:
      "Two observation modes. detail='inspect' (default): a persistent " +
      "snapshot of what the subagent is doing — lifecycle fields, pending " +
      "permission, current/latest turn timing and duration, last actual " +
      "output, active tool calls (merged by id, with elapsed ms), current " +
      "plan step, latest text, latest error, and last-activity/last-content " +
      "ages. It is independent of the event log: unaffected by reads or by " +
      "buffer eviction. detail='logs': the chronological normalized event " +
      "log (message/thinking/tool/plan/usage/mode/queued/turn_start/" +
      "turn_end/permission_*) with seq and bridge receipt timestamps, paged " +
      "by an implicit read cursor; 'limit' bounds each page and " +
      "nextCursor/hasMore continue it, droppedEvents counts buffer-evicted " +
      "events. 'since': in inspect mode, a snapshot cursor — wait_ms blocks " +
      "for events newer than it; in logs mode it replays events after that " +
      "seq without moving the read cursor. wait_ms blocks briefly while a " +
      "turn can still produce events.",
    inputSchema: {
      name: nameParam,
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(60000)
        .optional()
        .describe("Block up to this many ms for new events while a turn is active (default 0)"),
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "inspect: wait_ms blocks for events newer than this snapshot cursor. " +
            "logs: replay events after this seq without moving the read cursor",
        ),
      detail: z
        .enum(["inspect", "logs"])
        .optional()
        .describe("inspect (default): persistent snapshot; logs: paged event log"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .describe("logs only: max buffered events consumed this call; page via nextCursor/hasMore"),
    },
  },
  ({ name, wait_ms, since, detail, limit }) =>
    run(() =>
      ctl.poll(name, wait_ms ?? 0, since, detail ?? "inspect", limit),
    ),
);

// `wait` is a task-augmented tool: on hosts that speak MCP tasks the call
// becomes a background task and its result arrives natively on completion;
// everywhere else the SDK turns a normal call into createTask + internal
// polling, so the same code blocks synchronously for older clients.
server.experimental.tasks.registerToolTask(
  "wait",
  {
    title: "Wait until a subagent needs attention",
    description:
      "Block until the subagent needs you, then return what happened. " +
      "Wakes on: turn drained to idle (wake='done'), a pending permission " +
      "request (wake='permission' — answer via the permission tool), a " +
      "report() checkpoint from the subagent (wake='report' — a report is " +
      "delivered once, even if it arrived before this call), terminal " +
      "states (wake='stopped'/'dead'), or timeout (wake='timeout', " +
      "snapshot shows live state). Already-attention states return " +
      "immediately, so it doubles as 'is it done?'. On hosts supporting " +
      "MCP tasks this runs as a background task; elsewhere it blocks.",
    inputSchema: {
      name: nameParam,
      timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(3600000)
        .optional()
        .describe(
          `Block up to this many ms for attention (default ${WAIT_DEFAULT_MS}, max 3600000)`,
        ),
    },
    execution: { taskSupport: "optional" },
  },
  {
    createTask: async ({ name, timeout_ms }, extra) => {
      const task = await extra.taskStore!.createTask({
        ttl: extra.taskRequestedTtl ?? TASK_RESULT_TTL_MS,
        pollInterval: 500,
      });
      // Two cancellation sources converge on the same AbortController:
      // tasks/cancel aborts it inside the store; for plain (non-task) calls
      // the harness cancels the request itself — link extra.signal so that
      // path ends the waiter too. Neither ever touches the Devin turn.
      const signal = taskStore.aborter(task.taskId);
      if (extra.signal.aborted) {
        taskStore.abortTask(task.taskId);
      } else {
        extra.signal.addEventListener(
          "abort",
          () => taskStore.abortTask(task.taskId),
          { once: true },
        );
      }
      runTaskWorker({
        store: extra.taskStore!,
        taskId: task.taskId,
        work: async () => {
          let v: unknown = await ctl.wait(
            name,
            timeout_ms ?? WAIT_DEFAULT_MS,
            signal,
          );
          const inbox = ctl.notifyInbox();
          if (inbox.length) {
            v = { ...(v as Record<string, unknown>), inbox };
          }
          return v;
        },
        ok,
        fail,
        onLog: (l) => process.stderr.write(`[devin] ${l}\n`),
      });
      return { task };
    },
    getTask: async (_args, { taskId, taskStore }) => {
      const t = await taskStore!.getTask(taskId!);
      if (!t) throw new Error(`unknown task ${taskId}`);
      return t;
    },
    getTaskResult: async (_args, { taskId, taskStore }) =>
      (await taskStore!.getTaskResult(taskId!)) as CallToolResult,
  },
);

server.registerTool(
  "interrupt",
  {
    title: "Interrupt a subagent",
    description:
      "Cancel the in-flight turn (ACP session/cancel) and drop queued messages. " +
      "The session stays alive and resumable.",
    inputSchema: { name: nameParam },
  },
  ({ name }) => run(() => ctl.interrupt(name)),
);

server.registerTool(
  "stop",
  {
    title: "Stop a subagent",
    description:
      "Interrupt any running turn, drop queued messages and mark the subagent " +
      "stopped. The session is kept and can be continued later with resume.",
    inputSchema: { name: nameParam },
  },
  ({ name }) => run(() => ctl.stop(name)),
);

server.registerTool(
  "resume",
  {
    title: "Resume a subagent",
    description:
      "Re-activate a stopped/dead/persisted Devin session (survives bridge " +
      "restarts). Safe no-op on already-running subagents.",
    inputSchema: { name: nameParam },
  },
  ({ name }) => run(() => ctl.resume(name)),
);

server.registerTool(
  "list",
  {
    title: "List subagents",
    description: "List live, persisted, and agent-side sessions with status.",
    inputSchema: {},
  },
  () => run(() => ctl.list()),
);

server.registerTool(
  "permission",
  {
    title: "Answer a permission request",
    description:
      "Grant or deny a pending tool-permission request surfaced by poll " +
      "(used when permission=operator — the calling agent decides). " +
      "Pass optionId to approve, omit to deny.",
    inputSchema: {
      name: nameParam,
      optionId: z
        .string()
        .optional()
        .describe("The optionId from pendingPermission.options to select"),
    },
  },
  ({ name, optionId }) => run(() => ctl.permission(name, optionId)),
);

server.registerTool(
  "set_mode",
  {
    title: "Change a subagent's permission mode",
    description:
      "Switch the session's mode (e.g. 'bypass', 'smart'). Validated against " +
      "the session's advertised availableModes when known.",
    inputSchema: {
      name: nameParam,
      mode: z.string().min(1).describe("Mode id from the session's availableModes"),
    },
  },
  ({ name, mode }) => run(() => ctl.setMode(name, mode)),
);

server.registerTool(
  "models",
  {
    title: "Report advertised models/modes",
    description:
      "With 'name': the session's current model/mode and the agent-advertised " +
      "available lists. Without: the bridge's configured defaults plus the " +
      "last-advertised agent-level lists (null until the first session is " +
      "created). Devin model ids are e.g. swe-2-medium / swe-2-high / swe-2-max.",
    inputSchema: {
      name: nameParam.optional(),
    },
  },
  ({ name }) => run(() => ctl.models(name)),
);

server.registerTool(
  "set_model",
  {
    title: "Change a subagent's model",
    description:
      "Switch an idle session's model via session/set_config_option and " +
      "confirm the echoed value (e.g. 'swe-2-high'). Rejected while the " +
      "session is starting/running/stopped/dead — resume or wait for idle " +
      "first. Validated against the advertised model list when known.",
    inputSchema: {
      name: nameParam,
      model: z.string().min(1).describe("Model id from the session's advertised list"),
    },
  },
  ({ name, model }) => run(() => ctl.setModel(name, model)),
);

async function main(): Promise<void> {
  cfg = loadConfig();
  ctl = new Controller(cfg);
  const shutdown = () => {
    taskStore.cleanup();
    ctl.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The host closed our stdin (session over): take the devin child with us.
  process.stdin.on("end", shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `devin-subagents ready (agent: ${cfg.command} ${cfg.args.join(" ")}, ` +
      `permission=${cfg.permission}, mode=${cfg.mode ?? "default"}, ` +
      `model=${cfg.model ?? "agent-default"}, state=${cfg.statePath})\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
