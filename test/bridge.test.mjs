// Deterministic tests for the bridge: drives Controller against fake-acp.mjs
// (a scripted JSON-RPC stdio agent). No external services.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Controller } from "../dist/controller.js";
import { Registry } from "../dist/registry.js";
import { loadBridgeConfig } from "../dist/config.js";
import { SessionDb } from "../dist/sessiondb.js";
import { NotifyHub } from "../dist/notify.js";
import {
  createObservation,
  recordObservation,
  buildSnapshot,
} from "../dist/observe.js";

const FAKE = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));

function makeCtl(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = [];
  const ctl = new Controller({
    command: process.execPath,
    args: [FAKE],
    cwd: dir,
    env: typeof opts.env === "function" ? opts.env(dir) : (opts.env ?? {}),
    statePath: path.join(dir, "state.json"),
    permission: opts.policy ?? "auto",
    mode: opts.mode,
    model: opts.model,
    modeStrict: opts.modeStrict,
    rpcTimeoutMs: opts.rpcTimeoutMs ?? 2000,
    bufferCap: opts.bufferCap,
    hideFromSessionList: opts.hideFromSessionList ?? false,
    sessionDbPath: opts.sessionDbPath,
    notifyThread: opts.notifyThread,
    codexCommand: opts.codexCommand,
    reportTool: opts.reportTool,
    autoNotify: opts.autoNotify,
    reportHint: opts.reportHint,
    onLog: (l) => logs.push(l),
  });
  t.after(() => ctl.close());
  return { ctl, dir, logs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until a raw event of `kind` lands in the session buffer. */
async function untilEvent(ctl, name, kind, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = ctl.registry.get(name);
    if (s?.events.some((e) => e.kind === kind)) return;
    if (Date.now() > end) {
      throw new Error(`timeout waiting for ${kind} on ${name}`);
    }
    await sleep(15);
  }
}

async function untilStatus(ctl, name, want, ms = 4000) {
  const wants = Array.isArray(want) ? want : [want];
  const end = Date.now() + ms;
  for (;;) {
    const s = ctl.registry.get(name);
    if (s && wants.includes(s.status)) return s;
    if (Date.now() > end) {
      throw new Error(`timeout: ${name} status=${s?.status}, want ${wants}`);
    }
    await sleep(15);
  }
}

/**
 * Poll the event log until the subagent leaves running/starting; returns a
 * merged view: all drained normalized entries plus the inspect snapshot's
 * latest text as `text`.
 */
async function untilDone(ctl, name, ms = 5000) {
  const end = Date.now() + ms;
  const events = [];
  let last;
  for (;;) {
    last = await ctl.poll(name, 300, undefined, "logs");
    events.push(...(last.events ?? []));
    if (last.status !== "running" && last.status !== "starting") break;
    if (Date.now() > end) throw new Error(`timeout waiting for ${name} to settle`);
  }
  const snap = await ctl.poll(name); // inspect
  return {
    ...last,
    events,
    snapshot: snap.snapshot,
    text: snap.snapshot?.latestText?.text ?? "",
  };
}

test("spawn runs a turn to completion; poll projects events and text", async (t) => {
  const { ctl } = makeCtl(t);
  const r = await ctl.spawn("alpha", "hello [[chunks:3]]");
  assert.equal(r.status, "running");
  assert.equal(r.turn, 1);
  assert.match(r.sessionId, /^sess-/);
  const d = await untilDone(ctl, "alpha");
  assert.equal(d.status, "idle");
  assert.equal(d.lastStopReason, "end_turn");
  assert.match(d.text, /chunk1 chunk2 chunk3/);
  assert.match(d.text, /fake reply: hello/);
  const types = d.events.map((e) => e.type);
  assert.deepEqual(
    types.filter((x) => x === "turn_start" || x === "turn_end"),
    ["turn_start", "turn_end"],
  );
  assert.equal(d.events[0].turn, 1);
  // contiguous chunks merge within a single drained batch; replay from 0
  // gives one deterministic batch
  const replay = await ctl.poll("alpha", 0, 0, "logs");
  const msgs = replay.events.filter((e) => e.type === "message");
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /chunk1 chunk2 chunk3.*fake reply: hello/s);
});

test("send while running queues FIFO with accurate turn ids", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("q", "first [[sleep:250]]");
  const s2 = await ctl.send("q", "second");
  assert.equal(s2.queued, true);
  assert.equal(s2.position, 1);
  const s3 = await ctl.send("q", "third");
  assert.equal(s3.position, 2);
  const d = await untilDone(ctl, "q");
  const starts = d.events.filter((e) => e.type === "turn_start");
  const ends = d.events.filter((e) => e.type === "turn_end");
  assert.deepEqual(starts.map((e) => e.turn), [1, 2, 3]);
  assert.deepEqual(ends.map((e) => e.turn), [1, 2, 3]);
  // strictly serialized: turn N+1 starts only after turn N ended
  for (let i = 1; i < ends.length; i++) {
    assert.ok(starts[i].seq > ends[i - 1].seq, "turns must not overlap");
  }
  // text reflects the latest turn only
  assert.match(d.text, /fake reply: third/);
  assert.doesNotMatch(d.text, /first/);
});

test("send on stopped requires resume; resume(stopped) is a local no-op", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("a", "hi");
  await untilDone(ctl, "a");
  await ctl.stop("a");
  await assert.rejects(() => ctl.send("a", "x"), /resume/i);
  const r = await ctl.resume("a");
  assert.equal(r.status, "idle");
  await ctl.send("a", "back");
  const d = await untilDone(ctl, "a");
  assert.match(d.text, /fake reply: back/);
});

test("stop while running: stale completion must not flip status to idle", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("h", "[[hang]]");
  await untilStatus(ctl, "h", "running");
  ctl.stop("h");
  await untilEvent(ctl, "h", "turn_end"); // cancelled prompt's reply lands async
  const s = ctl.registry.get("h");
  assert.equal(s.status, "stopped");
  const d = await ctl.poll("h", 0, undefined, "logs");
  assert.equal(d.status, "stopped");
  assert.ok(d.events.some((e) => e.type === "turn_end" && e.stopReason === "cancelled"));
  await assert.rejects(() => ctl.send("h", "x"), /resume/i);
});

test("interrupt cancels the turn and clears the queue", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("i", "one [[sleep:300]]");
  await untilStatus(ctl, "i", "running");
  await ctl.send("i", "two");
  const r = await ctl.interrupt("i");
  assert.equal(r.note, "cancel sent");
  const d = await untilDone(ctl, "i");
  assert.equal(d.status, "idle");
  const starts = d.events.filter((e) => e.type === "turn_start");
  assert.equal(starts.length, 1); // queued message dropped, not run
  assert.ok(d.events.some((e) => e.type === "turn_end" && e.stopReason === "cancelled"));
});

test("resume on a running subagent is a safe no-op", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("r", "[[sleep:250]]");
  await untilStatus(ctl, "r", "running");
  const out = await ctl.resume("r");
  assert.equal(out.status, "running");
  assert.match(out.note ?? "", /already/i);
  const d = await untilDone(ctl, "r");
  assert.equal(d.status, "idle");
});

test("duplicate names: live, concurrent, and persisted are rejected", async (t) => {
  const { ctl, dir } = makeCtl(t);
  await ctl.spawn("dup", "[[sleep:150]]");
  await assert.rejects(() => ctl.spawn("dup", "x"), /already exists/);
  await untilDone(ctl, "dup");
  // live name still rejected even though it's now also persisted
  await assert.rejects(() => ctl.spawn("dup", "x"), /already exists/);

  // persisted-only name (fresh controller over the same state file)
  const logs = [];
  const ctl2 = new Controller({
    command: process.execPath,
    args: [FAKE],
    cwd: dir,
    statePath: path.join(dir, "state.json"),
    permission: "auto",
    rpcTimeoutMs: 2000,
    onLog: (l) => logs.push(l),
  });
  t.after(() => ctl2.close());
  await assert.rejects(() => ctl2.spawn("dup", "x"), /persisted.*resume/is);
});

test("concurrent spawn of the same name: exactly one wins", async (t) => {
  const { ctl } = makeCtl(t, { env: { FAKE_ACP_NEW_DELAY: "120" } });
  const [a, b] = await Promise.allSettled([
    ctl.spawn("race", "one"),
    ctl.spawn("race", "two"),
  ]);
  const oks = [a, b].filter((r) => r.status === "fulfilled");
  const errs = [a, b].filter((r) => r.status === "rejected");
  assert.equal(oks.length, 1);
  assert.equal(errs.length, 1);
  assert.match(errs[0].reason.message, /already exists/);
  await untilDone(ctl, "race");
});

