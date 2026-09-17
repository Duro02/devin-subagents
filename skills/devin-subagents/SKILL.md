---
name: devin-subagents
description: Delegate independent implementation/research tasks to Devin subagents through the devin-subagents MCP bridge (spawn/wait/poll/send/interrupt/stop/resume). Use when the user asks for Devin subagents, mentions devin-subagents or spawn/wait, or wants work dispatched to Devin.
---

# Devin subagents via the devin-subagents MCP

The `devin` MCP server exposes Devin ACP sessions as subagents. `spawn` is async and returns immediately; `wait` is a blocking "call me when it needs attention" tool.

## Core workflow

1. `spawn(name, task, cwd?, mode?, model?)` — returns at once; the subagent works in the background. Write the task self-contained: goal, constraints, verification expected. Pass the intended project's absolute `cwd`; an MCP installed through a plugin may itself run from the plugin directory, which is not the desired worktree.
2. Pick the wait strategy by what **you** have left to do — never probe the harness for its wake semantics:
   - Work remains (other subagents, your own tasks)? Don't freeze the turn: put `wait` in the harness's background-task mechanism if it offers one, or just keep working — pending notices also ride the `inbox` field of every tool result.
   - Nothing left? Call `wait` directly and let it block until a `wake` fires; a frozen turn costs nothing when waiting is all you're doing.

   A background `wait` that outlives your turn may never deliver its result — fine, the notice is already in the inbox. If you hold a bg wait's handle, collect it via the harness's native result mechanism before ending the turn.
3. `wake` field of a wait result:
   - `done` — turn drained to idle; `output` carries the finished turn's full text (truncated past 64k flags — pull the rest via `poll(detail:"logs")` if flagged).
   - `timeout` — still running. **Not a failure**: the result carries a live snapshot; call `wait` again. Keep `timeout_ms` comfortably under the host's tool-call limit — a host-side timeout is a bare error with no snapshot (default 600s, bridge cap 1h).
   - `report` — the subagent pushed a checkpoint via its `report` tool; see `report.text`. Reports are delivered once each.
   - `permission` — answer with `permission(name, optionId)` using `pendingPermission.options`.
   - `stopped`/`dead` — terminal; `resume(name)` revives (survives bridge restarts).
4. Steer with `send` (FIFO-queued while a turn runs; starts as the next turn), `interrupt` (cancel current turn, keep session), `stop`/`resume` for lifecycle.
5. `poll`/`list` are inspection tools, not a waiting mechanism. Reach for them only to diagnose a suspected stall (`pendingPermission`, `activeTools[].elapsedMs`, `lastActivity.elapsedMs`, or `detail="logs"` for the event stream) or to audit what a subagent did — never poll in a loop to wait.

## Verify before accepting

Never trust a subagent's self-report. Check its `poll` snapshot/logs, then verify the actual `git diff` and run the relevant tests yourself before treating its work as done.
