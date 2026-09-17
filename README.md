# devin-subagents

简体中文: [README_zh.md](README_zh.md)

Expose `devin acp` sessions as lifecycle-managed subagents over MCP: parallel dispatch, blocking coordination, mid-flight steering, permission adjudication, and crash-resilient session persistence.

```
MCP Host ──stdio/MCP──▶ devin-subagents ──stdio/ACP──▶ devin acp
```

- **Async dispatch**: `spawn` starts a background Devin session and returns immediately (`{status: "running"}`).
- **Blocking coordination**: `wait` blocks until the subagent completes, reports progress, requests permissions, or times out.
- **Direct delivery**: `wake="done"` delivers the complete turn output directly in `output.text`—no secondary query needed.
- **Inbox piggybacking**: Unread completion notices and `report()` checkpoints automatically ride along in the `inbox` field of subsequent MCP tool responses.
- **Hidden sessions**: Subagent sessions are marked hidden by default to keep host session lists clutter-free.

---

## Requirements

- **Node.js ≥ 20** (Session hiding requires `node:sqlite` in Node ≥ 22.5; older versions gracefully degrade without breaking core functionality).
- **Authenticated `devin` CLI** (The bridge manages a background `devin acp` process).

---

## Installation

### Standard Setup

1. **Clone & Build**:
   ```bash
   git clone https://github.com/Duro02/devin-subagents.git
   cd devin-subagents
   npm ci && npm run build
   ```

2. **Register MCP Server**:
   Add to your MCP host configuration:
   ```json
   {
     "mcpServers": {
       "devin": {
         "command": "node",
         "args": ["/path/to/devin_subagents/dist/index.js"],
         "cwd": "/path/to/devin_subagents"
       }
     }
   }
   ```
   > **Note**: The server's `cwd` determines the resolution path for `.devin-subagents.json` (state persistence) and optional `devin-subagents.config.json`. If your host cannot pin `cwd`, pass `--config /path/to/config.json` in `args` and specify an absolute `statePath` in your config.

3. **Install Skill**:
   ```bash
   npx skills add Duro02/devin-subagents -g -a <harness>
   ```
   Or manually copy or symlink `skills/devin-subagents/` to your host's skills directory.

### Agent Self-Installation (Recommended)

Paste this prompt directly to your host agent:

```text
Install devin-subagents into this harness—both the stdio MCP server and the skill. Source: https://github.com/Duro02/devin-subagents (use an existing local clone if available).

1. Clone to a stable directory and run `npm ci && npm run build` inside the repository.
2. Register a stdio MCP server named `devin` following this harness's conventions: `node <clone_dir>/dist/index.js`, pinning the server cwd to <clone_dir>.
3. Install the skill: `npx skills add Duro02/devin-subagents -g -a <this_harness>`; if that fails, copy or symlink `skills/devin-subagents/` into its user-level skill directory.
4. Verify the MCP server is registered and the skill is visible, then prompt me to restart or reload the harness.
```

---

## Usage

```
spawn("coder-auth", "Implement JWT middleware in src/auth and add unit tests", cwd="/path/to/project")
  → returns immediately: {status: "running"}    # devin acp runs in the background

wait("coder-auth", 240000)                      # blocks until attention is needed
  → wake="done"        output.text = full turn output (deliverables here, no extra query)
  → wake="report"      subagent called report(message) checkpoint
  → wake="permission"  permission request pending → adjudicate with permission("coder-auth", optionId)
  → wake="timeout"     still running, returns live snapshot; call wait again to continue
  → wake="stopped"|"dead" subagent stopped or exited; revive with resume("coder-auth")
  → wake="cancelled"   wait aborted by cancellation signal; underlying turn continues
```

### Coordination Patterns

