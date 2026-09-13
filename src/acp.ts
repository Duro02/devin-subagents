import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export type Json = Record<string, unknown>;

export interface SessionUpdate {
  sessionId: string;
  update: Json;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  requestId: number | string;
  sessionId: string;
  toolCall: Json;
  options: PermissionOption[];
}

interface PendingCall {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Max wait for a non-prompt RPC response (initialize, session/new,
   * session/load, session/list, session/set_mode, ...). session/prompt is
   * deliberately unbounded: a turn may legitimately run for many minutes.
   * 0 disables timeouts entirely.
   */
  rpcTimeoutMs?: number;
}

const PROTOCOL_VERSION = 1;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Minimal ACP (Agent Client Protocol) client over stdio NDJSON.
 *
 * Owns exactly one `devin acp` child process. Multiple ACP sessions are
 * multiplexed over this single connection. The bridge deliberately advertises
 * no fs/terminal client capabilities, so the agent performs file edits and
 * shell commands in-process; the only agent->client request expected is
 * `session/request_permission`.
 *
 * The client self-heals: after the child exits or a start attempt fails, the
 * next ensureStarted() spawns a fresh process and redoes initialize.
 */
export class AcpClient {
  onSessionUpdate?: (u: SessionUpdate) => void;
  onPermissionRequest?: (r: PermissionRequest) => void;
  onAgentExit?: (code: number | null) => void;
  onLog?: (line: string) => void;

  private child?: ChildProcess;
  private rl?: Interface;
  private seq = 0;
  private pending = new Map<number, PendingCall>();
  private permissionRequests = new Map<number | string, PermissionRequest>();
  private starting?: Promise<void>;
  private exited = false;

  constructor(private opts: AcpClientOptions) {}

  /**
   * Lazily spawn `devin acp` and complete the initialize handshake.
   * Safe to call concurrently; respawns the agent after exit or a failed
   * previous attempt instead of returning a stale settled promise.
   */
  async ensureStarted(): Promise<void> {
    if (this.starting && this.child && !this.exited) return this.starting;
    const p = this.doStart();
    this.starting = p;
    try {
      await p;
    } catch (e) {
      // Do not cache a failed start: the next caller must retry with a
      // fresh process rather than reawait a dead promise.
      if (this.starting === p) this.starting = undefined;
      throw e;
    }
  }