test("agent death marks sessions dead; ensureStarted restarts; resume reloads", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("d", "hi");
  await untilDone(ctl, "d");
  const sid = ctl.registry.get("d").sessionId;
  ctl.acp.kill();
  await untilStatus(ctl, "d", "dead");
  const deadPoll = await ctl.poll("d");
  assert.equal(deadPoll.status, "dead");
  await assert.rejects(() => ctl.send("d", "x"), /dead.*resume/is);
  const r = await ctl.resume("d");
  assert.equal(r.status, "idle");
  assert.equal(r.sessionId, sid);
  assert.equal(ctl.acp.isAlive(), true);
  const d2 = await untilDone(ctl, "d", 5000);
  assert.match(d2.text, /fake reply/); // send works on reloaded session
});

test("crash mid-turn records turn_end error and keeps dead status", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("c", "[[die]]");
  await untilStatus(ctl, "c", "dead");
  const d = await ctl.poll("c", 0, undefined, "logs");
  assert.equal(d.status, "dead");
  assert.ok(d.events.some((e) => e.type === "turn_end" && e.stopReason === "error"));
  assert.ok(d.events.some((e) => e.type === "agent_exit"));
});

test("startup failure rejects spawn but next attempt respawns cleanly", async (t) => {
  // Marker file makes ONLY the first agent process slow to initialize;
  // its late exit must not poison the respawned child.
  let marker;
  const { ctl, dir } = makeCtl(t, {
    env: (d) => {
      marker = path.join(d, "init-slow.marker");
      return { FAKE_ACP_INIT_DELAY: "2000", FAKE_ACP_INIT_MARKER: marker };
    },
    rpcTimeoutMs: 300,
  });
  writeFileSync(marker, "x");
  await assert.rejects(
    () => ctl.spawn("s", "hi"),
    /timed out|not running|exited/i,
  );
  const r = await ctl.spawn("s", "hi");
  assert.equal(r.status, "running");
  const d = await untilDone(ctl, "s");
  assert.match(d.text, /fake reply: hi/);
});

test("spawn failure releases the name (no phantom 'already exists')", async (t) => {
  const { ctl } = makeCtl(t, {
    env: { FAKE_ACP_INIT_DELAY: "2000" },
    rpcTimeoutMs: 250,
  });
  await assert.rejects(() => ctl.spawn("x", "hi"), /timed out|not running|exited/i);
  await assert.rejects(() => ctl.spawn("x", "hi"), /timed out|not running|exited/i);
});

test("non-prompt RPC calls are bounded by a timeout; prompts are not", async (t) => {
  const { ctl } = makeCtl(t, {
    env: { FAKE_ACP_HANG: "session/list" },
    rpcTimeoutMs: 400,
  });
  await ctl.spawn("t", "hi");
  await untilDone(ctl, "t");
  const t0 = Date.now();
  const l = await ctl.list(); // list surfaces the remote error, doesn't hang
  assert.match(l.agentSessionsError ?? "", /timed out/);
  assert.ok(Date.now() - t0 < 3000, "list must not hang");
  assert.equal(l.agentAlive, true);
  assert.equal(l.subagents[0].name, "t");
  // a long prompt exceeds the rpc timeout without error
  await ctl.send("t", "[[sleep:800]] slow");
  const d = await untilDone(ctl, "t", 5000);
  assert.equal(d.lastStopReason, "end_turn");
});

test("operator permission: optionId validated, deny and grant paths", async (t) => {
  const { ctl } = makeCtl(t, { policy: "operator" });
  await ctl.spawn("op", "[[perm]]");
  // wait for the pending request
  const end = Date.now() + 4000;
  for (;;) {
    const s = ctl.registry.get("op");
    if (s?.pendingPermission) break;
    if (Date.now() > end) throw new Error("no permission request surfaced");
    await sleep(15);
  }
  const p = ctl.registry.get("op").pendingPermission;
  assert.deepEqual(
    p.options.map((o) => o.optionId),
    ["allow_once", "allow_always", "deny"],
  );
  // invalid optionId rejected, request stays pending
  assert.throws(() => ctl.permission("op", "bogus"), /unknown optionId.*allow_once/s);
  assert.ok(ctl.registry.get("op").pendingPermission);
  // deny (no optionId)
  const denied = ctl.permission("op");
  assert.equal(denied.answered, "cancelled");
  const d = await untilDone(ctl, "op");
  assert.equal(d.lastStopReason, "cancelled");
  assert.ok(d.events.some((e) => e.type === "permission_denied"));

  // grant path on a new permission-requesting turn
  await ctl.send("op", "[[perm]] again");
  for (;;) {
    if (ctl.registry.get("op").pendingPermission) break;
    await sleep(15);
  }
  const granted = ctl.permission("op", "allow_always");
  assert.equal(granted.answered, "allow_always");
  const d2 = await untilDone(ctl, "op");
  assert.equal(d2.lastStopReason, "end_turn");
  assert.ok(d2.events.some((e) => e.type === "permission_granted" && e.optionId === "allow_always"));
});

test("auto policy answers permission with allow_once", async (t) => {
  const { ctl } = makeCtl(t, { policy: "auto" });
  await ctl.spawn("ap", "[[perm]]");
  const d = await untilDone(ctl, "ap");
  assert.equal(d.lastStopReason, "end_turn");
  const auto = d.events.find((e) => e.type === "permission_auto");
  assert.equal(auto.optionId, "allow_once");
});

test("stop cancels a stale pending permission", async (t) => {
  const { ctl } = makeCtl(t, { policy: "operator" });
  await ctl.spawn("sp", "[[perm]]");
  for (;;) {
    if (ctl.registry.get("sp").pendingPermission) break;
    await sleep(15);
  }
  ctl.stop("sp");
  assert.equal(ctl.registry.get("sp").pendingPermission, undefined);
  assert.throws(() => ctl.permission("sp", "allow_once"), /no pending/);
  await untilEvent(ctl, "sp", "turn_end"); // cancelled reply lands async
  const d = await ctl.poll("sp", 0, undefined, "logs");
  assert.equal(d.status, "stopped");
  assert.ok(d.events.some((e) => e.type === "turn_end" && e.stopReason === "cancelled"));
});

test("two concurrent waiting polls are both woken by new events", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("w", "[[sleep:300]] body");
  // both waits begin while running with no unread events beyond cursor
  await ctl.poll("w", 0, undefined, "logs"); // set read cursor at head
  const [r1, r2] = await Promise.all([
    ctl.poll("w", 1500, undefined, "logs"),
    ctl.poll("w", 1500, undefined, "logs"),
  ]);
  assert.ok(r1.events.length >= 1, "first waiter should see events");
  assert.equal(r2.status, r1.status);
});

test("replay since does not move the read cursor; droppedEvents is accurate", async (t) => {
  const { ctl } = makeCtl(t, { bufferCap: 6 });
  await ctl.spawn("b", "[[chunks:20]]");
  await untilDone(ctl, "b"); // consumes the read cursor
  // 23 raw events total (turn_start + 20 chunks + reply + turn_end); cap 6
  // keeps seq 18..23. Replaying from 0 reports the 17 evicted events and
  // does NOT move the stored cursor.
  const replay = await ctl.poll("b", 0, 0, "logs");
  assert.equal(replay.droppedEvents, 17);
  assert.equal(replay.nextCursor, 23);
  assert.equal(replay.hasMore, false);
  // the buffered chunk+reply run merges into one message entry (seq 22)
  const msgs = replay.events.filter((e) => e.type === "message");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].seq, 22);
  assert.match(msgs[0].text, /chunk17 chunk18 chunk19 chunk20 fake reply/);
  assert.equal(replay.events.at(-1).type, "turn_end");
  // replay from seq 20 returns the events after 20, cursor still untouched
  const replay2 = await ctl.poll("b", 0, 20, "logs");
  assert.deepEqual(replay2.events.map((e) => e.seq), [22, 23]);
  assert.equal(replay2.droppedEvents, 0);
  const after = await ctl.poll("b", 0, undefined, "logs");
  assert.equal(after.events.length, 0);
  assert.equal(after.nextCursor, 23);
});

