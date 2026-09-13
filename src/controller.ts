import { statSync } from "node:fs";
import path from "node:path";
import { AcpClient, type Json, type PermissionRequest } from "./acp.js";
import { projectEvents } from "./project.js";
import { buildSnapshot } from "./observe.js";
import { Registry, type SubSession } from "./registry.js";
import { SessionDb } from "./sessiondb.js";

export interface ControllerConfig {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  statePath: string;
  /** auto = pick allow_once; always = pick allow_always; operator = queue for permission */
  permission: "auto" | "always" | "operator";
  /** default mode applied at session/new (e.g. "smart") */
  mode?: string;
  /** default model confirmed at session/new (e.g. "swe-2-max") */
  model?: string;
  /**
   * When `mode` comes from a config file it is deliberate: an
   * unadvertised value then rejects the spawn (per-call params are always
   * strict). Built-in defaults degrade to *_skipped events. Models are
   * always strict at spawn — a session must never silently run an ambient
   * model the caller didn't choose.
   */
  modeStrict?: boolean;
  /** timeout for non-prompt agent RPCs (session/prompt is unbounded) */
  rpcTimeoutMs?: number;
  /** per-session event ring buffer size */
  bufferCap?: number;
  /**
   * mark managed sessions hidden=1 in devin's session DB so they stay out
   * of user-facing session lists (/resume, `devin list`, agent-side
   * session/list). The flag is flipped directly in
   * `<data-dir>/devin/cli/sessions.db` — `session/new` has no switch for
   * it. Hidden sessions still `session/load` fine, so bridge resume is
   * unaffected; the interactive `devin -r <id>` lookup no longer resolves
   * them. Best-effort: a missing/old-schema DB disables the feature
   * silently (one log line), never a tool call.
   */
  hideFromSessionList: boolean;
  /** devin session DB override; default = platform data dir path */
  sessionDbPath?: string;
  onLog?: (line: string) => void;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_RE = /^[^\s\\]{1,128}$/;
const MAX_TEXT = 256_000;
const QUEUE_CAP = 32;
/** Sentinels accepted for mode/model: "use the agent's own default". */
const NO_SET = new Set(["default", "none"]);

function vName(name: string): void {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(
      `invalid subagent name "${name}" — use 1-64 chars from [A-Za-z0-9._-], starting with a letter or digit`,
    );
  }
}

function vText(text: unknown, what: string): asserts text is string {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(`${what} must be a non-empty string`);
  }
  if (text.length > MAX_TEXT) {
    throw new Error(`${what} exceeds ${MAX_TEXT} chars`);
  }
}