  private async doStart(): Promise<void> {
    this.rl?.removeAllListeners();
    this.rl?.close();
    this.exited = false;
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) this.onLog?.(line);
      }
    });
    // stdin 'error' (EPIPE etc.) must be handled or it would throw
    // asynchronously; the subsequent 'exit' performs the real cleanup.
    child.stdin?.on("error", (err) => {
      this.onLog?.(`acp stdin: ${err.message}`);
    });
    // Handlers are bound to THIS child: a previous incarnation's late
    // error/exit must never poison the new process's state.
    child.on("error", (err) => {
      if (child !== this.child) return;
      this.failAll(
        new Error(`failed to spawn ${this.opts.command}: ${err.message}`),
      );
    });
    child.on("exit", (code) => {
      if (child !== this.child) return;
      this.exited = true;
      this.failAll(new Error(`agent process exited with code ${code}`));
      this.onAgentExit?.(code);
    });

    this.rl = createInterface({ input: child.stdout!, terminal: false });
    this.rl.on("line", (line) => this.handleLine(line));

    try {
      await this.call(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "devin-subagents", version: "0.5.0" },
        },
        this.timeoutMs(),
      );
    } catch (e) {
      // A process that cannot finish initialize is wedged; drop it so the
      // next ensureStarted starts clean rather than reusing a broken pipe.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      throw e;
    }
  }

  isAlive(): boolean {
    return !!this.child && !this.exited;
  }

  kill(): void {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  // ---- ACP agent methods ----

  newSession(cwd: string): Promise<Json> {
    return this.call("session/new", { cwd, mcpServers: [] }, this.timeoutMs());
  }

  loadSession(sessionId: string, cwd: string): Promise<Json> {
    return this.call(
      "session/load",
      { sessionId, cwd, mcpServers: [] },
      this.timeoutMs(),
    );
  }

  listSessions(cwd?: string): Promise<Json> {
    return this.call("session/list", cwd ? { cwd } : {}, this.timeoutMs());
  }

  /**
   * session/set_mode. Some agents (devin) route config through
   * set_config_option instead — on "method not found" we retry that way
   * with configId "mode".
   */
  async setMode(sessionId: string, modeId: string): Promise<Json> {
    try {
      return await this.call(
        "session/set_mode",
        { sessionId, modeId },
        this.timeoutMs(),
      );
    } catch (e) {
      if (e instanceof Error && /method not found|unknown method/i.test(e.message)) {
        return this.setConfigOption(sessionId, "mode", modeId);
      }
      throw e;
    }
  }

  /**
   * session/set_config_option — the verified way devin applies model
   * selection ({configId:"model", value:"swe-2-high"}; the response echoes
   * configOptions with the confirmed currentValue).
   */
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<Json> {
    return this.call(
      "session/set_config_option",
      { sessionId, configId, value },
      this.timeoutMs(),
    );
  }

  /**
   * Resolves with { stopReason } when the turn ends. Intentionally has no
   * RPC timeout — a turn can legitimately run for a very long time.
   */
  prompt(sessionId: string, text: string): Promise<Json> {
    return this.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  answerPermission(requestId: number | string, optionId: string): void {
    this.respond(requestId, {
      outcome: { outcome: "selected", optionId },
    });
    this.permissionRequests.delete(requestId);
  }

  cancelPermission(requestId: number | string): void {
    this.respond(requestId, { outcome: { outcome: "cancelled" } });
    this.permissionRequests.delete(requestId);
  }

  pendingPermission(requestId: number | string): PermissionRequest | undefined {
    return this.permissionRequests.get(requestId);
  }

  // ---- transport ----

  private timeoutMs(): number | undefined {
    const t = this.opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    return t > 0 ? t : undefined;
  }

  private call(method: string, params: Json, timeoutMs?: number): Promise<Json> {
    if (!this.child?.stdin?.writable || this.exited) {
      return Promise.reject(new Error("agent process is not running"));
    }
    const id = ++this.seq;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise<Json>((resolve, reject) => {
      const p: PendingCall = { resolve, reject, method };
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      try {
        this.child!.stdin!.write(JSON.stringify(msg) + "\n");
      } catch (e) {
        if (p.timer) clearTimeout(p.timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private write(msg: Json): void {
    try {
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(JSON.stringify(msg) + "\n");
      }
    } catch {
      /* peer is gone; callers surface errors via the request path */
    }
  }

  private notify(method: string, params: Json): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number | string, result: Json): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Json;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.onLog?.(`acp: non-JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }

    if (typeof msg.method === "string") {
      if (msg.id !== undefined) this.handleAgentRequest(msg);
      else this.handleAgentNotification(msg);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { code?: number; message?: string };
        p.reject(new Error(`${p.method} failed: ${e.message ?? JSON.stringify(e)}`));
      } else {
        p.resolve((msg.result ?? {}) as Json);
      }
    }
  }

  private handleAgentNotification(msg: Json): void {
    if (msg.method === "session/update") {
      const params = (msg.params ?? {}) as Json;
      this.onSessionUpdate?.({
        sessionId: String(params.sessionId ?? ""),
        update: (params.update ?? {}) as Json,
      });
    }
  }

  private handleAgentRequest(msg: Json): void {
    const id = msg.id as number | string;
    const params = (msg.params ?? {}) as Json;
    if (msg.method === "session/request_permission") {
      const req: PermissionRequest = {
        requestId: id,
        sessionId: String(params.sessionId ?? ""),
        toolCall: (params.toolCall ?? {}) as Json,
        options: Array.isArray(params.options)
          ? (params.options as PermissionOption[])
          : [],
      };
      this.permissionRequests.set(id, req);
      this.onPermissionRequest?.(req);
      return;
    }
    // We advertise no fs/terminal/elicitation capabilities; anything else is
    // unexpected. Always answer so the agent never blocks on us.
    this.respondError(id, -32601, `unsupported agent request: ${String(msg.method)}`);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.permissionRequests.clear();
  }
}