test("input validation: names, task, text, cwd, since, mode", async (t) => {
  const { ctl, dir } = makeCtl(t);
  await assert.rejects(() => ctl.spawn("", "x"), /invalid.*name/i);
  await assert.rejects(() => ctl.spawn("bad name!", "x"), /invalid.*name/i);
  await assert.rejects(() => ctl.spawn("ok", "   "), /task/i);
  await assert.rejects(() => ctl.spawn("ok", "x", "relative/dir"), /absolute/);
  await assert.rejects(() => ctl.spawn("ok", "x", "/definitely/not/here-xyz"), /does not exist/);
  await ctl.spawn("ok", "hi");
  await untilDone(ctl, "ok");
  await assert.rejects(() => ctl.send("ok", ""), /text/i);
  await assert.rejects(() => ctl.poll("ok", 0, -3), /since/i);
  await assert.rejects(() => ctl.setMode("ok", "not-a-mode"), /unknown mode.*smart/s);
  await assert.rejects(() => ctl.setMode("ok", "bad mode"), /invalid mode/i);
  void dir;
});

test("mode/model discovery + confirmation; unknown default-mode falls back", async (t) => {
  const { ctl } = makeCtl(t, { mode: "smart", model: "swe-2-max" });
  const r = await ctl.spawn("m", "hi", undefined, "bypass");
  assert.equal(r.mode, "bypass");
  assert.equal(r.model, "swe-2-max");
  await untilDone(ctl, "m");
  const l = await ctl.list();
  const me = l.subagents.find((s) => s.name === "m");
  assert.equal(me.mode, "bypass");
  assert.equal(me.model, "swe-2-max");
  // set_mode through the tool
  const sm = await ctl.setMode("m", "smart");
  assert.equal(sm.mode, "smart");

  // unadvertised built-in default mode degrades to mode_skipped, turn runs
  const c2 = makeCtl(t, { mode: "nonexistent" }).ctl;
  const r2 = await c2.spawn("m2", "hi");
  assert.equal(r2.mode, "smart"); // agent default retained
  await untilDone(c2, "m2");
  const p = await c2.poll("m2", 0, 0, "logs");
  assert.ok(p.events.some((e) => e.type === "mode_skipped" && e.wanted === "nonexistent"));
});

test("spawn without advertised caps records mode_skipped for wanted mode", async (t) => {
  const { ctl } = makeCtl(t, { env: { FAKE_ACP_NO_CAPS: "1" }, mode: "smart" });
  const r = await ctl.spawn("n", "hi");
  await untilDone(ctl, "n");
  const p = await ctl.poll("n", 0, 0, "logs");
  assert.ok(p.events.some((e) => e.type === "mode_skipped" && e.wanted === "smart"));
  assert.equal(r.status, "running");
});

test("persistence: state file written, merged, corrupt file tolerated", async (t) => {
  const { ctl, dir, logs } = makeCtl(t);
  await ctl.spawn("p1", "hi");
  await untilDone(ctl, "p1");
  const statePath = path.join(dir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.ok(state.sessions.p1.sessionId);
  // a second registry over the same file sees the persisted session
  const reg2 = new Registry(statePath);
  assert.ok(reg2.persisted().p1);
  // corrupt state file: tolerated + logged, does not crash
  writeFileSync(statePath, "{not json");
  const reg3 = new Registry(statePath, { onLog: (l) => logs.push(l) });
  assert.deepEqual(reg3.persisted(), {});
});

test("projection fidelity: merge, tool output readable, usage dedup", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("pr", "[[chunks:2]][[think]][[tool]][[plan]][[usage]] go");
  await untilDone(ctl, "pr");
  const d = await ctl.poll("pr", 0, 0, "logs"); // single deterministic batch via replay
  const types = d.events.map((e) => e.type);
  const i = (ty) => types.indexOf(ty);
  // order: turn_start, message(chunks merged), thinking, tool x2, plan, usage x2 (dedup), message(reply), turn_end
  assert.equal(types[0], "turn_start");
  assert.ok(i("message") < i("thinking"));
  const toolIdx = types.map((x, n) => (x === "tool" ? n : -1)).filter((n) => n >= 0);
  assert.equal(toolIdx.length, 2);
  const done = d.events[toolIdx[1]];
  assert.equal(done.status, "completed");
  assert.match(done.output, /file1\nfile2/); // readable text, not escaped JSON blob
  assert.equal(d.events.filter((e) => e.type === "usage").length, 2); // dedup
  assert.ok(i("plan") > toolIdx[0]);
  assert.equal(types.at(-1), "turn_end");
});

test("large tool output is truncated in projection", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("big", "[[big]]");
  const d = await untilDone(ctl, "big");
  const tool = d.events.find((e) => e.type === "tool" && e.output);
  assert.ok(tool.output.length < 6000);
  assert.match(tool.output, /truncated/);
});

test("stop->resume->send while cancel is settling reports running, then runs", async (t) => {
  const { ctl } = makeCtl(t, { env: { FAKE_ACP_CANCEL_DELAY: "200" } });
  await ctl.spawn("z", "[[hang]]");
  await untilStatus(ctl, "z", "running");
  ctl.stop("z");
  // resume before the cancelled prompt's reply has landed
  const rs = await ctl.resume("z");
  assert.equal(rs.status, "running"); // still settling, not falsely idle
  const snd = await ctl.send("z", "after");
  assert.equal(snd.queued, true);
  const p = await ctl.poll("z"); // immediate inspect must not claim idle
  assert.equal(p.status, "running");
  const d = await untilDone(ctl, "z", 5000);
  assert.equal(d.status, "idle");
  const ends = d.events.filter((e) => e.type === "turn_end");
  assert.deepEqual(
    ends.map((e) => e.stopReason),
    ["cancelled", "end_turn"],
  );
  assert.match(d.text, /fake reply: after/);
});

test("selecting a deny-kind option records permission_denied", async (t) => {
  const { ctl } = makeCtl(t, { policy: "operator" });
  await ctl.spawn("dn", "[[perm]]");
  for (;;) {
    if (ctl.registry.get("dn").pendingPermission) break;
    await sleep(15);
  }
  const r = ctl.permission("dn", "deny"); // deny_once-kind option
  assert.equal(r.answered, "deny");
  const d = await untilDone(ctl, "dn");
  assert.equal(d.lastStopReason, "end_turn"); // answered request -> turn completes
  assert.ok(d.events.some((e) => e.type === "permission_denied" && e.optionId === "deny"));
  assert.ok(!d.events.some((e) => e.type === "permission_granted"));
});

test("explicit invalid spawn mode/model rejects; name stays reusable", async (t) => {
  const { ctl } = makeCtl(t);
  await assert.rejects(
    () => ctl.spawn("mm", "hi", undefined, "nope"),
    /mode "nope" not advertised.*smart/s,
  );
  await assert.rejects(
    () => ctl.spawn("mm", "hi", undefined, undefined, "not-a-model"),
    /model "not-a-model" not advertised.*swe-2-max/s,
  );
  // failed spawns release the name AND its persisted record
  const r = await ctl.spawn("mm", "hi", undefined, "bypass");
  assert.equal(r.mode, "bypass");
  await untilDone(ctl, "mm");
});

// ---------- config file (no env) ----------

test("config: defaults when no file; cwd default file picked up", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const d = loadBridgeConfig([], dir);
  assert.equal(d.file, undefined);
  assert.deepEqual(d.config, {
    command: "devin",
    args: ["acp"],
    statePath: path.join(dir, ".devin-subagents.json"),
    permission: "operator",
    mode: "smart",
    model: "swe-2-max",
    rpcTimeoutMs: 30000,
    bufferCap: 500,
    hideFromSessionList: true,
    codexCommand: "codex",
    reportTool: true,
    autoNotify: true,
    reportHint: true,
  });
  assert.equal(d.specified.size, 0);
  // default file in cwd is auto-discovered
  writeFileSync(
    path.join(dir, "devin-subagents.config.json"),
    JSON.stringify({ permission: "auto", model: "swe-2-high" }),
  );
  const d2 = loadBridgeConfig([], dir);
  assert.equal(d2.file, path.join(dir, "devin-subagents.config.json"));
  assert.equal(d2.config.permission, "auto");
  assert.equal(d2.config.model, "swe-2-high");
  assert.equal(d2.config.mode, "smart"); // default
  assert.ok(d2.specified.has("model") && !d2.specified.has("mode"));
});

