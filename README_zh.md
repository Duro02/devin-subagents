# devin-subagents

English: [README.md](README.md)

将 `devin acp` 会话暴露为受生命周期管理的 MCP 子代理：支持并发派发、阻塞协同、中途干预、权限裁决与跨进程状态恢复。

```
MCP 宿主 ──stdio/MCP──▶ devin-subagents ──stdio/ACP──▶ devin acp
```

- **异步派发**：`spawn` 启动后台 Devin 会话并立即返回 `{status: "running"}`，主代理无需等待。
- **阻塞协同**：`wait` 阻塞等待子代理完成、汇报进度、请求权限或超时唤醒。
- **直接交付**：`wake="done"` 直接在 `output.text` 中携带当 turn 完整输出，无需额外查询。
- **Inbox 捎带**：未读的完成通知与 `report()` 汇报会自动附加在后续任何工具调用的 `inbox` 字段中返回。
- **隐藏会话**：子代理会话默认标记为隐藏，不出现在会话列表中，保持环境整洁。

---

## 环境要求

- **Node.js ≥ 20**（会话隐藏特性依赖 Node ≥ 22.5 的 `node:sqlite`；低于此版本自动降级为普通会话，不影响核心功能）。
- **已登录的 `devin` CLI**（桥接服务在后台拉起 `devin acp` 进程）。

---

## 安装

### 手动安装

1. **注册 MCP Server**：
   在宿主配置中添加（各宿主语法不同、语义等价）：
   ```json
   {
     "mcpServers": {
       "devin": {
         "command": "npx",
         "args": ["-y", "devin-subagents"]
       }
     }
   }
   ```
   > **注意**：server 的 `cwd` 决定 `.devin-subagents.json`（会话状态映射）与可选配置文件 `devin-subagents.config.json` 的解析路径。若宿主无法固定 `cwd`，请在 `args` 末尾追加 `--config /path/to/config.json`，并在配置中将 `statePath` 设为绝对路径。

2. **安装 Skill**：
   ```bash
   npx skills add Duro02/devin-subagents -g -a <harness>
   ```
   或手动将 `skills/devin-subagents/` 目录复制或软链接到宿主的 skills 目录。

### 让 Agent 代装（推荐）

将以下提示词直接发送给主代理：

```text
把 devin-subagents 装进你这台 harness——一个 stdio MCP server 加一个 skill，两样都要装。源码：https://github.com/Duro02/devin-subagents（本地已有克隆的话直接用）。

1. 按你这台 harness 的惯例，注册名为 `devin` 的 stdio MCP server：`npx -y devin-subagents`。
2. 装 skill：`npx skills add Duro02/devin-subagents -g -a <这台harness>`；不行就把 `skills/devin-subagents/` 复制/软链到它的用户级 skill 目录。
3. 验证 MCP server 已注册、skill 可见，然后提示我重启/reload harness。
```

---

## 用法

```
spawn("coder-auth", "在 src/auth 里实现 JWT 中间件并补齐单元测试", cwd="/path/to/project")
  → 立即返回 {status: "running"}          # devin acp 在后台运行

wait("coder-auth", 240000)                # 阻塞直到需要关注
  → wake="done"        output.text = 该 turn 完整输出（交付物在此，无需额外查询）
  → wake="report"      子代理主动调用了 report() 检查点
  → wake="permission"  权限请求挂起 → 调用 permission("coder-auth", optionId) 裁决
  → wake="timeout"     仍在运行，附带实时快照；可继续调用 wait 等待下一轮
  → wake="stopped"|"dead" 子代理已停止或退出；可调用 resume("coder-auth") 恢复
  → wake="cancelled"   等待调用被取消信号中断；底层 Devin turn 仍继续运行
```

### 协同模式

