import { randomBytes } from "node:crypto";
import { isTerminal } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type {
  Request,
  RequestId,
  Result,
  Task,
} from "@modelcontextprotocol/sdk/types.js";

interface Entry {
  task: Task;
  result?: Result;
  /** aborts the background work bound to this task (never the Devin turn) */
  abort: AbortController;
  expiry?: NodeJS.Timeout;
}

/**
 * TaskStore for the task-augmented `wait` tool.
 *
 * Retention semantics: `ttl` bounds how long a *terminal* task's result is
 * kept — the eviction timer is armed only when the task reaches
 * completed/failed/cancelled. A task that is still `working` (or
 * `input_required`) is never TTL-evicted: a client-requested ttl of seconds
 * must not delete a task whose wait legitimately runs for an hour. A null
 * ttl retains forever.
 *
 * Cancellation: the SDK's tasks/cancel handler only calls
 * `updateTaskStatus(id, 'cancelled')` — it has no hook into the tool. The
 * store therefore owns an AbortController per task; a terminal
 * updateTaskStatus aborts it, which ends the ctl.wait behind the task —
 * the waiter stops, the Devin session's turn keeps running untouched.
 */
export class BridgeTaskStore implements TaskStore {
  private tasks = new Map<string, Entry>();
  private onLog?: (line: string) => void;

  constructor(opts: { onLog?: (line: string) => void } = {}) {
    this.onLog = opts.onLog;
  }

  /** Signal the background work should observe; undefined for unknown ids. */
  aborter(taskId: string): AbortSignal | undefined {
    return this.tasks.get(taskId)?.abort.signal;
  }

  /** Abort a task's worker without touching its stored state. */
  abortTask(taskId: string): void {
    this.tasks.get(taskId)?.abort.abort();
  }

  async createTask(
    taskParams: CreateTaskOptions,
    _requestId?: RequestId,
    _request?: Request,
    _sessionId?: string,
  ): Promise<Task> {
    const taskId = randomBytes(16).toString("hex");
    const now = new Date().toISOString();
    const task: Task = {
      taskId,
      status: "working",
      ttl: taskParams.ttl ?? null,
      createdAt: now,
      lastUpdatedAt: now,
      pollInterval: taskParams.pollInterval ?? 1000,
    };
    this.tasks.set(taskId, { task, abort: new AbortController() });
    return { ...task };
  }

  async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
    const e = this.tasks.get(taskId);
    return e ? { ...e.task } : null;
  }

  /**
   * Store the final result. Terminal tasks are immutable: a late store —
   * the worker finishing just as the client cancels, or after TTL eviction
   * of a terminal task — is dropped silently rather than throwing, so the
   * detached worker can never crash the process over a dead task.
   */
  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    _sessionId?: string,
  ): Promise<void> {
    const e = this.tasks.get(taskId);
    if (!e) throw new Error(`Task with ID ${taskId} not found`);
    if (isTerminal(e.task.status)) return;
    e.result = result;
    e.task.status = status;
    e.task.lastUpdatedAt = new Date().toISOString();
    this.armExpiry(e);
  }

  async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
    const e = this.tasks.get(taskId);
    if (!e) throw new Error(`Task with ID ${taskId} not found`);
    if (e.result === undefined) {
      throw new Error(`Task ${taskId} has no result stored`);
    }
    return e.result;
  }

  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    _sessionId?: string,
  ): Promise<void> {
    const e = this.tasks.get(taskId);
    if (!e) throw new Error(`Task with ID ${taskId} not found`);
    if (isTerminal(e.task.status)) {
      throw new Error(
        `Cannot update task ${taskId} from terminal status '${e.task.status}' to '${status}'`,
      );
    }
    e.task.status = status;
    if (statusMessage) e.task.statusMessage = statusMessage;
    e.task.lastUpdatedAt = new Date().toISOString();
    if (isTerminal(status)) {
      e.abort.abort(); // stop the waiter; the Devin turn is not touched
      this.armExpiry(e);
    }
  }

  async listTasks(
    cursor?: string,
    _sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const PAGE = 10;
    const ids = [...this.tasks.keys()];
    let start = 0;
    if (cursor) {
      const i = ids.indexOf(cursor);
      if (i < 0) throw new Error(`Invalid cursor: ${cursor}`);
      start = i + 1;
    }
    const page = ids.slice(start, start + PAGE);
    const tasks = page.map((id) => ({ ...this.tasks.get(id)!.task }));
    const nextCursor =
      start + PAGE < ids.length ? page[page.length - 1] : undefined;
    return { tasks, nextCursor };
  }

  /** Clear retention timers and abort every live worker (shutdown/tests). */
  cleanup(): void {
    for (const e of this.tasks.values()) {
      if (e.expiry) clearTimeout(e.expiry);
      e.abort.abort();
    }
    this.tasks.clear();
  }

  private armExpiry(e: Entry): void {
    const ttl = e.task.ttl;
    if (ttl === null || ttl === undefined) return;
    if (e.expiry) clearTimeout(e.expiry);
    e.expiry = setTimeout(
      () => this.tasks.delete(e.task.taskId),
      Math.max(0, ttl),
    );
    // retention bookkeeping must never hold the process open
    e.expiry.unref();
  }
}

/** Minimal store surface the detached worker needs (RequestTaskStore fits). */
export interface TaskResultSink {
  storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
  ): Promise<unknown>;
}

/**
 * Detached body of a task-augmented `wait` call. Fire-and-forget by design:
 * every exit path is consumed inside, so the discarded promise can never
 * produce an unhandled rejection — not on a cancelled task, not on a
 * TTL-evicted task, not on a dead transport.
 */
export function runTaskWorker(opts: {
  store: TaskResultSink;
  taskId: string;
  work: () => Promise<unknown>;
  ok: (v: unknown) => Result;
  fail: (e: unknown) => Result;
  onLog?: (line: string) => void;
}): void {
  const note = (e: unknown) =>
    opts.onLog?.(
      `task ${opts.taskId}: result not stored (${e instanceof Error ? e.message : e})`,
    );
  void (async () => {
    try {
      const v = await opts.work();
      await opts.store.storeTaskResult(opts.taskId, "completed", opts.ok(v));
    } catch (e) {
      // work() failed — or the completed-store raced a cancel/eviction; the
      // failed-store is dropped just as quietly when the task is terminal.
      try {
        await opts.store.storeTaskResult(opts.taskId, "failed", opts.fail(e));
      } catch (e2) {
        note(e2);
      }
    }
  })().catch(note); // absolute last resort — never lets a rejection escape
}