test("config: --config path, relative statePath resolves vs config dir", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, "b.json"),
    JSON.stringify({
      command: process.execPath,
      args: [FAKE],
      statePath: "state/bridge.json",
      permission: "always",
      mode: "bypass",
      model: "swe-2-medium",
      rpcTimeoutMs: 1234,
      bufferCap: 42,
    }),
  );
  const d = loadBridgeConfig(["--config", "b.json"], dir);
  assert.equal(d.file, path.join(dir, "b.json"));
  assert.equal(d.config.command, process.execPath); // absolute path kept
  assert.equal(d.config.statePath, path.join(dir, "state", "bridge.json"));
  assert.equal(d.config.permission, "always");
  assert.equal(d.config.mode, "bypass");
  assert.equal(d.config.model, "swe-2-medium");
  assert.equal(d.config.rpcTimeoutMs, 1234);
  assert.equal(d.config.bufferCap, 42);
  // --config=PATH form
  const d2 = loadBridgeConfig([`--config=${path.join(dir, "b.json")}`], "/tmp");
  assert.equal(d2.config.model, "swe-2-medium");
});

test("config: strict schema and explicit-file errors", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = (obj) => {
    writeFileSync(path.join(dir, "x.json"), obj);
    return ["--config", path.join(dir, "x.json")];
  };
  assert.throws(() => loadBridgeConfig(["--config", "missing.json"], dir), /not found/);
  assert.throws(() => loadBridgeConfig(w("{nope"), dir), /invalid JSON/);
  assert.throws(() => loadBridgeConfig(w('["a"]'), dir), /object/);
  assert.throws(() => loadBridgeConfig(w('{"bogus": 1}'), dir), /unknown key "bogus"/);
  assert.throws(() => loadBridgeConfig(w('{"bufferCap": "500"}'), dir), /integer/);
  assert.throws(() => loadBridgeConfig(w('{"bufferCap": 1.5}'), dir), /integer/);
  assert.throws(() => loadBridgeConfig(w('{"rpcTimeoutMs": 0}'), dir), /integer/);
  assert.throws(() => loadBridgeConfig(w('{"permission": "yolo"}'), dir), /permission/);
  assert.throws(() => loadBridgeConfig(w('{"mode": "has space"}'), dir), /mode/);
  assert.throws(() => loadBridgeConfig(w('{"args": "acp"}'), dir), /array/);
  assert.throws(() => loadBridgeConfig(w('{"command": ""}'), dir), /command/);
  assert.throws(() => loadBridgeConfig(["--bogus"], dir), /unknown argument/);
  assert.equal(loadBridgeConfig(["--help"], dir).help, true);
});

test("config: DEVIN_* env vars are ignored as bridge settings", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("DEVIN_")) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });
  process.env.DEVIN_SUBAGENT_MODE = "bogus mode!!";
  process.env.DEVIN_MODEL = "claude-9";
  process.env.DEVIN_BIN = "/nonexistent";
  process.env.DEVIN_SUBAGENT_PERMISSION = "nonsense";
  const d = loadBridgeConfig([], dir); // no config file -> defaults
  assert.equal(d.config.mode, "smart");
  assert.equal(d.config.model, "swe-2-max");
  assert.equal(d.config.command, "devin");
  assert.equal(d.config.permission, "operator");
});

test("config precedence: per-call > file > built-in default", async (t) => {
  // an unadvertised configured model always fails spawn — never run ambient
  const { ctl } = makeCtl(t, { model: "nonexistent-9" });
  await assert.rejects(
    () => ctl.spawn("f", "hi"),
    /model "nonexistent-9" not advertised/,
  );
  void ctl;
  // file-specified advertised model wins over built-in; per-call wins over file
  const c2 = makeCtl(t, { model: "swe-2-medium", mode: "bypass" }).ctl;
  const r = await c2.spawn("g", "hi");
  assert.equal(r.model, "swe-2-medium");
  assert.equal(r.mode, "bypass");
  await untilDone(c2, "g");
  const r2 = await c2.spawn("h", "hi", undefined, "smart", "swe-2-max");
  assert.equal(r2.model, "swe-2-max");
  assert.equal(r2.mode, "smart");
  await untilDone(c2, "h");
});

// ---------- models / set_model tools ----------

test("models: defaults before discovery, advertised caps after spawn", async (t) => {
  const { ctl } = makeCtl(t, { model: "swe-2-max", mode: "smart" });
  const before = ctl.models();
  assert.equal(before.defaultModel, "swe-2-max");
  assert.equal(before.availableModels, null);
  assert.equal(before.discovered, false);
  await ctl.spawn("m", "hi");
  await untilDone(ctl, "m");
  const after = ctl.models();
  assert.deepEqual(after.availableModels, ["swe-2-medium", "swe-2-high", "swe-2-max"]);
  assert.equal(after.currentModel, "swe-2-max");
  assert.equal(after.discovered, true);
  const per = ctl.models("m");
  assert.equal(per.model, "swe-2-max");
  assert.deepEqual(per.availableModes, ["smart", "bypass"]);
});

test("set_model: idle only, validated, confirmed", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("m", "hi");
  await untilDone(ctl, "m");
  const r = await ctl.setModel("m", "swe-2-high");
  assert.equal(r.model, "swe-2-high");
  assert.equal(ctl.models("m").model, "swe-2-high");
  // invalid id rejected against advertised list
  await assert.rejects(() => ctl.setModel("m", "nope"), /unknown model.*swe-2-medium/s);
  // running session rejects
  await ctl.send("m", "[[hang]]");
  await untilStatus(ctl, "m", "running");
  await assert.rejects(() => ctl.setModel("m", "swe-2-max"), /in flight|idle/i);
  ctl.stop("m");
  await assert.rejects(() => ctl.setModel("m", "swe-2-max"), /stopped.*resume/is);
});

test("set_model: agent confirming a different value is an error", async (t) => {
  const { ctl } = makeCtl(t, { env: { FAKE_ACP_FORCE_MODEL: "swe-2-medium" } });
  await ctl.spawn("m", "hi");
  await untilDone(ctl, "m");
  await assert.rejects(
    () => ctl.setModel("m", "swe-2-high"),
    /confirmed model "swe-2-medium"/,
  );
  // spawn with a configured model the agent won't confirm fails too
  const c2 = makeCtl(t, {
    env: { FAKE_ACP_FORCE_MODEL: "swe-2-medium" },
    model: "swe-2-high",
  }).ctl;
  await assert.rejects(() => c2.spawn("x", "hi"), /confirmed model "swe-2-medium"/);
});

test("set_mode falls back to set_config_option when set_mode is absent", async (t) => {
  const { ctl } = makeCtl(t, { env: { FAKE_ACP_NO_SETMODE: "1" } });
  await ctl.spawn("m", "hi");
  await untilDone(ctl, "m");
  const r = await ctl.setMode("m", "bypass");
  assert.equal(r.mode, "bypass");
  assert.equal(ctl.models("m").mode, "bypass");
});

// ---------- poll inspect / logs ----------

test("inspect: persistent snapshot, stable across repeat polls and log drains", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("s", "[[chunks:2]][[think]][[tool]][[plan]] tail");
  await untilDone(ctl, "s");
  const a = await ctl.poll("s"); // inspect is the default
  assert.equal(a.events, undefined, "inspect must not carry the event stream");
  assert.equal(typeof a.cursor, "number");
  assert.ok(!Number.isNaN(Date.parse(a.capturedAt)));
  const sn = a.snapshot;
  assert.match(sn.latestText.text, /fake reply: tail/);
  assert.equal(sn.latestText.turn, 1);
  assert.equal(sn.turn.n, 1);
  assert.equal(sn.turn.stopReason, "end_turn");
  assert.ok(sn.turn.startedAt && sn.turn.endedAt);
  assert.ok(sn.turn.durationMs >= 0);
  assert.equal(sn.lastOutput.type, "message");
  assert.equal(sn.activeTools.length, 0); // the [[tool]] call completed
  assert.equal(sn.currentPlanStep.content, "do it");
  assert.equal(sn.lastError, null);
  assert.ok(sn.lastActivity.elapsedMs >= 0 && sn.lastContent.elapsedMs >= 0);
  // thinking counts as activity but is not accumulated into latestText
  assert.doesNotMatch(sn.latestText.text, /thinking/);
  // a repeated snapshot with no new events is identical (bar elapsed ages)
  const b = await ctl.poll("s", 0, undefined, "inspect");
  assert.deepEqual(
    { ...b.snapshot, lastActivity: null, lastContent: null },
    { ...a.snapshot, lastActivity: null, lastContent: null },
  );
  assert.equal(b.cursor, a.cursor);
  // draining the whole log must not erode the snapshot
  const lg = await ctl.poll("s", 0, 0, "logs");
  assert.ok(lg.events.length > 0);
  const c = await ctl.poll("s");
  assert.deepEqual(c.snapshot.lastOutput, a.snapshot.lastOutput);
  assert.deepEqual(c.snapshot.latestText, a.snapshot.latestText);
  assert.equal(c.cursor, a.cursor);
  // and logs still carry the thinking entry inspect doesn't accumulate
  assert.ok(lg.events.some((e) => e.type === "thinking"));
});

