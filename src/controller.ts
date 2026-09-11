import { AcpClient, type Json, type PermissionRequest } from "./acp.js";
import { Registry } from "./registry.js";

export interface ControllerConfig {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  statePath: string;
  /** auto = pick allow_once; always = pick allow_always; operator = queue for devin_permission */
  permissionPolicy: "auto" | "always" | "operator";
  /** default mode applied at session/new when the agent advertises it (e.g. "bypass") */
  defaultMode?: string;
}

export class Controller {
  readonly acp: AcpClient;
  readonly registry: Registry;

  constructor(private cfg: ControllerConfig) {
    this.registry = new Registry(cfg.statePath);
    this.acp = new AcpClient({
      bin: cfg.bin,
      args: cfg.args,
      cwd: cfg.cwd,
      env: cfg.env,
    });
    this.acp.onSessionUpdate = ({ sessionId, update }) => {
      const s = this.bySessionId(sessionId);
      if (!s) return;
      const kind =
        typeof update.sessionUpdate === "string"
          ? update.sessionUpdate
          : "update";
      this.registry.append(s.name, kind, update);
    };
    this.acp.onPermissionRequest = (req) => this.handlePermission(req);
    this.acp.onAgentExit = () => this.registry.markAllDead();
    this.acp.onLog = (line) => process.stderr.write(`[devin] ${line}\n`);
  }

  private bySessionId(sessionId: string) {
    for (const name of this.registry.names()) {
      const s = this.registry.get(name);
      if (s?.sessionId === sessionId) return s;
    }
    return undefined;
  }

  private require(name: string) {
    const s = this.registry.get(name);
    if (!s) {
      const persisted = this.registry.persisted()[name];
      const hint = persisted
        ? ` A persisted session "${name}" exists — call devin_resume first.`
        : "";
      throw new Error(`unknown subagent "${name}".${hint}`);
    }
    return s;
  }

  private handlePermission(req: PermissionRequest): void {
    const s = this.bySessionId(req.sessionId);
    const pick = (kinds: string[]) =>
      req.options.find((o) => kinds.includes(o.kind))?.optionId;

    if (this.cfg.permissionPolicy === "operator" && s) {
      this.registry.setPermission(s.name, req);
      this.registry.append(s.name, "permission_request", {
        requestId: req.requestId,
        toolCall: req.toolCall,
        options: req.options,
      });
      return;
    }
    const optionId =
      this.cfg.permissionPolicy === "always"
        ? (pick(["allow_always"]) ?? pick(["allow_once"]) ?? pick(["allow"]))
        : (pick(["allow_once"]) ?? pick(["allow_always"]) ?? pick(["allow"]));
    if (optionId !== undefined) {
      if (s)
        this.registry.append(s.name, "permission_auto", {
          requestId: req.requestId,
          toolCall: req.toolCall,
          optionId,
        });
      this.acp.answerPermission(req.requestId, optionId);
    } else {
      this.acp.cancelPermission(req.requestId);
    }
  }

  /** Fire a prompt turn in the background; result lands as a turn_end event. */
  private runTurn(name: string, sessionId: string, text: string): void {
    this.registry.mark(name, "running");
    this.registry.append(name, "turn_start", { text });
    this.acp
      .prompt(sessionId, text)
      .then((result) => {
        const stopReason = String(result.stopReason ?? "end_turn");
        this.registry.append(name, "turn_end", { stopReason, result });
        this.registry.mark(name, "idle", stopReason);
      })
      .catch((err: Error) => {
        this.registry.append(name, "turn_end", {
          stopReason: "error",
          error: err.message,
        });
        this.registry.mark(name, "idle", "error");
      });
  }