- **Work remains**: If the host supports background tasks, run `wait` in the background, or continue with other tasks—completion notices and `report()` updates will automatically arrive via the `inbox` field of subsequent tool results.
- **No work remains**: Call `wait` directly to block until an event wakes it.
- **Timeout safety**: Keep `timeout_ms` below your host's tool execution deadline (a host-level hard cutoff yields an unhandled error instead of a structured `timeout` snapshot).
- **Mid-flight steering**: Use `send` to append instructions (queued in FIFO order during active turns, strictly serialized per session), `interrupt` to cancel the in-flight turn and clear the queue (retains the session), or `stop` / `resume` for lifecycle transitions.
- **Inspection over polling**: Always use `wait` to wait—never poll in a loop with `poll`. Use `poll` solely for diagnostics: `detail="inspect"` provides a live snapshot with `activeTools[].elapsedMs` to spot stalled tools; `detail="logs"` retrieves the chronological event stream.
- **Session visibility**: Subagents are marked hidden by default to avoid cluttering `/resume`, `devin list`, and ACP `session/list` (set `hideFromSessionList: false` to disable).

---

## Tools

| Tool | Description |
| --- | --- |
| `spawn(name, task, cwd?, mode?, model?)` | Launch a Devin subagent asynchronously; returns `{status: "running"}` immediately. |
| `wait(name, timeout_ms?)` | Block until attention is needed (`done`, `report`, `permission`, `timeout`, `stopped`, `dead`, `cancelled`). On `done`, carries full `output` text. |
| `send(name, text)` | Append follow-up instructions. Queued FIFO during an active turn; strictly serialized per session. |
| `poll(name, wait_ms?, since?, detail?, limit?)` | Inspect state: `detail="inspect"` (default) for persistent live snapshot; `detail="logs"` for paged chronological event stream. |
| `permission(name, optionId?)` | Adjudicate a pending permission request (provide `optionId` to approve, omit to deny). |
| `interrupt(name)` | Cancel the in-flight turn (`session/cancel`) and clear the pending FIFO queue; keeps session intact. |
| `stop(name)` | Interrupt running turn, clear queue, and mark the session stopped. |
| `resume(name)` | Re-activate a stopped, dead, or persisted session (survives bridge restarts). |
| `list()` | List all live, persisted, and agent-side sessions with status. |
| `set_mode(name, mode)` | Switch session permission mode (e.g. `smart`, `bypass`). |
| `models(name?)` | Query advertised models and modes (session-specific or bridge defaults). |
| `set_model(name, model)` | Switch the model for an idle session (e.g. `swe-2-max`, `swe-2-high`). |

---

## Configuration

Optional. Place `devin-subagents.config.json` in the server's working directory or specify via `--config PATH`. The configuration schema is strict: unknown keys will cause an error on startup.

| Key | Default | Description |
| --- | --- | --- |
| `command` | `"devin"` | Agent executable command (resolved via PATH or relative to config file). |
| `args` | `["acp"]` | Command-line arguments passed to the agent process. |
| `statePath` | `".devin-subagents.json"` | Path for name→sessionId persistence map (survives bridge restarts). |
| `permission` | `"operator"` | Permission policy: `"auto"`/`"always"` to auto-approve, or `"operator"` to hold for host decision. |
| `mode` | `"smart"` | Default permission mode for new sessions. |
| `model` | `"swe-2-max"` | Default model confirmed for new sessions. |
| `rpcTimeoutMs` | `30000` | Timeout in milliseconds for non-prompt ACP RPC calls. |
| `bufferCap` | `500` | Maximum capacity of each session's event ring buffer. |
| `hideFromSessionList` | `true` | Mark sessions with `hidden=1` in Devin session database to hide from session lists. |
| `reportTool` | `true` | Inject `report(message)` checkpoint tool into subagents. |
| `autoNotify` | `true` | Automatically enqueue completion and permission events into the `inbox` field. |
| `reportHint` | `true` | Append a hint to the spawn prompt informing the subagent of the `report` tool. |

Full example: `devin-subagents.config.example.json`.

---

## Development

```bash
npm test         # Deterministic unit tests with built-in mock ACP agent (no external services needed)
npm run smoke    # Smoke handshake test against a real agent
npm run e2e      # End-to-end integration test (requires Devin credentials)
```