test("inspect: active tool survives log drain + buffer eviction; interrupt annotates it", async (t) => {
  const { ctl } = makeCtl(t, { bufferCap: 6 });
  await ctl.spawn("ev", "[[activetool]][[chunks:10]][[hang]]");
  await untilStatus(ctl, "ev", "running");
  await sleep(60); // let the chunk flood evict the tool_call event (cap 6)
  const s1 = await ctl.poll("ev");
  assert.deepEqual(s1.snapshot.activeTools.map((x) => x.id), ["tc-live"]);
  const tool = s1.snapshot.activeTools[0];
  assert.equal(tool.status, "in_progress");
  assert.match(tool.title, /sleep 30/);
  assert.match(tool.input, /sleep 30/);
  assert.equal(tool.turn, 1);
  assert.ok(tool.startedAt <= tool.updatedAt);
  assert.ok(tool.elapsedMs >= 0);
  // the tool_call event itself is already evicted from the ring buffer
  const lg = await ctl.poll("ev", 0, 0, "logs");
  assert.equal(lg.droppedEvents, 7); // seqs 1..7 gone (turn_start+tool_call+text+chunks1..4... seqs <8)
  assert.ok(lg.events.every((e) => e.seq >= 8));
  assert.ok(!lg.events.some((e) => e.type === "tool"));
  // draining does not consume the snapshot's tool state either
  const s2 = await ctl.poll("ev");
  assert.deepEqual(s2.snapshot.activeTools.map((x) => x.id), ["tc-live"]);
  // interrupt ends the turn: a still-open tool must not stay "running"
  await ctl.interrupt("ev");
  const d = await untilDone(ctl, "ev");
  assert.equal(d.status, "idle");
  assert.equal(d.lastStopReason, "cancelled");
  const s3 = await ctl.poll("ev");
  assert.equal(s3.snapshot.activeTools.length, 0);
  assert.equal(s3.snapshot.turn.stopReason, "cancelled");
  assert.ok(s3.snapshot.turn.endedAt);
});

test("inspect: tool elapsedMs grows while running; turn timing while running", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("tm", "[[activetool]][[sleep:400]]");
  await untilEvent(ctl, "tm", "tool_call");
  await sleep(120);
  const a = await ctl.poll("tm");
  assert.equal(a.status, "running");
  const t1 = a.snapshot.activeTools[0];
  assert.equal(t1.id, "tc-live");
  assert.ok(
    t1.elapsedMs >= 80,
    `elapsed should reflect real runtime, got ${t1.elapsedMs}`,
  );
  await sleep(120);
  const b = await ctl.poll("tm");
  assert.ok(
    b.snapshot.activeTools[0].elapsedMs > t1.elapsedMs,
    "elapsedMs must grow between polls",
  );
  assert.equal(b.snapshot.turn.n, 1);
  assert.equal(b.snapshot.turn.endedAt, null);
  assert.equal(b.snapshot.turn.stopReason, null);
  assert.ok(b.snapshot.turn.durationMs > 0);
  const d = await untilDone(ctl, "tm");
  assert.equal(d.status, "idle");
  const c = await ctl.poll("tm");
  // the tool never completed — turn end annotates it off the active list
  assert.equal(c.snapshot.activeTools.length, 0);
  assert.equal(c.snapshot.turn.stopReason, "end_turn");
  assert.ok(c.snapshot.turn.durationMs >= 300);
});

test("inspect: overlapping tool updates merge by id; completions and turn end clear actives", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("ov", "[[tools]][[sleep:250]] go");
  // both tools are mid-flight while the turn runs
  await untilEvent(ctl, "ov", "tool_call");
  const mid = await ctl.poll("ov");
  const ids = mid.snapshot.activeTools.map((x) => x.id).sort();
  assert.deepEqual(ids, ["tc-a", "tc-b"]);
  const d = await untilDone(ctl, "ov");
  const done = await ctl.poll("ov");
  assert.equal(done.snapshot.activeTools.length, 0);
  // in the log: tc-a completed with output; tc-b's title-less update is
  // backfilled by id from the merged tool map
  const tools = d.events.filter((e) => e.type === "tool");
  const ta = tools.filter((e) => e.id === "tc-a");
  const tb = tools.filter((e) => e.id === "tc-b");
  assert.equal(ta.at(-1).status, "completed");
  assert.match(ta.at(-1).output ?? "", /a1\na2/);
  assert.equal(tb.length, 2);
  assert.equal(tb[1].title, "read: f.ts");
  assert.equal(tb[1].status, "in_progress");
});

test("logs: title-less tool updates in later batches keep the title by id", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("tb", "[[activetool]][[sleep:250]][[toolupd]] x");
  await untilEvent(ctl, "tb", "tool_call");
  const page1 = await ctl.poll("tb", 0, undefined, "logs");
  const t0 = page1.events.find((e) => e.type === "tool" && e.id === "tc-live");
  assert.equal(t0.title, "exec: sleep 30");
  // the [[toolupd]] update lands in a later batch, still identifiable
  const d = await untilDone(ctl, "tb");
  const upd = d.events.filter((e) => e.type === "tool" && e.id === "tc-live");
  assert.ok(upd.length >= 1);
  assert.equal(upd.at(-1).title, "exec: sleep 30");
  assert.match(upd.at(-1).input ?? "", /verbose/);
});

test("logs: limit pages via nextCursor/hasMore without skipping merged chunks", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("pg", "[[chunks:8]] tail");
  await untilEvent(ctl, "pg", "turn_end");
  // 11 raw events: turn_start(1), chunks(2..9), reply(10), turn_end(11)
  const texts = [];
  const cursors = [];
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard++ < 12) {
    const p = await ctl.poll("pg", 0, undefined, "logs", 3);
    cursors.push(p.nextCursor);
    for (const e of p.events) {
      assert.ok(!Number.isNaN(Date.parse(e.at)), `${e.type} needs a receipt time`);
      if (e.type === "message") texts.push(e.text);
    }
    hasMore = p.hasMore;
  }
  assert.equal(hasMore, false);
  const all = texts.join("");
  for (let i = 1; i <= 8; i++) {
    assert.ok(all.includes(`chunk${i} `), `missing chunk${i}`);
  }
  assert.ok(all.includes("fake reply: tail"));
  assert.ok(all.indexOf("chunk1") < all.indexOf("chunk8"), "order preserved");
  // cursor strictly advances to the true head; nothing is skipped
  assert.deepEqual(cursors, [3, 6, 9, 11]);
  const end = await ctl.poll("pg", 0, undefined, "logs");
  assert.equal(end.events.length, 0);
  assert.equal(end.hasMore, false);
  assert.equal(end.nextCursor, 11);
});

test("logs: explicit since replay does not move the implicit read cursor", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("rp", "[[chunks:2]] one");
  await untilDone(ctl, "rp");
  const head1 = ctl.registry.get("rp").head;
  await ctl.send("rp", "[[chunks:2]] two");
  await untilStatus(ctl, "rp", "idle");
  // replay everything from 0 — must not consume the cursor position
  const replay = await ctl.poll("rp", 0, 0, "logs");
  assert.ok(replay.events.length > 0);
  // the implicit read continues from head1, not from the replay's nextCursor
  const inc = await ctl.poll("rp", 0, undefined, "logs");
  assert.ok(inc.events.length > 0);
  assert.ok(inc.events.every((e) => e.seq > head1));
  assert.equal(inc.hasMore, false);
});

test("logs: replay keeps ingest-time tool metadata across completion and id reuse", async (t) => {
  const { ctl } = makeCtl(t);
  // turn 1: tc-a gets a status-less progress update then completes;
  //         tc-re is "exec: step 1"
  await ctl.spawn("rp", "[[tools]][[reuse]] one");
  await untilDone(ctl, "rp");
  // turn 2: the same toolCallId tc-re comes back as "exec: step 2"
  await ctl.send("rp", "[[reuse]] two");
  await untilDone(ctl, "rp");
  // replay the whole history — every tool event must show the metadata it
  // was ingested with, not the tool record's latest state
  const replay = await ctl.poll("rp", 0, 0, "logs");
  const tools = replay.events.filter((e) => e.type === "tool");

  const prog = tools.find(
    (e) => e.id === "tc-a" && /a-progress/.test(e.output ?? ""),
  );
  assert.ok(prog, "missing tc-a progress update");
  assert.equal(prog.status, "in_progress", "stale replay must not say completed");
  assert.equal(prog.title, "exec: ls -la");

  // tc-re: turn-1's call+completion keep "step 1" (the completion's title
  // was stamped at ingest); turn-2's reuse shows "step 2" — the new title
  // must not retroactively relabel turn-1's log entries
  const re = tools.filter((e) => e.id === "tc-re");
  assert.equal(re.length, 4);
  assert.equal(re[0].title, "exec: step 1");
  assert.match(re[0].input ?? "", /"step":1/);
  assert.equal(re[1].title, "exec: step 1");
  assert.equal(re[2].title, "exec: step 2");
  assert.match(re[2].input ?? "", /"step":2/);
});

