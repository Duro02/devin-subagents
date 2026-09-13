import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Bridge configuration: one optional JSON file, no environment variables.
 *
 * Resolution order:
 *   1. `--config PATH` (explicit; missing file is an error)
 *   2. `<cwd>/devin-subagents.config.json` when it exists
 *   3. built-in defaults
 *
 * The file schema is strict: unknown keys and wrong types are rejected.
 * Relative `statePath` (and a relative `command` that contains a path
 * separator) resolve against the config file's directory.
 */

export const DEFAULT_CONFIG_FILE = "devin-subagents.config.json";
export const PERMISSION_POLICIES = ["auto", "always", "operator"] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];

const ID_RE = /^[^\s\\]{1,128}$/;

export interface BridgeConfig {
  /** agent binary (bare name resolves via PATH; a path resolves vs config dir) */
  command: string;
  /** argv for the agent (e.g. ["acp"]) */
  args: string[];
  /** where the name -> sessionId map is persisted */
  statePath: string;
  /** auto = pick allow_once; always = pick allow_always; operator = queue for permission */
  permission: PermissionPolicy;
  /** default mode applied at session/new (e.g. "smart") */
  mode: string;
  /** default model confirmed at session/new (e.g. "swe-2-max") */
  model: string;
  /** timeout for non-prompt agent RPCs (session/prompt is unbounded) */
  rpcTimeoutMs: number;
  /** per-session event ring buffer size */
  bufferCap: number;
  /**
   * mark managed sessions hidden=1 in devin's session DB so they stay out
   * of user-facing lists (/resume, `devin list`, agent `session/list`)
   */
  hideFromSessionList: boolean;
  /** devin session DB override (default: platform data dir path) */
  sessionDbPath?: string;
}

const ALLOWED_KEYS = new Set([
  "command",
  "args",
  "statePath",
  "permission",
  "mode",
  "model",
  "rpcTimeoutMs",
  "bufferCap",
  "hideFromSessionList",
  "sessionDbPath",
]);

const DEFAULTS: Omit<BridgeConfig, "statePath" | "sessionDbPath"> = {
  command: "devin",
  args: ["acp"],
  permission: "operator",
  mode: "smart",
  model: "swe-2-max",
  rpcTimeoutMs: 30_000,
  bufferCap: 500,
  hideFromSessionList: true,
};

export interface LoadedConfig {
  config: BridgeConfig;
  /** absolute path of the file actually loaded (undefined = defaults) */
  file?: string;
  /** keys the file specified explicitly (they are deliberate, not ambient) */
  specified: ReadonlySet<keyof BridgeConfig>;
  /** --help was passed */
  help: boolean;
}

export const USAGE = `devin-subagents — Devin ACP sessions as MCP subagents

Usage: node dist/index.js [--config PATH] [--help]

  --config PATH   JSON config file (default: ./${DEFAULT_CONFIG_FILE}
                  when present, otherwise built-in defaults)
  --help          show this text

Config keys (all optional): command, args, statePath, permission
("auto"|"always"|"operator"), mode, model, rpcTimeoutMs, bufferCap,
hideFromSessionList, sessionDbPath.
Environment variables are NOT read as bridge settings.
`;

function fail(where: string, msg: string): never {
  throw new Error(`config ${where}: ${msg}`);
}

export function loadBridgeConfig(
  argv: string[],
  cwd = process.cwd(),
): LoadedConfig {
  let explicit: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--config") {
      const v = argv[++i];
      if (!v) throw new Error("--config requires a path");
      explicit = v;
    } else if (a.startsWith("--config=")) {
      explicit = a.slice("--config=".length);
      if (!explicit) throw new Error("--config requires a path");
    } else {
      throw new Error(
        `unknown argument "${a}" (only --config PATH and --help are supported)`,
      );
    }
  }
  if (help) {
    return {
      config: { ...DEFAULTS, statePath: path.join(cwd, ".devin-subagents.json") },
      specified: new Set(),
      help: true,
    };
  }

  let file: string | undefined;
  if (explicit !== undefined) {
    file = path.resolve(cwd, explicit);
    if (!existsSync(file)) fail(file, "file not found");
  } else {
    const candidate = path.join(cwd, DEFAULT_CONFIG_FILE);
    if (existsSync(candidate)) file = candidate;
  }

  const baseDir = file ? path.dirname(file) : cwd;
  const cfg = {
    ...DEFAULTS,
    statePath: path.join(baseDir, ".devin-subagents.json"),
  } as BridgeConfig;
  const specified = new Set<keyof BridgeConfig>();
  if (!file) return { config: cfg, specified, help: false };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(file, `invalid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(file, "top level must be an object");
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(k)) {
      fail(
        file,
        `unknown key "${k}" (allowed: ${[...ALLOWED_KEYS].join(", ")})`,
      );
    }
  }

  const rel = (v: string) =>
    path.isAbsolute(v) ? v : path.resolve(baseDir, v);

  if (o.command !== undefined) {
    if (typeof o.command !== "string" || !o.command.trim()) {
      fail(file, `command must be a non-empty string`);
    }
    cfg.command = /[/\\]/.test(o.command) ? rel(o.command) : o.command;
    specified.add("command");
  }
  if (o.args !== undefined) {
    if (
      !Array.isArray(o.args) ||
      !o.args.every((a) => typeof a === "string")
    ) {
      fail(file, `args must be an array of strings`);
    }
    cfg.args = o.args as string[];
    specified.add("args");
  }
  if (o.statePath !== undefined) {
    if (typeof o.statePath !== "string" || !o.statePath.trim()) {
      fail(file, `statePath must be a non-empty string`);
    }
    cfg.statePath = rel(o.statePath);
    specified.add("statePath");
  }
  if (o.permission !== undefined) {
    if (
      typeof o.permission !== "string" ||
      !(PERMISSION_POLICIES as readonly string[]).includes(o.permission)
    ) {
      fail(
        file,
        `permission must be one of ${PERMISSION_POLICIES.join("|")}`,
      );
    }
    cfg.permission = o.permission as PermissionPolicy;
    specified.add("permission");
  }
  for (const k of ["mode", "model"] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== "string" || !ID_RE.test(o[k] as string)) {
        fail(file, `${k} must be 1-128 chars without whitespace`);
      }
      cfg[k] = o[k] as string;
      specified.add(k);
    }
  }
  for (const k of ["rpcTimeoutMs", "bufferCap"] as const) {
    if (o[k] !== undefined) {
      if (!Number.isInteger(o[k]) || (o[k] as number) < 1) {
        fail(file, `${k} must be an integer >= 1`);
      }
      cfg[k] = o[k] as number;
      specified.add(k);
    }
  }
  if (o.hideFromSessionList !== undefined) {
    if (typeof o.hideFromSessionList !== "boolean") {
      fail(file, `hideFromSessionList must be a boolean`);
    }
    cfg.hideFromSessionList = o.hideFromSessionList;
    specified.add("hideFromSessionList");
  }
  if (o.sessionDbPath !== undefined) {
    if (typeof o.sessionDbPath !== "string" || !o.sessionDbPath.trim()) {
      fail(file, `sessionDbPath must be a non-empty string`);
    }
    cfg.sessionDbPath = rel(o.sessionDbPath);
    specified.add("sessionDbPath");
  }
  return { config: cfg, file, specified, help: false };
}