- **还有其他任务处理**：若宿主支持后台任务，可将 `wait` 放入后台执行；或直接继续处理其他工作——完成通知与 `report` 汇报会自动随下一次任意工具调用的 `inbox` 字段捎带返回。
- **当前无其他任务**：直接同步调用 `wait` 阻塞等待唤醒。
- **合理设置超时**：`timeout_ms` 请务必低于宿主自身的工具调用硬上限（若被宿主强制掐断只会得到裸错误，而无法获取桥返回的结构化 `timeout` 快照）。
- **中途干预**：使用 `send` 追加指令（turn 进行中进入 FIFO 队列排队，会话内严格串行执行）；使用 `interrupt` 中断当前 turn 并清空待发队列（保留会话）；使用 `stop` 与 `resume` 进行生命周期管理。
- **排查审计而非轮询**：等待请始终使用 `wait`，切勿循环调用 `poll`。`poll` 仅用于按需诊断（`detail="inspect"` 获取包含 `activeTools[].elapsedMs` 的实时快照以定位卡死工具；`detail="logs"` 分页读取时序事件流）。
- **隐藏会话**：子代理会话默认标记为隐藏，不出现在 `/resume`、`devin list` 以及 ACP 的 `session/list` 中（可通过配置 `hideFromSessionList: false` 关闭）。

---

## 工具列表

| 工具 | 说明 |
| --- | --- |
| `spawn(name, task, cwd?, mode?, model?)` | 异步启动 Devin 子代理，立即返回 `{status: "running"}`。 |
| `wait(name, timeout_ms?)` | 阻塞等待子代理事件（`done`、`report`、`permission`、`timeout`、`stopped`、`dead`、`cancelled`）；`done` 直接附带 `output` 完整文本。 |
| `send(name, text)` | 追加后续指令。turn 进行中进入 FIFO 队列排队，会话内严格串行执行。 |
| `poll(name, wait_ms?, since?, detail?, limit?)` | 状态观察：`detail="inspect"`（默认）获取实时快照；`detail="logs"` 分页读取时序事件流。 |
| `permission(name, optionId?)` | 裁决挂起的权限请求（传入 `optionId` 批准，省略则拒绝）。 |
| `interrupt(name)` | 中断当前正在执行的 turn（`session/cancel`）并清空待发队列，保留会话。 |
| `stop(name)` | 中断当前 turn、清空排队消息并将状态置为已停止。 |
| `resume(name)` | 重新激活已停止、退出或持久化的会话（桥重启后依然可恢复）。 |
| `list()` | 列出所有活动、已持久化及 agent 侧的会话状态一览。 |
| `set_mode(name, mode)` | 切换会话权限模式（如 `smart`、`bypass`）。 |
| `models(name?)` | 查询会话当前或桥默认声明的模型与模式能力列表。 |
| `set_model(name, model)` | 切换空闲会话使用的模型（如 `swe-2-max`、`swe-2-high`）。 |

---

## 配置

配置项完全可选。将 `devin-subagents.config.json` 放置在 server 工作目录，或通过 `--config PATH` 显式指定。配置文件采用严格 Schema 校验，存在未知键时启动报错。

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `command` | `"devin"` | agent 可执行命令（支持 PATH 查找或相对于配置目录的路径）。 |
| `args` | `["acp"]` | 启动 agent 进程时传入的命令行参数。 |
| `statePath` | `".devin-subagents.json"` | name→sessionId 映射落盘路径（桥重启不丢会话）。 |
| `permission` | `"operator"` | 权限策略：`"auto"`/`"always"` 自动放行；`"operator"` 挂起请求等待主代理裁决。 |
| `mode` | `"smart"` | 新建会话时的默认权限模式。 |
| `model` | `"swe-2-max"` | 新建会话时的默认确认模型。 |
| `rpcTimeoutMs` | `30000` | 非 prompt 类的 ACP RPC 超时时间（毫秒）。 |
| `bufferCap` | `500` | 每个会话事件环形缓冲区的容量上限。 |
| `hideFromSessionList` | `true` | 在 Devin 会话数据库中标记 `hidden=1`，不出现在会话列表中。 |
| `reportTool` | `true` | 为子代理注入 `report(message)` 进度汇报工具。 |
| `autoNotify` | `true` | 完成通知与权限请求事件自动进入 `inbox` 捎带返回。 |
| `reportHint` | `true` | spawn 时在任务末尾追加提示，告知子代理可以使用 `report` 工具。 |

完整模板参考 `devin-subagents.config.example.json`。

---

## 开发

```bash
npm test         # 确定性单元测试（内置 fake ACP agent，不依赖外部服务）
npm run smoke    # 对真实 agent 进行握手冒烟测试
npm run e2e      # 端到端集成测试（需要有效的 devin 凭据）
```