test("inspect wait: waits for new events past the snapshot cursor, not unread logs", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("w", "[[activetool]][[sleep:600]]");
  await untilEvent(ctl, "w", "tool_call");
  // turn_start + tool_call sit unread in the log (no logs poll ran): an
  // inspect wait must block for genuinely new activity, not busy-return.
  const t0 = Date.now();
  const p = await ctl.poll("w", 300);
  const dt = Date.now() - t0;
  assert.ok(
    dt >= 240,
    `inspect wait returned after ${dt}ms despite no new events — busy-returned on unread logs?`,
  );
  assert.equal(p.status, "running");
  // since = snapshot cursor: returns as soon as an event newer than it lands
  const p2 = await ctl.poll("w", 3000, p.cursor);
  assert.ok(p2.cursor > p.cursor, "wait must return after the head advanced");
  await untilStatus(ctl, "w", "idle");
  const p3 = await ctl.poll("w");
  assert.equal(p3.snapshot.turn.stopReason, "end_turn");
  assert.ok(p3.snapshot.turn.endedAt !== null);
});

test("inspect: agent death clears active tools and records lastError", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("cr", "[[activetool]][[die]]");
  await untilStatus(ctl, "cr", "dead");
  const p = await ctl.poll("cr");
  assert.equal(p.status, "dead");
  assert.equal(p.snapshot.activeTools.length, 0);
  assert.match(p.snapshot.lastError.message, /exit/i);
  assert.equal(p.snapshot.lastError.turn, 1);
  assert.ok(p.snapshot.lastError.at);
});

test("inspect: failed tool surfaces bounded error detail in lastError", async (t) => {
  const { ctl } = makeCtl(t);
  await ctl.spawn("ft", "[[failtool]] x");
  const { snapshot } = await untilDone(ctl, "ft");
  assert.equal(snapshot.activeTools.length, 0); // failed is terminal
  assert.match(snapshot.lastError.message, /tool failed: exec: false/);
  assert.match(snapshot.lastError.message, /boom: exited 1/);
  assert.equal(snapshot.lastError.turn, 1);
});

// Unit-level coverage for edges the serialized fake agent can't reproduce
// (id reuse across turns, stale settlements, cap eviction, death freeze).
const E = (ms) => new Date(ms).toISOString();

test("observe: tool events are stamped with ingest-time metadata", () => {
  const obs = createObservation();
  const ctx = { activeTurn: 1, turnSeq: 1 };
  recordObservation(
    obs, "tool_call",
    { toolCallId: "tc", title: "t1", status: "in_progress", rawInput: { a: 1 } },
    E(0), ctx,
  );
  // a bare update picks up the record's metadata at ingest time
  const d = { toolCallId: "tc" };
  recordObservation(obs, "tool_call_update", d, E(1), ctx);
  assert.equal(d.title, "t1");
  assert.equal(d.status, "in_progress");
  assert.equal(d.input, '{"a":1}');
  // the stamp is immutable — later completion does not rewrite history
  recordObservation(
    obs, "tool_call_update", { toolCallId: "tc", status: "completed" },
    E(2), ctx,
  );
  assert.equal(d.status, "in_progress");
  assert.equal(d.title, "t1");
});

test("observe: closed-tool cap never evicts open tools", () => {
  const obs = createObservation();
  const ctx = { activeTurn: 1, turnSeq: 1 };
  recordObservation(
    obs, "tool_call",
    { toolCallId: "open", title: "long-runner", status: "in_progress" },
    E(0), ctx,
  );
  for (let i = 0; i < 300; i++) {
    recordObservation(
      obs, "tool_call",
      { toolCallId: `done-${i}`, title: `t${i}`, status: "completed" },
      E(i + 1), ctx,
    );
  }
  const snap = buildSnapshot(obs, Date.now());
  assert.deepEqual(snap.activeTools.map((x) => x.id), ["open"]);
  assert.equal(obs.tools.size, 257); // 256 closed + the open one
});

test("observe: toolCallId reuse on a new turn resets lifecycle", () => {
  const obs = createObservation();
  recordObservation(
    obs, "tool_call",
    { toolCallId: "re", title: "exec: ls", status: "completed" },
    E(0), { activeTurn: 1, turnSeq: 1 },
  );
  recordObservation(
    obs, "turn_end", { turn: 1, stopReason: "end_turn" },
    E(1000), { activeTurn: 0, turnSeq: 1 },
  );
  // turn 2 reuses the id with a bare update carrying no status
  recordObservation(
    obs, "tool_call_update", { toolCallId: "re" },
    E(10_000), { activeTurn: 2, turnSeq: 2 },
  );
  const snap = buildSnapshot(obs, Date.parse(E(20_000)));
  const tool = snap.activeTools.find((x) => x.id === "re");
  assert.ok(tool, "reused id must be active on the new turn");
  assert.equal(tool.turn, 2);
  assert.equal(tool.startedAt, E(10_000));
  assert.equal(tool.elapsedMs, 10_000);
});

test("observe: a stale turn_end is scoped to its own turn's tools", () => {
  const obs = createObservation();
  const ctx = { activeTurn: 5, turnSeq: 5 };
  recordObservation(obs, "turn_start", { turn: 5 }, E(0), ctx);
  recordObservation(
    obs, "tool_call",
    { toolCallId: "t5", title: "exec: x", status: "in_progress" },
    E(1000), ctx,
  );
  // late settlement for an old turn: must not close turn-5 tools or times
  recordObservation(
    obs, "turn_end", { turn: 3, stopReason: "cancelled" }, E(2000), ctx,
  );
  const snap = buildSnapshot(obs, Date.parse(E(10_000)));
  assert.equal(snap.activeTools.length, 1);
  assert.equal(snap.turn.n, 5);
  assert.equal(snap.turn.endedAt, null);
  assert.equal(snap.turn.durationMs, 10_000);
});

test("observe: agent_exit freezes the running turn's duration", () => {
  const obs = createObservation();
  const ctx = { activeTurn: 1, turnSeq: 1 };
  recordObservation(obs, "turn_start", { turn: 1 }, E(0), ctx);
  recordObservation(
    obs, "agent_exit", { code: 3 }, E(5000), { activeTurn: 0, turnSeq: 1 },
  );
  const a = buildSnapshot(obs, Date.parse(E(6000)));
  const b = buildSnapshot(obs, Date.parse(E(20_000)));
  assert.equal(a.turn.durationMs, 5000);
  assert.equal(b.turn.durationMs, 5000); // frozen at death, not still counting
  // a turn_end settling after the exit keeps the death-time endedAt
  recordObservation(
    obs, "turn_end", { turn: 1, stopReason: "error" },
    E(5100), { activeTurn: 0, turnSeq: 1 },
  );
  const c = buildSnapshot(obs, Date.parse(E(30_000)));
  assert.equal(c.turn.durationMs, 5000);
  assert.equal(c.turn.stopReason, "error");
});

// ---------- review: model confirmation, resume preserves, config races ----------

test("model without agent confirmation fails (spawn and set_model)", async (t) => {
  const { ctl } = makeCtl(t, {
    env: { FAKE_ACP_CFG_NO_ECHO: "1" },
    model: "swe-2-high",
  });
  await assert.rejects(() => ctl.spawn("nc", "hi"), /did not confirm model/);

  const c2 = makeCtl(t, { env: { FAKE_ACP_CFG_NO_ECHO: "1" } }).ctl;
  await c2.spawn("nc2", "hi"); // no configured model -> nothing to confirm
  await untilDone(c2, "nc2");
  await assert.rejects(() => c2.setModel("nc2", "swe-2-high"), /did not confirm/);
  // failed switch leaves the confirmed model intact
  assert.equal(c2.models("nc2").model, "swe-2-max");
});