  async spawn(
    name: string,
    task: string,
    cwd?: string,
    mode?: string,
  ): Promise<Json> {
    if (this.registry.get(name)) {
      throw new Error(`subagent "${name}" already exists`);
    }
    await this.acp.ensureStarted();
    const workdir = cwd ?? this.cfg.cwd;
    const res = await this.acp.newSession(workdir);
    const sessionId = String(res.sessionId);
    const s = this.registry.register(name, sessionId, workdir);

    const wantMode = mode ?? this.cfg.defaultMode;
    if (wantMode && wantMode !== "default" && wantMode !== "none") {
      const modes = (res.modes as Json | undefined)?.availableModes as
        | { id: string }[]
        | undefined;
      if (modes?.some((m) => m.id === wantMode)) {
        await this.acp.setMode(sessionId, wantMode);
      } else {
        this.registry.append(name, "mode_skipped", {
          wanted: wantMode,
          available: modes?.map((m) => m.id) ?? [],
        });
      }
    }
    this.runTurn(name, s.sessionId, task);
    return { name, sessionId, status: s.status };
  }

  async send(name: string, text: string): Promise<Json> {
    const s = this.require(name);
    if (s.status === "dead") throw new Error(`"${name}" is dead; devin_resume it first`);
    this.runTurn(name, s.sessionId, text);
    return { name, status: "running" };
  }

  async poll(name: string, waitMs = 0, since?: number): Promise<Json> {
    const s = this.require(name);
    if (waitMs > 0 && s.head <= (since ?? s.readCursor) && s.status === "running") {
      await this.registry.waitForEvent(name, Math.min(waitMs, 60_000));
    }
    const d = this.registry.drain(name, since);
    return {
      name,
      status: s.status,
      lastStopReason: s.lastStopReason,
      events: d?.events ?? [],
      cursor: d?.cursor ?? 0,
      droppedEvents: d?.dropped ?? 0,
      pendingPermission: s.pendingPermission,
    };
  }

  interrupt(name: string): Json {
    const s = this.require(name);
    this.acp.cancel(s.sessionId);
    this.registry.append(name, "interrupt", {});
    return { name, status: s.status, note: "cancel sent" };
  }

  async resume(name: string): Promise<Json> {
    const existing = this.registry.get(name);
    const persisted = this.registry.persisted()[name];
    const rec = existing ?? persisted;
    if (!rec) throw new Error(`no session known for "${name}"`);
    await this.acp.ensureStarted();
    await this.acp.loadSession(rec.sessionId, rec.cwd);
    const s = existing ?? this.registry.revive(name, rec.sessionId, rec.cwd);
    this.registry.mark(name, "idle");
    this.registry.append(name, "resumed", { sessionId: s.sessionId });
    return { name, sessionId: s.sessionId, status: s.status };
  }

  stop(name: string): Json {
    const s = this.require(name);
    if (s.status === "running") this.acp.cancel(s.sessionId);
    this.registry.mark(name, "stopped");
    this.registry.persist();
    return { name, sessionId: s.sessionId, status: "stopped" };
  }

  permission(name: string, optionId?: string): Json {
    const s = this.require(name);
    const p = s.pendingPermission;
    if (!p) throw new Error(`no pending permission request on "${name}"`);
    if (optionId) {
      this.acp.answerPermission(p.requestId, optionId);
      this.registry.append(name, "permission_granted", { optionId });
    } else {
      this.acp.cancelPermission(p.requestId);
      this.registry.append(name, "permission_denied", {});
    }
    this.registry.clearPermission(name);
    return { name, answered: optionId ?? "cancelled" };
  }

  async setMode(name: string, modeId: string): Promise<Json> {
    const s = this.require(name);
    await this.acp.setMode(s.sessionId, modeId);
    return { name, mode: modeId };
  }

  async list(): Promise<Json> {
    const live = this.registry.names().map((n) => {
      const s = this.registry.get(n)!;
      return {
        name: n,
        sessionId: s.sessionId,
        cwd: s.cwd,
        status: s.status,
        lastStopReason: s.lastStopReason,
      };
    });
    const persisted = Object.entries(this.registry.persisted())
      .filter(([n]) => !this.registry.get(n))
      .map(([n, v]) => ({ name: n, ...v, status: "persisted" }));
    let remote: unknown = null;
    if (this.acp.isAlive()) {
      try {
        remote = await this.acp.listSessions();
      } catch {
        remote = null;
      }
    }
    return { subagents: [...live, ...persisted], agentSessions: remote };
  }
}
