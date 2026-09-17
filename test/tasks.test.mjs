// Unit tests for the MCP task layer: BridgeTaskStore retention/cancel
// semantics and runTaskWorker's no-unhandled-rejection guarantee. Pure
// in-process — no MCP transport, no fake agent needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeTaskStore, runTaskWorker } from "../dist/tasks.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const fail = (e) => ({
  isError: true,
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
});

/** Fail the test if anything escapes the worker as an unhandled rejection. */
function watchRejections(t) {
  const seen = [];
  const h = (e) => seen.push(e);
  process.on("unhandledRejection", h);
  t.after(async () => {
    process.off("unhandledRejection", h);
    await sleep(30); // let any late rejection surface before asserting
    assert.deepEqual(seen, [], "worker produced an unhandled rejection");
  });
  return seen;
}

test("tasks: worker stores a completed result; getTaskResult returns it", async (t) => {
  watchRejections(t);
  const store = new BridgeTaskStore();
  t.after(() => store.cleanup());
  const task = await store.createTask({ ttl: null, pollInterval: 10 });
  assert.equal(task.status, "working");
  runTaskWorker({
    store,
    taskId: task.taskId,
    work: async () => ({ wake: "done", lastStopReason: "end_turn" }),
    ok,
    fail,
  });
  await sleep(30);
  assert.equal((await store.getTask(task.taskId)).status, "completed");
  const res = await store.getTaskResult(task.taskId);
  assert.match(res.content[0].text, /end_turn/);
});

test("tasks: cancel aborts only the waiter; a late result is dropped", async (t) => {
  watchRejections(t);
  const store = new BridgeTaskStore();
  t.after(() => store.cleanup());
  const task = await store.createTask({ ttl: null });
  const signal = store.aborter(task.taskId);
  assert.ok(signal, "task must expose its abort signal to the worker");
  let stopped = false;
  runTaskWorker({
    store,
    taskId: task.taskId,
    work: () =>
      new Promise((r) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            r({ wake: "cancelled" });
          },
          { once: true },
        ),
      ),
    ok,
    fail,
  });
  // what the SDK's tasks/cancel handler does:
  await store.updateTaskStatus(task.taskId, "cancelled", "client cancelled");
  assert.equal(signal.aborted, true);
  await sleep(50); // let the worker settle
  assert.equal(stopped, true, "cancel must end the waiter");
  assert.equal((await store.getTask(task.taskId)).status, "cancelled");
  // the worker's late 'completed' store was dropped silently — no result
  await assert.rejects(() => store.getTaskResult(task.taskId), /no result/);
  // terminal tasks reject further status transitions
  await assert.rejects(
    () => store.updateTaskStatus(task.taskId, "working"),
    /terminal/,
  );
});

test("tasks: ttl never evicts a working task; retention starts at terminal", async (t) => {
  watchRejections(t);
  const store = new BridgeTaskStore();
  t.after(() => store.cleanup());
  const task = await store.createTask({ ttl: 60 });
  await sleep(120); // far past ttl while still 'working'
  assert.equal(
    (await store.getTask(task.taskId)).status,
    "working",
    "a live task must survive a short client-requested ttl",
  );
  runTaskWorker({
    store,
    taskId: task.taskId,
    work: async () => ({ wake: "done" }),
    ok,
    fail,
  });
  await sleep(30);
  assert.equal((await store.getTask(task.taskId)).status, "completed");
  await store.getTaskResult(task.taskId); // retrievable within retention
  await sleep(120); // ttl measured from the terminal transition
  assert.equal(await store.getTask(task.taskId), null);
  await assert.rejects(() => store.getTaskResult(task.taskId), /not found/);
});

test("tasks: a worker finishing into an evicted/cancelled task cannot reject", async (t) => {
  const seen = watchRejections(t);
  const store = new BridgeTaskStore();
  t.after(() => store.cleanup());
  const task = await store.createTask({ ttl: 40 });
  await store.updateTaskStatus(task.taskId, "cancelled");
  await sleep(80); // retention elapsed — the task is gone entirely
  assert.equal(await store.getTask(task.taskId), null);
  runTaskWorker({
    store,
    taskId: task.taskId,
    work: async () => ({ wake: "done" }),
    ok,
    fail,
    onLog: () => {},
  });
  await sleep(50);
  assert.deepEqual(seen, []);
});

test("tasks: failing work stores a failed result", async (t) => {
  watchRejections(t);
  const store = new BridgeTaskStore();
  t.after(() => store.cleanup());
  const task = await store.createTask({ ttl: null });
  runTaskWorker({
    store,
    taskId: task.taskId,
    work: async () => {
      throw new Error('unknown subagent "ghost"');
    },
    ok,
    fail,
  });
  await sleep(30);
  assert.equal((await store.getTask(task.taskId)).status, "failed");
  const res = await store.getTaskResult(task.taskId);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ghost/);
});

test("tasks: the SDK's plain-call fallback shape (create + poll + result)", async (t) => {
  watchRejections(t);
  const store = new BridgeTaskStore();
  t.after(() => store.cleanup());
  // mirrors handleAutomaticTaskPolling for taskSupport:'optional' — a
  // client that never heard of MCP tasks still gets a blocking wait
  const task = await store.createTask({ ttl: null, pollInterval: 10 });
  runTaskWorker({
    store,
    taskId: task.taskId,
    work: () => sleep(60).then(() => ({ wake: "timeout" })),
    ok,
    fail,
  });
  let cur = task;
  const t0 = Date.now();
  while (!["completed", "failed", "cancelled"].includes(cur.status)) {
    assert.ok(Date.now() - t0 < 3000, "fallback poll loop must terminate");
    await sleep(cur.pollInterval ?? 10);
    cur = await store.getTask(task.taskId);
  }
  assert.equal(cur.status, "completed");
  const res = await store.getTaskResult(task.taskId);
  assert.match(res.content[0].text, /timeout/);
});

test("tasks: listTasks paginates; bad cursor rejected", async (t) => {
  const store = new BridgeTaskStore();
  t.after(() => store.cleanup());
  for (let i = 0; i < 12; i++) await store.createTask({ ttl: null });
  const p1 = await store.listTasks();
  assert.equal(p1.tasks.length, 10);
  const p2 = await store.listTasks(p1.nextCursor);
  assert.equal(p2.tasks.length, 2);
  assert.equal(p2.nextCursor, undefined);
  await assert.rejects(() => store.listTasks("bogus"), /cursor/i);
});