test("send during an in-flight set_model queues and runs after the switch", async (t) => {
  const { ctl } = makeCtl(t, { env: { FAKE_ACP_CFG_DELAY: "250" } });
  await ctl.spawn("r", "hi");
  await untilDone(ctl, "r");
  const switching = ctl.setModel("r", "swe-2-high"); // intentionally unawaited
  await sleep(30); // the RPC is in flight
  const q = await ctl.send("r", "on-new-model");
  assert.equal(q.queued, true, "send during model switch must queue");
  const sm = await switching;
  assert.equal(sm.model, "swe-2-high");
  const d = await untilDone(ctl, "r", 5000);
  assert.match(d.text, /fake reply: on-new-model/);
  // order: model event precedes the queued turn's turn_start
  const replay = await ctl.poll("r", 0, 0, "logs");
  const mi = replay.events.findIndex((e) => e.type === "model");
  const ti = replay.events.findIndex((e) => e.type === "turn_start" && e.turn === 2);
  assert.ok(mi >= 0 && ti > mi, "model switch must land before the queued turn");
  assert.equal(ctl.models("r").model, "swe-2-high");
});

test("spawn stays 'starting' until model setup finishes; racing send queues", async (t) => {
  const { ctl } = makeCtl(t, {
    env: { FAKE_ACP_CFG_DELAY: "250" },
    model: "swe-2-high",
  });
  const sp = ctl.spawn("s", "first");
  // wait until session/new returned but the model RPC is still in flight
  for (;;) {
    const s = ctl.registry.get("s");
    if (s?.sessionId) break;
    await sleep(10);
  }
  assert.equal(ctl.registry.get("s").status, "starting");
  const q = await ctl.send("s", "second");
  assert.equal(q.queued, true, "send during spawn setup must queue, not overtake");
  const r = await sp;
  assert.equal(r.model, "swe-2-high");
  const d = await untilDone(ctl, "s", 5000);
  const starts = d.events.filter((e) => e.type === "turn_start");
  assert.deepEqual(starts.map((e) => e.turn), [1, 2]);
  assert.match(starts[0].text, /first/);
  assert.match(starts[1].text, /second/);
});

test("resume preserves the session's own model/mode (agent reload + cross-bridge)", async (t) => {
  const { ctl, dir } = makeCtl(t, { model: "swe-2-max", mode: "smart" });
  await ctl.spawn("k", "hi");
  await untilDone(ctl, "k");
  await ctl.setModel("k", "swe-2-high");
  await ctl.setMode("k", "bypass");
  ctl.acp.kill();
  await untilStatus(ctl, "k", "dead");
  // reloaded fake loses per-session config -> defaults; bridge must
  // re-assert the session's remembered selection, not cfg defaults
  const r = await ctl.resume("k");
  assert.equal(r.status, "idle");
  assert.equal(ctl.models("k").model, "swe-2-high");
  assert.equal(ctl.models("k").mode, "bypass");

  // cross-bridge: a fresh Controller over the same state file resumes the
  // session and restores its persisted selection (swe-2-medium here)
  await ctl.setModel("k", "swe-2-medium");
  const ctl2 = new Controller({
    command: process.execPath,
    args: [FAKE], // fresh fake process: session model is back at default
    cwd: dir,
    statePath: path.join(dir, "state.json"),
    permission: "auto",
    rpcTimeoutMs: 2000,
    onLog: () => {},
  });
  t.after(() => ctl2.close());
  const r2 = await ctl2.resume("k");
  assert.equal(r2.status, "idle");
  assert.equal(ctl2.models("k").model, "swe-2-medium");
  assert.equal(ctl2.models("k").mode, "bypass");
});

// ---------- sessions.hidden marking (sessiondb) ----------

const { DatabaseSync } = await import("node:sqlite").catch(() => ({}));

function makeSessionDbFile(t, cols = "id TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0") {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-sdb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "sessions.db");
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sessions (${cols})`);
    db.close();
  }
  return { dir, dbPath };
}

test("sessiondb: markHidden flips flag, is idempotent, tolerates missing rows", async (t) => {
  if (!DatabaseSync) return t.skip("node:sqlite unavailable");
  const { dbPath } = makeSessionDbFile(t);
  const sdb = new SessionDb(dbPath);
  t.after(() => sdb.close());
  const seed = new DatabaseSync(dbPath);
  seed.prepare("INSERT INTO sessions (id, hidden) VALUES (?, 0)").run("sess-1");
  seed.prepare("INSERT INTO sessions (id, hidden) VALUES (?, 0)").run("sess-2");
  seed.close();
  assert.deepEqual(sdb.markHidden(["sess-1", "ghost"]), ["sess-1"]);
  assert.deepEqual(sdb.markHidden(["sess-1", "sess-2"]), ["sess-1", "sess-2"]);
  const check = new DatabaseSync(dbPath);
  const rows = check
    .prepare("SELECT id, hidden FROM sessions ORDER BY id")
    .all()
    .map((r) => ({ id: r.id, hidden: r.hidden })); // rows have null prototype
  check.close();
  assert.deepEqual(rows, [
    { id: "sess-1", hidden: 1 },
    { id: "sess-2", hidden: 1 },
  ]);
});

test("sessiondb: missing file never creates one; missing column disables cleanly", async (t) => {
  if (!DatabaseSync) return t.skip("node:sqlite unavailable");
  const { dir } = makeSessionDbFile(t);
  const absent = path.join(dir, "nope.db");
  const logs = [];
  const s1 = new SessionDb(absent, (l) => logs.push(l));
  assert.deepEqual(s1.markHidden(["x"]), []);
  assert.equal(existsSync(absent), false, "must not create devin's db file");
  assert.ok(logs.some((l) => /not found/.test(l)));

  const { dbPath } = makeSessionDbFile(t, "id TEXT PRIMARY KEY"); // no hidden col
  const s2 = new SessionDb(dbPath, (l) => logs.push(l));
  assert.deepEqual(s2.markHidden(["x"]), []);
  assert.ok(logs.some((l) => /disabled/.test(l)));
});

test("hiding: spawned session flips to hidden once its row persists", async (t) => {
  if (!DatabaseSync) return t.skip("node:sqlite unavailable");
  const { dbPath } = makeSessionDbFile(t);
  const { ctl } = makeCtl(t, {
    hideFromSessionList: true,
    sessionDbPath: dbPath,
  });
  const r = await ctl.spawn("h", "hi");
  // devin persists the row lazily (first prompt) — pre-row it stays pending
  let listed = await ctl.list();
  assert.equal(listed.subagents[0].hidden, false);
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO sessions (id, hidden) VALUES (?, 0)").run(r.sessionId);
  await ctl.poll("h");
  assert.equal(
    db.prepare("SELECT hidden FROM sessions WHERE id = ?").get(r.sessionId)
      .hidden,
    1,
  );
  listed = await ctl.list();
  assert.equal(listed.subagents[0].hidden, true);
  db.close();
  await untilDone(ctl, "h");
});

test("hiding: disabled config leaves sessions listed and omits the field", async (t) => {
  const { ctl } = makeCtl(t, { hideFromSessionList: false });
  await ctl.spawn("n", "hi");
  await untilDone(ctl, "n");
  const listed = await ctl.list();
  assert.equal(listed.subagents[0].hidden, undefined);
});

test("config: hideFromSessionList/sessionDbPath parsing", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, "c.json"),
    JSON.stringify({ hideFromSessionList: false, sessionDbPath: "db/s.db" }),
  );
  const d = loadBridgeConfig(["--config", "c.json"], dir);
  assert.equal(d.config.hideFromSessionList, false);
  assert.equal(d.config.sessionDbPath, path.join(dir, "db", "s.db"));
  assert.ok(d.specified.has("hideFromSessionList"));

  const w = (obj) => {
    writeFileSync(path.join(dir, "x.json"), obj);
    return ["--config", path.join(dir, "x.json")];
  };
  assert.throws(() => loadBridgeConfig(w('{"hideFromSessionList": "yes"}'), dir), /boolean/);
  assert.throws(() => loadBridgeConfig(w('{"sessionDbPath": 5}'), dir), /non-empty/);
});

// ---------- parent notifications (report tool + notify hub) ----------

const CHILD = fileURLToPath(new URL("../dist/child.js", import.meta.url));

/** A fake `codex` binary: logs its argv (one arg per line) to a file. */
function codexStub(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-codex-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "args.log");
  const stub = path.join(dir, "codex-stub.sh");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\n`);
  chmodSync(stub, 0o755);
  return { stub, log };
}

const readLines = (p) =>
  existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];