function vCwd(cwd: string): string {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd must be an absolute path, got "${cwd}"`);
  }
  let st;
  try {
    st = statSync(cwd);
  } catch {
    throw new Error(`cwd "${cwd}" does not exist`);
  }
  if (!st.isDirectory()) throw new Error(`cwd "${cwd}" is not a directory`);
  return cwd;
}

function vId(id: string, what: string): void {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error(`invalid ${what} "${id}" (1-128 chars, no whitespace)`);
  }
}

export class Controller {
  readonly acp: AcpClient;
  readonly registry: Registry;
  /** last-advertised agent-level capabilities (any session) */
  private agentModes?: string[];
  private agentModels?: string[];
  private agentMode?: string;
  private agentModel?: string;
  private sessionDb?: SessionDb;
  /** session ids offered to sessionDb but not yet confirmed hidden */
  private hiddenPending = new Set<string>();
  /** session ids confirmed hidden (by us or already flagged) */
  private hiddenDone = new Set<string>();

  constructor(private cfg: ControllerConfig) {
    this.registry = new Registry(cfg.statePath, {
      bufferCap: cfg.bufferCap,
      onLog: cfg.onLog,
    });
    this.acp = new AcpClient({
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      env: cfg.env,
      rpcTimeoutMs: cfg.rpcTimeoutMs,
    });
    this.acp.onSessionUpdate = ({ sessionId, update }) => {
      const s = this.bySessionId(sessionId);
      if (!s) return;
      const kind =
        typeof update.sessionUpdate === "string"
          ? update.sessionUpdate
          : "update";
      if (kind === "current_mode_update" && update.currentModeId !== undefined) {
        s.currentMode = String(update.currentModeId);
      }
      if (kind === "config_option_update") {
        this.applyConfigOptions(s, update);
      }
      this.registry.append(s.name, kind, update);
    };
    this.acp.onPermissionRequest = (req) => this.handlePermission(req);
    this.acp.onAgentExit = (code) => this.registry.markAllDead(code);
    this.acp.onLog =
      cfg.onLog ?? ((line) => process.stderr.write(`[devin] ${line}\n`));
    if (cfg.hideFromSessionList) {
      this.sessionDb = new SessionDb(
        cfg.sessionDbPath ?? SessionDb.defaultPath(),
        cfg.onLog,
      );
    }
  }

  /**
   * Offer a session id for hiding; rows persist lazily (first prompt), so
   * unconfirmed ids stay pending and every flushHidden() call retries.
   */
  private trackHidden(sessionId: string): void {
    if (!this.sessionDb || this.hiddenDone.has(sessionId)) return;
    this.hiddenPending.add(sessionId);
    this.flushHidden();
  }

  private flushHidden(): void {
    if (!this.sessionDb || this.hiddenPending.size === 0) return;
    for (const id of this.sessionDb.markHidden([...this.hiddenPending])) {
      this.hiddenPending.delete(id);
      this.hiddenDone.add(id);
    }
  }

  private bySessionId(sessionId: string) {
    if (!sessionId) return undefined;
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
        ? ` A persisted session "${name}" exists — call resume first.`
        : "";
      throw new Error(`unknown subagent "${name}".${hint}`);
    }
    return s;
  }

  private handlePermission(req: PermissionRequest): void {
    const s = this.bySessionId(req.sessionId);
    const pick = (kinds: string[]) =>
      req.options.find((o) => kinds.includes(o.kind))?.optionId;

    if (this.cfg.permission === "operator") {
      if (!s) {
        // Can't surface it to the operator — deny rather than auto-allow.
        this.acp.cancelPermission(req.requestId);
        return;
      }
      if (s.pendingPermission) {
        // A session can only have one meaningful pending request; the older
        // one is stale — cancel it so the agent is never left hanging.
        this.acp.cancelPermission(s.pendingPermission.requestId);
        this.registry.append(s.name, "permission_superseded", {
          requestId: s.pendingPermission.requestId,
        });
      }
      this.registry.setPermission(s.name, req);
      this.registry.append(s.name, "permission_request", {
        requestId: req.requestId,
        toolCall: req.toolCall,
        options: req.options,
      });
      return;
    }
    const optionId =
      this.cfg.permission === "always"
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

  /**
   * Serialized turn runner: at most one session/prompt is in flight per
   * session. `send` during a turn enqueues; when the active turn resolves we
   * pop the next text and start it as a new turn. Completions are guarded by
   * the turn id so a stale/overtaken result can never flip status.
   */
  private runTurn(s: SubSession, text: string): void {
    const turn = ++s.turnSeq;
    s.activeTurn = turn;
    this.registry.mark(s.name, "running");
    this.registry.append(s.name, "turn_start", { text, turn });
    this.acp.prompt(s.sessionId, text).then(
      (result) =>
        this.endTurn(s, turn, String(result.stopReason ?? "end_turn"), {
          result,
        }),
      (err: Error) => this.endTurn(s, turn, "error", { error: err.message }),
    );
  }

  private endTurn(
    s: SubSession,
    turn: number,
    stopReason: string,
    extra: Json,
  ): void {
    if (this.registry.get(s.name) !== s) return; // session released/respawned
    this.registry.append(s.name, "turn_end", { turn, stopReason, ...extra });
    if (s.activeTurn !== turn) return; // superseded; another path owns status
    s.activeTurn = 0;
    if (s.status === "stopped" || s.status === "dead") {
      s.queue = []; // a late settle never runs queued prompts
      return;
    }
    if (s.queue.length > 0) {
      if (!s.configuring) {
        this.runTurn(s, s.queue.shift()!);
      }
      // else a set_mode/set_model RPC is in flight: it drains the queue
      // when it resolves; status stays "running" until then.
      return;
    }
    // records lastStopReason even when already idle (e.g. resumed while the
    // cancelled prompt was still settling)
    this.registry.mark(s.name, "idle", stopReason);
  }

  /** Start the next queued prompt if nothing is running/configuring. */
  private drainQueue(s: SubSession): void {
    if (
      s.activeTurn === 0 &&
      s.queue.length > 0 &&
      (s.status === "running" || s.status === "idle")
    ) {
      this.runTurn(s, s.queue.shift()!);
    }
  }

  /** Mode/model capabilities from session/new or session/load results. */
  private recordCaps(s: SubSession, res: Json): void {
    const modes = res.modes as
      | { availableModes?: ({ id?: string } | string)[]; currentModeId?: string }
      | undefined;
    if (modes?.availableModes) {
      s.availableModes = modes.availableModes
        .map((m) => (typeof m === "string" ? m : String(m.id ?? "")))
        .filter(Boolean);
    }
    if (modes?.currentModeId !== undefined) {
      s.currentMode = String(modes.currentModeId);
    }
    const models = res.models as
      | {
          availableModels?: ({ id?: string; modelId?: string } | string)[];
          currentModelId?: string;
        }
      | undefined;
    if (models?.availableModels) {
      s.availableModels = models.availableModels
        .map((m) =>
          typeof m === "string" ? m : String(m.modelId ?? m.id ?? ""),
        )
        .filter(Boolean);
    }
    if (models?.currentModelId !== undefined) {
      s.currentModel = String(models.currentModelId);
    }
    // devin additionally surfaces select-style configOptions (model picker
    // etc.); use them to fill any gaps the typed fields didn't cover.
    this.applyConfigOptions(s, res);
    this.mergeAgentCaps(s);
  }

  /** Keep the last-seen agent-level caps for the `models` tool. */
  private mergeAgentCaps(s: SubSession): void {
    if (s.availableModes) this.agentModes = s.availableModes;
    if (s.availableModels) this.agentModels = s.availableModels;
    if (s.currentMode) this.agentMode = s.currentMode;
    if (s.currentModel) this.agentModel = s.currentModel;
  }

  private applyConfigOptions(s: SubSession, carrier: Json): void {
    const list = carrier.configOptions;
    if (!Array.isArray(list)) return;
    for (const o of list as Json[]) {
      // token match on category/id/name — "model" contains "mode" as a
      // substring, so includes() would collide
      const tokens = `${o.category ?? ""} ${o.id ?? ""} ${o.name ?? ""}`
        .toLowerCase()
        .split(/[\s_-]+/);
      const opts = Array.isArray(o.options) ? (o.options as Json[]) : [];
      const values = opts
        .map((v) =>
          typeof v === "string"
            ? v
            : String(v.value ?? v.id ?? v.name ?? ""),
        )
        .filter(Boolean);
      // config_option_update echoes are authoritative — update
      // unconditionally (an async update may arrive after a set_*).
      if (tokens.includes("model")) {
        if (values.length) s.availableModels = values;
        if (o.currentValue !== undefined) {
          s.currentModel = String(o.currentValue);
        }
      } else if (tokens.includes("mode")) {
        if (values.length) s.availableModes = values;
        if (o.currentValue !== undefined) {
          s.currentMode = String(o.currentValue);
        }
      }
    }
    this.mergeAgentCaps(s);
  }

  /**
   * Extract the agent-confirmed value of a config option from a
   * set_config_option response's echoed configOptions (match = "model").
   * Returns undefined when the response carries no such option.
   */
  private confirmedConfigValue(res: Json, match: string): string | undefined {
    const list = res.configOptions;
    if (!Array.isArray(list)) return undefined;
    for (const o of list as Json[]) {
      // token match: "model" must not hit a "mode" lookup ("model" contains
      // "mode" as a substring — includes() would collide)
      const tokens = `${o.category ?? ""} ${o.id ?? ""} ${o.name ?? ""}`
        .toLowerCase()
        .split(/[\s_-]+/);
      if (tokens.includes(match)) {
        const v = o.currentValue ?? o.value;
        if (v !== undefined) return String(v);
      }
    }
    return undefined;
  }

  /**
   * Apply a wanted mode/model after session creation/load. Mode: when the
   * caller explicitly asked (`strict`), an unadvertised value or a set_*
   * failure rejects the call; configured defaults degrade to
   * *_skipped/*_failed events. Model additionally requires the agent to
   * echo the exact value — `requireModel` (spawn) makes any failure fatal
   * so a session never silently runs an ambient model; resume passes
   * false to degrade gracefully when re-asserting a saved selection.
   */
  private async applyCaps(
    s: SubSession,
    wantMode: string | undefined,
    wantModel: string | undefined,
    strictMode: boolean,
    requireModel: boolean,
  ): Promise<void> {
    const apply = async (
      what: "mode" | "model",
      want: string | undefined,
      available: string[] | undefined,
      strict: boolean,
    ): Promise<void> => {
      if (!want || NO_SET.has(want)) return;
      const current = what === "mode" ? s.currentMode : s.currentModel;
      if (current === want) return;
      const fatal = strict || (what === "model" && requireModel);
      if (!available?.includes(want)) {
        const detail = `${what} "${want}" not advertised by the agent (available: ${available?.join(", ") || "none"})`;
        if (fatal) throw new Error(`spawn "${s.name}": ${detail}`);
        this.registry.append(s.name, `${what}_skipped`, {
          wanted: want,
          available: available ?? [],
        });
        return;
      }
      try {
        if (what === "mode") {
          const res = await this.acp.setMode(s.sessionId, want);
          const confirmed = this.confirmedConfigValue(res, "mode");
          if (confirmed !== undefined && confirmed !== want) {
            throw new Error(
              `agent confirmed mode "${confirmed}", wanted "${want}"`,
            );
          }
          s.currentMode = confirmed ?? want;
        } else {
          // devin applies model selection via session/set_config_option
          // (session/set_model is not implemented) and echoes the new
          // currentValue in configOptions. No echo = no confirmation =
          // error; never claim a model the agent didn't confirm.
          const res = await this.acp.setConfigOption(
            s.sessionId,
            "model",
            want,
          );
          const confirmed = this.confirmedConfigValue(res, "model");
          if (confirmed !== want) {
            throw new Error(
              confirmed === undefined
                ? `agent did not confirm model "${want}"`
                : `agent confirmed model "${confirmed}", wanted "${want}"`,
            );
          }
          s.currentModel = confirmed;
          this.agentModel = confirmed;
        }
      } catch (e) {
        if (fatal) throw e;
        this.registry.append(s.name, `${what}_failed`, {
          wanted: want,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };
    await apply("mode", wantMode, s.availableModes, strictMode);
    await apply("model", wantModel, s.availableModels, requireModel);
  }

  async spawn(
    name: string,
    task: string,
    cwd?: string,
    mode?: string,
    model?: string,
  ): Promise<Json> {
    vName(name);
    vText(task, "task");
    const workdir = cwd !== undefined ? vCwd(cwd) : this.cfg.cwd;
    if (mode !== undefined) vId(mode, "mode");
    if (model !== undefined) vId(model, "model");
    // Synchronous claim before any await: concurrent spawns of the same
    // name can never both reach session/new.
    const s = this.registry.claim(name); // live dupe -> "already exists"
    if (this.registry.persisted()[name]) {
      this.registry.release(name);
      throw new Error(
        `subagent "${name}" is persisted from an earlier run — call resume instead (or pick a different name)`,
      );
    }
    s.cwd = workdir;
    try {
      await this.acp.ensureStarted();
      const res = await this.acp.newSession(workdir);
      const sessionId = String(res.sessionId);
      // Keep status "starting" through capability setup: a racing send
      // must queue behind the initial prompt, not overtake it before the
      // model is applied.
      s.sessionId = sessionId;
      s.cwd = workdir;
      this.recordCaps(s, res);
      // priority: per-call arg > config-file value > built-in default.
      // Per-call and file-specified modes are strict; models always
      // require exact agent confirmation — an unconfirmed/unavailable
      // model fails the spawn rather than running an ambient one.
      await this.applyCaps(
        s,
        mode ?? this.cfg.mode,
        model ?? this.cfg.model,
        mode !== undefined || this.cfg.modeStrict === true,
        /*requireModel*/ true,
      );
      this.registry.activate(name, sessionId, workdir);
      this.trackHidden(sessionId);
      this.runTurn(s, task);
      return {
        name,
        sessionId,
        status: s.status,
        turn: s.turnSeq,
        mode: s.currentMode,
        model: s.currentModel,
      };
    } catch (e) {
      // Forget any half-created record so the name is immediately reusable;
      // the orphaned agent-side session is still visible via list.
      this.registry.release(name, true);
      throw e;
    }
  }

  async send(name: string, text: string): Promise<Json> {
    const s = this.require(name);
    vText(text, "text");
    if (s.status === "dead") {
      throw new Error(`"${name}" is dead; resume it first`);
    }
    if (s.status === "stopped") {
      throw new Error(`"${name}" is stopped; resume it first`);
    }
    if (s.status === "starting" || s.activeTurn !== 0 || s.configuring) {
      // A turn is in flight — including a just-cancelled prompt whose reply
      // hasn't landed yet — or a mode/model change is being applied.
      // Enqueue FIFO; it starts when the turn/config settles.
      if (s.queue.length >= QUEUE_CAP) {
        throw new Error(`"${name}" queue is full (${QUEUE_CAP} pending)`);
      }
      s.queue.push(text);
      this.registry.append(name, "queued", {
        text,
        position: s.queue.length,
      });
      return {
        name,
        status: s.status,
        queued: true,
        position: s.queue.length,
      };
    }
    this.runTurn(s, text);
    return { name, status: "running", queued: false, turn: s.turnSeq };
  }

  /**
   * detail: "inspect" (default) = persistent snapshot of what the agent is
   * doing — lifecycle fields plus turn timing, last output, active tool
   * calls, current plan step, latest text, latest error and activity ages.
   * It never reads or moves the log cursor and survives buffer eviction.
   * "logs" = chronological normalized event entries (seq + bridge receipt
   * `at`), paged by an implicit read cursor; `limit` bounds each page and
   * nextCursor/hasMore continue it — bounded pages never skip unconsumed
   * records. An explicit `since` replays without moving the cursor.
   *
   * wait_ms: inspect waits for events newer than `since` (a snapshot cursor
   * from an earlier inspect) or — when `since` is omitted — newer than the
   * head captured at call time, so unread logs never force a busy return.
   * logs waits only when nothing new sits past the effective read cursor.
   */
  async poll(
    name: string,
    waitMs = 0,
    since?: number,
    detail: "inspect" | "logs" = "inspect",
    limit?: number,
  ): Promise<Json> {
    const s = this.require(name);
    this.flushHidden();
    if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
      throw new Error(`since must be a non-negative integer, got ${since}`);
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error(`limit must be a positive integer, got ${limit}`);
    }
    const wait = Math.max(0, Math.min(waitMs, 60_000));
    const canWait =
      s.status === "running" ||
      s.status === "starting" ||
      s.activeTurn !== 0; // a cancelled prompt may still be settling
    if (wait > 0 && canWait) {
      const baseline =
        detail === "logs" ? (since ?? s.readCursor) : (since ?? s.head);
      if (s.head <= baseline) {
        await this.registry.waitForEvent(name, wait);
      }
    }
    // the session may have been released while we waited (failed spawn)
    const cur = this.registry.get(name) ?? s;
    const base: Json = {
      name,
      status: cur.status,
      lastStopReason: cur.lastStopReason,
      pendingPermission: cur.pendingPermission,
      turn: cur.turnSeq,
      activeTurn: cur.activeTurn,
      queued: cur.queue.length,
      mode: cur.currentMode,
      model: cur.currentModel,
    };
    if (detail === "logs") {
      const d = this.registry.drain(name, { since, limit });
      return {
        ...base,
        events: projectEvents(d?.events ?? []),
        nextCursor: d?.nextCursor ?? 0,
        hasMore: d?.hasMore ?? false,
        droppedEvents: d?.dropped ?? 0,
      };
    }
    const now = Date.now();
    return {
      ...base,
      cursor: cur.head, // snapshot version — pass back as `since` to wait on change
      capturedAt: new Date(now).toISOString(),
      snapshot: buildSnapshot(cur.obs, now),
    };
  }

  interrupt(name: string): Json {
    const s = this.require(name);
    if (s.status === "starting") {
      throw new Error(`"${name}" is still starting; wait for spawn to finish`);
    }
    if (s.status === "dead") {
      throw new Error(`"${name}" is dead; resume it first`);
    }
    const droppedQueue = s.queue.length;
    s.queue = [];
    this.cancelPending(s);
    this.acp.cancel(s.sessionId);
    this.registry.append(name, "interrupt", { droppedQueue });
    return {
      name,
      status: s.status,
      note: s.status === "running" ? "cancel sent" : "no active turn",
    };
  }

  async resume(name: string): Promise<Json> {
    const s = this.registry.get(name);
    if (s) {
      if (s.status === "starting") {
        return { name, status: "starting", note: "spawn/load still in flight" };
      }
      if (s.status === "running") {
        return {
          name,
          sessionId: s.sessionId,
          status: "running",
          note: "already running",
        };
      }
      if (
        (s.status === "idle" || s.status === "stopped") &&
        this.acp.isAlive()
      ) {
        // Session is still loaded in the live agent — a local state flip.
        // If a cancelled prompt is still settling (activeTurn pending) the
        // session is still busy: report running so poll/send reflect that
        // work remains until the reply lands and the queue drains.
        const busy = s.activeTurn !== 0;
        this.trackHidden(s.sessionId);
        this.registry.mark(name, busy ? "running" : "idle");
        this.registry.append(name, "resumed", {
          sessionId: s.sessionId,
          alreadyLoaded: true,
        });
        return {
          name,
          sessionId: s.sessionId,
          status: busy ? "running" : "idle",
        };
      }
      // dead (or the agent silently went away): reload via session/load.
      // Defaults apply to NEW sessions only — a resumed session keeps its
      // own selection, so capture it before recordCaps overwrites from the
      // load response and re-assert it if the agent forgot.
      const ownMode = s.currentMode;
      const ownModel = s.currentModel;
      await this.acp.ensureStarted();
      const res = await this.acp.loadSession(s.sessionId, s.cwd);
      this.recordCaps(s, res);
      await this.applyCaps(s, ownMode, ownModel, false, false);
      this.trackHidden(s.sessionId);
      this.registry.mark(name, "idle");
      this.registry.append(name, "resumed", { sessionId: s.sessionId });
      return { name, sessionId: s.sessionId, status: "idle" };
    }
    const rec = this.registry.persisted()[name];
    if (!rec) throw new Error(`no session known for "${name}"`);
    vCwd(rec.cwd);
    const claim = this.registry.claim(name);
    try {
      await this.acp.ensureStarted();
      const res = await this.acp.loadSession(rec.sessionId, rec.cwd);
      const s2 = this.registry.activate(name, rec.sessionId, rec.cwd);
      this.trackHidden(s2.sessionId);
      this.recordCaps(s2, res);
      // re-assert the session's persisted selection, not bridge defaults
      await this.applyCaps(s2, rec.mode, rec.model, false, false);
      this.registry.mark(name, "idle");
      this.registry.append(name, "resumed", { sessionId: s2.sessionId });
      return { name, sessionId: s2.sessionId, status: "idle" };
    } catch (e) {
      this.registry.release(name);
      throw e;
    }
  }

  /** Cancel a stale pending permission request, if any. */
  private cancelPending(s: SubSession): void {
    if (!s.pendingPermission) return;
    this.acp.cancelPermission(s.pendingPermission.requestId);
    this.registry.clearPermission(s.name);
  }

  stop(name: string): Json {
    const s = this.require(name);
    if (s.status === "starting") {
      throw new Error(`"${name}" is still starting; wait for spawn to finish`);
    }
    const droppedQueue = s.queue.length;
    s.queue = [];
    this.cancelPending(s);
    if (s.status === "running") this.acp.cancel(s.sessionId);
    this.registry.append(name, "stopped", { droppedQueue });
    this.registry.mark(name, "stopped");
    this.registry.persist();
    return { name, sessionId: s.sessionId, status: "stopped" };
  }

  permission(name: string, optionId?: string): Json {
    const s = this.require(name);
    const p = s.pendingPermission;
    if (!p) throw new Error(`no pending permission request on "${name}"`);
    if (!this.acp.pendingPermission(p.requestId)) {
      this.registry.clearPermission(name);
      throw new Error(
        `permission request on "${name}" is stale (agent restarted or turn ended)`,
      );
    }
    if (optionId !== undefined) {
      const opt = p.options.find((o) => o.optionId === optionId);
      if (!opt) {
        throw new Error(
          `unknown optionId "${optionId}" for "${name}"; valid: ${
            p.options.map((o) => o.optionId).join(", ") || "(none)"
          }`,
        );
      }
      this.acp.answerPermission(p.requestId, optionId);
      const kind = opt.kind ?? "";
      const ev = kind.startsWith("allow")
        ? "permission_granted"
        : kind.startsWith("deny") || kind.startsWith("reject")
          ? "permission_denied"
          : "permission_answered";
      this.registry.append(name, ev, {
        requestId: p.requestId,
        optionId,
        kind,
      });
    } else {
      this.acp.cancelPermission(p.requestId);
      this.registry.append(name, "permission_denied", {
        requestId: p.requestId,
      });
    }
    this.registry.clearPermission(name);
    return { name, answered: optionId ?? "cancelled" };
  }

  async setMode(name: string, modeId: string): Promise<Json> {
    const s = this.require(name);
    vId(modeId, "mode");
    if (s.status === "starting") {
      throw new Error(`"${name}" is still starting; wait for spawn to finish`);
    }
    if (s.status === "dead") {
      throw new Error(`"${name}" is dead; resume it first`);
    }
    if (s.availableModes && !s.availableModes.includes(modeId)) {
      throw new Error(
        `unknown mode "${modeId}" for "${name}"; available: ${s.availableModes.join(", ")}`,
      );
    }
    if (s.configuring) {
      throw new Error(`"${name}" has a config change in flight; retry after it settles`);
    }
    s.configuring = true;
    try {
      const res = await this.acp.setMode(s.sessionId, modeId);
      const confirmed = this.confirmedConfigValue(res, "mode");
      s.currentMode = confirmed ?? modeId;
      this.agentMode = s.currentMode;
      this.registry.persist(); // keep the session's selection across restarts
    } finally {
      s.configuring = false;
      // prompts queued during the switch start now, on the new config
      this.drainQueue(s);
    }
    return { name, mode: s.currentMode };
  }

  /**
   * Switch an idle session's model via session/set_config_option and
   * confirm the echoed currentValue. Rejected on any non-idle status —
   * mutating a session mid-turn (or a stopped/dead one) is never implicit.
   */
  async setModel(name: string, modelId: string): Promise<Json> {
    const s = this.require(name);
    vId(modelId, "model");
    if (s.status !== "idle") {
      const why =
        s.status === "running"
          ? "has a turn in flight; wait for it to go idle"
          : s.status === "starting"
            ? "is still starting; wait for spawn to finish"
            : `is ${s.status}; resume it first`;
      throw new Error(`"${name}" ${why}`);
    }
    if (s.availableModels && !s.availableModels.includes(modelId)) {
      throw new Error(
        `unknown model "${modelId}" for "${name}"; available: ${s.availableModels.join(", ")}`,
      );
    }
    if (s.configuring) {
      throw new Error(`"${name}" has a config change in flight; retry after it settles`);
    }
    // Guard the switch: sends arriving while the RPC is in flight queue up
    // and start only after the new model is confirmed (or the call fails).
    s.configuring = true;
    try {
      const res = await this.acp.setConfigOption(s.sessionId, "model", modelId);
      const confirmed = this.confirmedConfigValue(res, "model");
      if (confirmed !== modelId) {
        throw new Error(
          confirmed === undefined
            ? `agent did not confirm model "${modelId}"`
            : `agent confirmed model "${confirmed}", not "${modelId}"`,
        );
      }
      s.currentModel = confirmed;
      this.agentModel = confirmed;
      this.registry.append(name, "model", { model: confirmed });
      this.registry.persist(); // keep the session's selection across restarts
    } finally {
      s.configuring = false;
      this.drainQueue(s);
    }
    return { name, model: s.currentModel };
  }

  /**
   * Advertised agent/session capabilities. With `name`, reports that
   * session's current and available models/modes; without it, the bridge's
   * configured defaults plus whatever any session has advertised so far
   * (null until the first session/new|load response is seen).
   */
  models(name?: string): Json {
    if (name !== undefined) {
      const s = this.require(name);
      return {
        name,
        model: s.currentModel ?? null,
        availableModels: s.availableModels ?? null,
        mode: s.currentMode ?? null,
        availableModes: s.availableModes ?? null,
      };
    }
    return {
      defaultModel: this.cfg.model ?? null,
      defaultMode: this.cfg.mode ?? null,
      currentModel: this.agentModel ?? null,
      currentMode: this.agentMode ?? null,
      availableModels: this.agentModels ?? null,
      availableModes: this.agentModes ?? null,
      discovered: this.agentModels !== undefined || this.agentModes !== undefined,
    };
  }

  async list(): Promise<Json> {
    this.flushHidden();
    const live = this.registry.names().map((n) => {
      const s = this.registry.get(n)!;
      return {
        name: n,
        sessionId: s.sessionId,
        cwd: s.cwd,
        status: s.status,
        lastStopReason: s.lastStopReason,
        mode: s.currentMode,
        model: s.currentModel,
        turn: s.turnSeq,
        queued: s.queue.length,
        ...(this.sessionDb
          ? { hidden: this.hiddenDone.has(s.sessionId) }
          : {}),
      };
    });
    const persisted = Object.entries(this.registry.persisted())
      .filter(([n]) => !this.registry.get(n))
      .map(([n, v]) => ({ name: n, ...v, status: "persisted" }));
    let remote: unknown = null;
    let remoteErr: string | undefined;
    if (this.acp.isAlive()) {
      try {
        remote = await this.acp.listSessions();
      } catch (e) {
        remoteErr = e instanceof Error ? e.message : String(e);
      }
    }
    return {
      agentAlive: this.acp.isAlive(),
      subagents: [...live, ...persisted],
      agentSessions: remote,
      ...(remoteErr ? { agentSessionsError: remoteErr } : {}),
    };
  }
}
