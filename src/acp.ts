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
}

export interface AcpClientOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

const PROTOCOL_VERSION = 1;

/**
 * Minimal ACP (Agent Client Protocol) client over stdio NDJSON.
 *
 * Owns exactly one `devin acp` child process. Multiple ACP sessions are
 * multiplexed over this single connection. The bridge deliberately advertises
 * no fs/terminal client capabilities, so the agent performs file edits and
 * shell commands in-process; the only agent->client request expected is
 * `session/request_permission`.
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

  /** Lazily spawn `devin acp` and complete the initialize handshake once. */
  async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.exited = false;
    const child = spawn(this.opts.bin, this.opts.args, {
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
    child.on("error", (err) => {
      this.failAll(new Error(`failed to spawn ${this.opts.bin}: ${err.message}`));
    });
    child.on("exit", (code) => {
      this.exited = true;
      this.failAll(new Error(`devin acp exited with code ${code}`));
      this.onAgentExit?.(code);
    });

    this.rl = createInterface({ input: child.stdout!, terminal: false });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.call("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "devin-subagents", version: "0.1.0" },
    });
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
    return this.call("session/new", { cwd, mcpServers: [] });
  }

  loadSession(sessionId: string, cwd: string): Promise<Json> {
    return this.call("session/load", { sessionId, cwd, mcpServers: [] });
  }

  listSessions(cwd?: string): Promise<Json> {
    return this.call("session/list", cwd ? { cwd } : {});
  }

  setMode(sessionId: string, modeId: string): Promise<Json> {
    return this.call("session/set_mode", { sessionId, modeId });
  }

  setModel(sessionId: string, modelId: string): Promise<Json> {
    return this.call("session/set_model", { sessionId, modelId });
  }

  /** Resolves with { stopReason } when the turn ends. */
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

  private call(method: string, params: Json): Promise<Json> {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("devin acp is not running"));
    }
    const id = ++this.seq;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.child!.stdin!.write(JSON.stringify(msg) + "\n");
    });
  }

  private notify(method: string, params: Json): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  private respond(id: number | string, result: Json): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
    );
  }

  private respondError(id: number | string, code: number, message: string): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
    );
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
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const req of this.permissionRequests.values()) {
      this.permissionRequests.delete(req.requestId);
    }
  }
}