async function untilFile(p, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    if (existsSync(p) && readFileSync(p, "utf8").trim()) {
      return readFileSync(p, "utf8");
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${p}`);
    await sleep(20);
  }
}

function makeHub(t, dir, opts = {}) {
  const hub = new NotifyHub({
    mailboxPath: path.join(dir, "mailbox.jsonl"),
    notifyPath: path.join(dir, "notify.json"),
    codexCommand: opts.codexCommand ?? "definitely-not-codex",
    thread: opts.thread,
    onLog: () => {},
  });
  t.after(() => hub.close());
  return hub;
}

test("child: report tool call lands in the mailbox", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-child-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mailbox = path.join(dir, "mailbox.jsonl");
  const child = spawn(
    process.execPath,
    [CHILD, "--name", "kid", "--mailbox", mailbox],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => child.kill());
  const rl = createInterface({ input: child.stdout });
  const replies = new Map();
  rl.on("line", (l) => {
    const m = JSON.parse(l);
    if (m.id !== undefined) replies.set(m.id, m);
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const waitReply = async (id, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (replies.has(id)) return replies.get(id);
      if (Date.now() > end) throw new Error(`timeout waiting for reply ${id}`);
      await sleep(15);
    }
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  const init = await waitReply(1);
  assert.equal(init.result.serverInfo.name, "devin-subagents-parent");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "report", arguments: { message: "checkpoint one" } },
  });
  const res = await waitReply(2);
  assert.match(res.result.content[0].text, /reported/);
  const lines = readLines(mailbox).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, "kid");
  assert.equal(lines[0].text, "checkpoint one");
});

test("notify: no thread -> inbox; register flushes via codex queue", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-notify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { stub, log } = codexStub(t);
  const hub = makeHub(t, dir, { codexCommand: stub });

  hub.deliver({ name: "a", at: 1, text: "hello parent" });
  assert.equal(hub.status().inbox, 1);

  hub.register("thread-9");
  const out = await untilFile(log);
  assert.match(out, /queue/);
  assert.match(out, /--thread/);
  assert.match(out, /thread-9/);
  assert.match(out, /\[devin-subagents\] a: hello parent/);
  assert.equal(hub.status().delivered, 1);
  assert.equal(hub.status().inbox, 0);
  // thread persisted for a bridge restart
  assert.match(readFileSync(path.join(dir, "notify.json"), "utf8"), /thread-9/);
  assert.equal(hub.unregister().thread, null);
});

test("notify: mailbox lines are drained and delivered", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-notify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { stub, log } = codexStub(t);
  const hub = makeHub(t, dir, { codexCommand: stub, thread: "thread-7" });
  const mailbox = path.join(dir, "mailbox.jsonl");
  appendFileSync(
    mailbox,
    JSON.stringify({ name: "kid", at: 2, text: "from child" }) + "\n",
  );
  hub.drainMailbox();
  const out = await untilFile(log);
  assert.match(out, /\[devin-subagents\] kid: from child/);
  // idempotent: a second drain does not redeliver
  hub.drainMailbox();
  await sleep(100);
  assert.equal(hub.status().delivered, 1);
});

test("notify: queue failure falls back to inbox, retried on register", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-notify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const failStub = path.join(dir, "fail.sh");
  writeFileSync(failStub, "#!/bin/sh\nexit 1\n");
  chmodSync(failStub, 0o755);
  const hub = makeHub(t, dir, { codexCommand: failStub, thread: "t-x" });
  hub.deliver({ name: "a", at: 1, text: "lost?" });
  const end = Date.now() + 3000;
  while (hub.status().inbox < 1 && Date.now() < end) await sleep(20);
  assert.equal(hub.drainInbox()[0].text, "lost?");
});

test("wiring: spawn injects report MCP + hint; turn_end hits codex queue", async (t) => {
  const { stub, log } = codexStub(t);
  const { ctl, dir } = makeCtl(t, {
    codexCommand: stub,
    notifyThread: "thread-42",
    env: (d) => ({ FAKE_ACP_PARAM_LOG: path.join(d, "params.jsonl") }),
  });
  await ctl.spawn("w", "do it");
  await untilDone(ctl, "w");

  const out = await untilFile(log);
  assert.match(out, /--thread/);
  assert.match(out, /thread-42/);
  assert.match(out, /\[devin-subagents\] w: turn 1 ended \(end_turn\)/);

  const params = readLines(path.join(dir, "params.jsonl")).map((l) =>
    JSON.parse(l),
  );
  const nw = params.find((p) => p.method === "session/new");
  const spec = nw.params.mcpServers[0];
  assert.equal(spec.name, "devin-subagents");
  assert.equal(spec.type, "stdio");
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(
    spec.args.filter((a) => a === "--name" || a === "--mailbox").length,
    2,
  );
  // the spawn task carried the report-tool hint
  const s = ctl.registry.get("w");
  const ts = s.events.find((e) => e.kind === "turn_start");
  assert.match(ts.data.text, /`report` tool/);
});

test("reportTool off: no mcpServers injected and no hint", async (t) => {
  const { ctl, dir } = makeCtl(t, {
    reportTool: false,
    env: (d) => ({ FAKE_ACP_PARAM_LOG: path.join(d, "params.jsonl") }),
  });
  await ctl.spawn("x", "plain task");
  const params = readLines(path.join(dir, "params.jsonl")).map((l) =>
    JSON.parse(l),
  );
  const nw = params.find((p) => p.method === "session/new");
  assert.deepEqual(nw.params.mcpServers, []);
  const ts = ctl.registry.get("x").events.find((e) => e.kind === "turn_start");
  assert.equal(ts.data.text, "plain task");
  await untilDone(ctl, "x");
});

test("autoNotify: operator-mode permission_request reaches the queue", async (t) => {
  const { stub, log } = codexStub(t);
  const { ctl } = makeCtl(t, {
    policy: "operator",
    codexCommand: stub,
    notifyThread: "th-1",
  });
  await ctl.spawn("p", "[[perm]]");
  await untilEvent(ctl, "p", "permission_request");
  const out = await untilFile(log);
  assert.match(out, /requests permission: Run dangerous command/);
  ctl.permission("p", "allow_once");
  await untilDone(ctl, "p");
});

test("inbox: undelivered notices surface via notifyInbox()", async (t) => {
  const { ctl, dir } = makeCtl(t); // no thread registered
  appendFileSync(
    `${dir}/state.json.mailbox.jsonl`,
    JSON.stringify({ name: "k", at: 1, text: "hi parent" }) + "\n",
  );
  const inbox = ctl.notifyInbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].name, "k");
  assert.equal(inbox[0].text, "hi parent");
  assert.equal(ctl.notifyInbox().length, 0); // consumed
});

test("notify tool: register/status/unregister via controller", async (t) => {
  const { stub, log } = codexStub(t);
  const { ctl, dir } = makeCtl(t, { codexCommand: stub });
  assert.equal(ctl.notify().thread, null);
  const st = ctl.notify("thread-live");
  assert.equal(st.thread, "thread-live");
  assert.match(
    readFileSync(`${dir}/state.json.notify.json`, "utf8"),
    /thread-live/,
  );
  assert.equal(ctl.notify(undefined, true).thread, null);
});

test("config: notify/report keys parse with defaults and validation", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const def = loadBridgeConfig([], dir); // no config file
  assert.equal(def.config.codexCommand, "codex");
  assert.equal(def.config.reportTool, true);
  assert.equal(def.config.autoNotify, true);
  assert.equal(def.config.reportHint, true);
  assert.equal(def.config.notifyThread, undefined);

  writeFileSync(
    path.join(dir, "c.json"),
    JSON.stringify({
      notifyThread: "abc-123",
      codexCommand: "./cx",
      reportTool: false,
      autoNotify: false,
      reportHint: false,
    }),
  );
  const d = loadBridgeConfig(["--config", "c.json"], dir);
  assert.equal(d.config.notifyThread, "abc-123");
  assert.equal(d.config.codexCommand, path.join(dir, "cx")); // path → resolved
  assert.equal(d.config.reportTool, false);
  assert.equal(d.config.autoNotify, false);
  assert.equal(d.config.reportHint, false);

  const w = (obj) => {
    writeFileSync(path.join(dir, "x.json"), obj);
    return ["--config", path.join(dir, "x.json")];
  };
  assert.throws(() => loadBridgeConfig(w('{"reportTool": "yes"}'), dir), /boolean/);
  assert.throws(() => loadBridgeConfig(w('{"autoNotify": 1}'), dir), /boolean/);
  assert.throws(() => loadBridgeConfig(w('{"notifyThread": " "}'), dir), /non-empty/);
  assert.throws(() => loadBridgeConfig(w('{"codexCommand": 5}'), dir), /non-empty/);
});
