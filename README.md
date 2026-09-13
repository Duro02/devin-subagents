# devin_subagents

把 `devin acp` 的会话暴露成 MCP 工具,让 Codex(或任何 MCP client)像管理子代理一样管理 Devin:并行派发、中途查看输出、FIFO 排队注入、中断、停止后恢复。

```
Codex CLI ──stdio/MCP──▶ devin-subagents(本仓库)──stdio/ACP──▶ devin acp
```

**生命周期模型**:桥进程由 Codex 在会话启动时拉起(stdio MCP 的标准语义),Codex 退出时桥带着 `devin acp` 子进程一起退出。会话本体持久化在 Devin 自己的 session DB 里,桥只把 `session_id` 记到 `.devin-subagents.json`,所以**桥重启后 `resume` 照样恢复旧会话**。`devin acp` 进程崩溃/启动失败后,下一次需要它的调用会自动重启进程;已注册会话标记 `dead`,逐个 `resume`(走 `session/load`)即可复活。

## 工具面(12 个)

| 工具 | 对应 ACP | 说明 |
| --- | --- | --- |
| `spawn(name, task, cwd?, mode?, model?)` | `session/new` + `session/set_mode`/`set_config_option` + `session/prompt` | 后台起一个子代理,立即返回 `{status:"running", turn:1, mode, model}`;session 保持 `starting` 直到 mode/model 应用完毕,期间的 `send` 一律排队,不会越过初始 prompt;model 要求 agent 回执 `currentValue` 精确等于请求值,不确认即失败 |
| `send(name, text)` | `session/prompt` | 追加指令;turn 进行中(或上一次 cancel 尚未结算)**进 FIFO 队列**,当前 turn 结束后作为新 turn 依次发出——每个会话严格串行,不会并发 prompt |
| `poll(name, wait_ms?, since?, detail?, limit?)` | `session/update` 缓冲 + 快照状态 | 两档观察:`detail="inspect"`(默认)返回持久快照;`detail="logs"` 返回规范化事件日志(见下) |
| `interrupt(name)` | `session/cancel` | 中断当前 turn **并清空待发队列**,会话保留 |
| `stop(name)` | cancel + 标记 | 同上,另标记 `stopped`(可 `resume`)并落盘 |
| `resume(name)` | `session/load` | 恢复 stopped/dead/持久化会话;对 running/idle 是安全 no-op。**保留会话自己的选择**——落盘的 mode/model 在 reload 后重新断言,不会被桥的默认值覆盖 |
| `list()` | `session/list` + 本地注册表 | 看所有子代理状态(`agentAlive`、`agentSessions`、`agentSessionsError?`) |
| `notify(thread?, off?)` | `codex queue`(外部通道) | 注册接收子代理通知的 Codex 会话;注册后 turn 结束、权限请求、子代理 `report()` 调用都会以排队消息形式推进该会话(见"子代理主动汇报"节);无参查询状态,`off:true` 注销 |
| `permission(name, optionId?)` | `session/request_permission` 应答 | `permission=operator` 时由主代理裁决权限;`optionId` 必须是 `pendingPermission.options` 之一 |
| `set_mode(name, mode)` | `session/set_mode`(不支持时回落 `session/set_config_option {configId:"mode"}`) | 切会话权限模式;若已知 `availableModes` 会先校验 |
| `models(name?)` | 本地能力缓存 | 带 `name`:该会话的当前 model/mode 与广告列表;不带:桥的默认配置 + 迄今为止任何会话广告过的列表(首次会话建立前为 `null`) |
| `set_model(name, model)` | `session/set_config_option {configId:"model"}` | 切**空闲**会话的 model;starting/running/stopped/dead 一律拒绝;返回值是 agent 确认后的 `currentValue` |

**状态机**:`starting`(claim 已占名,session/new 在途) → `running` ⇄ `idle` → `stopped` / `dead` → `resume` 复活。
`send` 对 `stopped`/`dead` 直接报错并提示 `resume`;`stop`/`interrupt` 结算中的 cancel 未完成前 `resume` 会报 `running` 而非假装 `idle`。

## `poll` 返回结构

`detail` 两档,回答两类不同的问题:

- **`inspect`(默认)**:持久快照,回答"子代理现在在干嘛/上次干到哪"。快照在事件到达时增量维护,**与日志读取、环形缓冲淘汰完全解耦**——反复 poll、logs 翻页、旧事件被淘汰都不改变它。无 LLM 摘要,也没有 healthy/stuck 之类的推断——只有观测到的事实。
- **`logs`**:规范化事件条目流,回答"这段时间具体发生了什么"。按 `seq` 递增、每条带 `at`(**桥侧收包时间**,即桥收到该事件的时刻,下同);连续文本 chunk 合并成一条;工具更新按 `toolCallId` 回填 title/kind/input,跨 poll 批次也能对上号。无 `raw` 档——原始 `session/update` 不再暴露。

两档共用的顶层生命周期字段:`name, status, lastStopReason?, pendingPermission?, turn, activeTurn, queued, mode, model`(`pendingPermission` 是 operator 模式下的待决请求 `{requestId, toolCall, options[]}`,仅在有待决时出现)。

### `detail:"inspect"`(默认)

```json
{
  "name": "alpha",
  "status": "starting | running | idle | stopped | dead",
  "lastStopReason": "end_turn | cancelled | error",
  "pendingPermission": {"requestId": 7, "toolCall": {}, "options": []},
  "turn": 2,
  "activeTurn": 2,
  "queued": 1,
  "mode": "smart",
  "model": "swe-2-max",
  "cursor": 67,
  "capturedAt": "2026-09-12T08:00:00.000Z",
  "snapshot": {
    "turn": {
      "n": 2,
      "startedAt": "…",
      "endedAt": null,
      "durationMs": 4312,
      "stopReason": null
    },
    "lastOutput": {"type": "tool", "id": "tc-1", "title": "exec: ls", "at": "…", "turn": 2},
    "latestText": {"text": "…本 turn 的 agent 可见文本,尾部 ≤4000 字符", "at": "…", "turn": 2},
    "activeTools": [
      {
        "id": "tc-1",
        "title": "exec: ls",
        "kind": "execute",
        "input": "{\"command\":\"ls\"}",
        "status": "in_progress",
        "turn": 2,
        "startedAt": "…",
        "updatedAt": "…",
        "elapsedMs": 3200
      }
    ],
    "currentPlanStep": {"content": "do it", "status": "in_progress", "priority": "medium", "index": 1, "total": 3, "at": "…", "turn": 2},
    "lastError": {"message": "…", "at": "…", "turn": 2},
    "lastActivity": {"at": "…", "elapsedMs": 12},
    "lastContent": {"at": "…", "elapsedMs": 12}
  }
}
```

- `cursor` = 快照版本(当前事件 head seq);把它作为 `since` 配合 `wait_ms` 传回即可等待新变化。`since` 缺省时,inspect 的等待以**调用瞬间的 head** 为基线——日志里攒了多少未读事件都不会让 wait 忙返回。`capturedAt` 是本快照生成的桥侧时间。
- `snapshot.turn`:当前/最近 turn 的起止、时长与 stopReason;turn 进行中 `endedAt`/`stopReason` 为 null,`durationMs` 是已运行时长;从未有 turn 则整个为 null。agent 退出会冻结仍在进行的 turn 的时长(死亡时刻即 ended,不再增长)。
- `activeTools` 按 `toolCallId` 合并(**可能多个并行**),含 title、精简 `input`(≤300 字符)、`startedAt`/`updatedAt` 收包时间与已运行 `elapsedMs`。**completed/failed 即离开该表**;turn 结束、interrupt、stop、agent 退出时仍打开的 tool 会被标注 `endedWithTurn` 并从表中消失——中断/死亡/结束的 turn 不会留下假"running"。已关闭的 tool 记录有界保留(≈256 条,仅用于检测同一 id 跨 turn 复用),活动中的 tool 永不因淘汰被丢;同一 `toolCallId` 在新 turn 复用时计时会随新 turn 重置。
- `latestText` = 本 turn 累积的 agent 可见文本(新 turn 开始时清空重计;`turn` 字段标明它属于哪个 turn)。旧 turn 的其它字段不重置,一律带 `turn` 标注,不静默混用。
- `lastOutput` = 最近一条真实输出:`type` ∈ `message`/`thinking`/`tool`/`plan`,文本类带 `text`(截断 300),tool 带 `id`+`title`,plan 带当前步骤摘要。
- `lastActivity` = 最近一次 **agent 来信**(任何 session/update、turn_end 应答、agent_exit、permission_request);`lastContent` = 最近一次**真实输出**(message/thinking/tool_call/tool_call_update/plan)。**usage/config/mode 更新与本地 poll/send/权限应答都不算 content**;thinking 是真实输出(计入 lastOutput/lastContent),但不灌进 `latestText`。
- `currentPlanStep` = 最新 plan 里第一条 `in_progress` 条目(`index` 为 1-based,`total` 为条目数);没有则 `null`。`lastError` = 最近错误(turn_end 的 error、tool `failed`——附实际 error/output 摘要,截断 500、agent_exit、mode/model_failed),带 `at`/`turn`。

### `detail:"logs"`

```json
{
  "name": "alpha",
  "status": "idle",
  "turn": 2,
  "activeTurn": 0,
  "queued": 0,
  "mode": "smart",
  "model": "swe-2-max",
  "events": [
    {"seq": 63, "at": "…", "type": "tool", "id": "tc-1", "title": "exec: ls", "status": "completed"}
  ],
  "nextCursor": 67,
  "hasMore": false,
  "droppedEvents": 0
}
```

- **增量读游标**:不带 `since` 的 logs 调用从 `readCursor` 继续读;读完只把 `readCursor` 推进到本页实际消费的 `nextCursor`(不是 head)——`limit` 截断时剩余事件留待下一页,**绝不静默跳过未消费记录**;`hasMore` 表示缓冲里还有后续。
- `limit` = 本次最多消费的**缓冲事件数**(连续 chunk 合并后,返回的条目数 ≤ limit);缺省不限。`since` = 显式回放(seq > since),**不推进** `readCursor`,同样受 `limit` 约束——翻页把上一页的 `nextCursor` 作为 `since` 传回即可。
- `droppedEvents` = 因环形缓冲(`bufferCap`)淘汰而丢失的、位于请求区间 `(from, oldest)` 内的事件数——淘汰是**显式计数**的,不会静默吞掉。
- `wait_ms` 仅在 `running`/`starting`(或取消的 prompt 仍在结算)且游标后无新事件时阻塞;并发等待的 poll 都会被新事件唤醒。
- 成功的工具结果同时带 `structuredContent`(结构化 JSON)与文本 JSON;错误结果是 `isError: true` 的纯文本。

### 事件类型参考(`detail:"logs"` 的规范化条目)

`events[]` 是**投影后的条目流**(对齐 Codex `item.*` 语义);每条都带 `seq`(单调)和 `at`(桥侧收包时间;合并条目取最后一个并入块的时间):

| `type` | 关键字段 | 何时出现 |
| --- | --- | --- |
| `message` | `text` | agent 可见输出;同一批 drain 内连续 chunk 合并,跨 poll 各自成条 |
| `thinking` | `text` | agent 思考流(同上合并) |
| `tool` | `id, title, kind, status, input?, output?` | 工具调用生命周期:`in_progress → completed/failed`;事件在收包时固化解析后的 `title`/`kind`/`status`/`input`(缺省字段按 `toolCallId` 当时的记录补齐)——重放展示的是摄入时刻的元数据,后续完成或 id 复用不会改写旧日志(跨批次仍可读);`output` 已规范化成可读文本(content 块提取 text、rawOutput 取 stdout/output 字段),截断 4KiB |
| `plan` | `entries` | agent 的计划更新 |
| `usage` | `used, size, cost?, inputTokens, outputTokens` | token 用量;同批内完全相同值去重 |
| `mode` | `mode` | `current_mode_update` 确认 |
| `model` | `model` | `set_model` 成功的本地记录 |
| `queued` | `text, position` | `send` 进 FIFO 的回执 |
| `turn_start` / `turn_end` | `turn, text` / `turn, stopReason, usage?, error?` | turn 边界,`turn` 为会话内单调序号 |
| `permission_request` | `requestId, toolCall, options` | operator 模式待裁决 |
| `permission_auto` | `toolCall, optionId` | auto/always 自动放行记录 |
| `permission_granted` / `permission_denied` / `permission_answered` | `optionId, kind` | 按所选 option 的 `kind`(allow\*/deny\*/reject\*/其他)归类 |
| `permission_superseded` | `requestId` | 同会话新请求顶掉的旧请求(已自动 cancel) |
| `interrupt` / `stopped` / `resumed` / `agent_exit` | `droppedQueue?` / `code?` | 生命周期标记 |
| `mode_skipped`/`model_skipped`/`mode_failed`/`model_failed` | `wanted, available?/error?` | 默认值不被支持时的降级记录 |

被丢弃的噪音:`available_commands_update`、`session_info_update`、`config_option_update`(其 mode/model 值会并入会话状态)、`user_message_chunk`。

## 配置(单个 JSON 文件)

桥**不读任何 `DEVIN_*` 环境变量**作为自身设置(子进程照常继承 PATH/HOME/认证等运行环境)。配置来源:

```
devin-subagents [--config PATH] [--help]
```

1. `--config PATH` 显式指定(文件不存在直接报错);
2. 缺省时自动用 `./devin-subagents.config.json`(存在才用);
3. 都没有则用内置默认值。

```json
{
  "command": "devin",
  "args": ["acp"],
  "statePath": ".devin-subagents.json",
  "permission": "operator",
  "mode": "smart",
  "model": "swe-2-max",
  "rpcTimeoutMs": 30000,
  "bufferCap": 500,
  "hideFromSessionList": true
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `command` | `"devin"` | agent 命令;裸名走 PATH,含路径分隔符的相对路径相对**配置文件目录**解析 |
| `args` | `["acp"]` | 传给 agent 的 argv(逐字传递) |
| `statePath` | `<配置目录|cwd>/.devin-subagents.json` | name→{sessionId,cwd,mode,model} 映射落盘;相对路径相对配置文件目录 |
| `permission` | `"operator"` | `auto`=自动选 allow_once;`always`=自动选 allow_always;`operator`=挂起等 `permission` 工具裁决 |
| `mode` | `"smart"` | `session/new` 时应用的默认 mode(resume 不改:reload 后重新断言的是会话自己保存的选择) |
| `model` | `"swe-2-max"` | `session/new` 时应用并要求确认的默认 model(真实 ID:`swe-2-medium`/`swe-2-high`/`swe-2-max`,用 `models` 工具看 agent 实际广告值;无单独的 reasoning 选项) |
| `rpcTimeoutMs` | `30000` | 非 `session/prompt` 的 RPC 超时;prompt 不设超时(turn 可以跑很久) |
| `bufferCap` | `500` | 每个会话的事件环形缓冲上限 |
| `hideFromSessionList` | `true` | 把桥管理的会话在 devin session DB 里标记 `hidden=1`,使其不出现在 `/resume`、`devin list`、agent `session/list` 中(见下) |
| `sessionDbPath` | 平台数据目录(`~/.local/share/devin/cli/sessions.db`,macOS 为 `~/Library/Application Support/devin/cli/sessions.db`,尊重 `XDG_DATA_HOME`/`APPDATA`) | devin session DB 路径覆盖;相对路径相对配置文件目录 |
| `notifyThread` | 无 | 接收子代理通知的 Codex 会话(UUID 或确切会话名);等价于 `notify` 工具注册的静态配置版,适合固定单会话场景 |
| `codexCommand` | `"codex"` | `codex queue` 投递用的 codex 命令;含路径分隔符的相对路径相对配置文件目录解析 |
| `reportTool` | `true` | 给每个子代理会话注入 `report` MCP 工具(经 `session/new`/`load` 的 `mcpServers` 字段) |
| `autoNotify` | `true` | 桥侧自动通知:turn 排空转 idle(含尾部输出摘要)与 operator 模式权限请求 |
| `reportHint` | `true` | spawn 的 task 尾部自动附一句"你有 `report` 工具"的提示,让子代理知道它的存在(需 `reportTool`) |

- **schema 严格**:未知键、错误类型、非法 JSON 都直接拒绝;显式 `--config` 的文件不存在也报错。
- **优先级**:`spawn` 的 `mode`/`model` 参数 > 配置文件值 > 内置默认。**文件里写明的值是"刻意配置"**:agent 未广告或确认值不符时 spawn 直接报错。model 无论来源都要求精确确认(内置默认也不例外);内置默认 mode 不被支持则记 `mode_skipped` 继续跑。
- **model 应用路径**:devin ACP 没有 `session/set_model`,也不吃 CLI `--model`——桥在 `session/new` 后、**任何 prompt 之前**用 `session/set_config_option {configId:"model", value}` 应用,并要求返回 `configOptions` 的 `currentValue` **精确等于请求值**;不符、无回执或 agent 未广告都直接失败(内置默认也一样——绝不让会话悄悄跑在一个没选过的 ambient model 上)。`resume` 不套默认值:statePath 里随会话落盘的 mode/model 会在 `session/load` 后重新断言。因此继承来的 `DEVIN_MODEL` 环境变量不可能悄悄生效,改了配置的会话也不会被 resume 洗掉。
- `spawn`/`list`/`poll`/`models` 返回值里的 `mode`/`model` 均为 agent 侧确认值。

### `hidden` 标记的行为与边界

- `/resume`、`devin list`、ACP `session/list` 都过滤 `hidden = 0`;置位后子代理会话从所有用户可见列表消失。`session/load` **不受影响**——桥的 `resume` 工具照常恢复隐藏会话。
- 副作用:交互式 `devin -r <id>` / `/resume <id>` 的 id 前缀解析同样过滤 `hidden=0`,即隐藏会话无法从 CLI 手动恢复——这是"隐藏"语义的组成部分。要手动捞回:`sqlite3 ~/.local/share/devin/cli/sessions.db "UPDATE sessions SET hidden=0 WHERE id='<sessionId>'"`。
- 会话行是**惰性持久化**的(首个 prompt 落盘才插行),所以桥在 spawn 后把 sessionId 记入待置位集合,在每次 `poll`/`list`/`resume` 时幂等重试,直到行出现为止;`list()` 的 `subagents[].hidden` 字段反映是否已确认置位。
- 实现是"尽力而为"的旁路写入:DB 缺失、老版本 schema 没有 `hidden` 列(Devin V15 migration 才引入)、`node:sqlite` 不可用(Node < 22.5)时功能自动禁用,只记一条 stderr 日志,绝不阻塞工具调用。WAL 模式下一条短 `UPDATE` 与 devin 自身写入并发安全,且 devin 从不在 insert 后改写该列,置位不会被覆盖。

### 子代理主动汇报(`report` + `notify`)

子代理的 ACP 事件本来就实时推到桥(不依赖 `poll`),断点只在"桥 → Codex 主会话"没有注入通道。本节补的就是这一跳:

- **子代理侧**:`session/new`/`session/load` 的 `mcpServers` 注入一个 per-session MCP server(`dist/child.js`),暴露一个 `report(message)` 工具——子代理调它即把 `{name, at, text}` 追加进 `<statePath>.mailbox.jsonl`,桥经 `fs.watch` 实时收走。devin 实测会拉起并完成该 MCP 握手;spawn 的 task 末尾自动附了提示(`reportHint`),子代理知道它存在。要用"分析完先汇报再动手"这类分阶段汇报,直接在 task 里要求它调 `report` 即可。
- **桥侧自动通知**(`autoNotify`):turn 排空转 `idle` 时发"turn N ended (stopReason) — 尾部输出摘要";`permission=operator` 收到权限请求时发"requests permission: \<tool\>"。`cancelled` 结算(即你自己的 `interrupt`/`stop`)不通知。
- **投递**:注册 thread 后( `notify` 工具或 `notifyThread` 配置),每条通知以 `codex queue --thread <t> --message "[devin-subagents] <name>: <text>"` 注入——消息作为排队用户消息进入该会话,在下一个 turn 边界被主代理看到。投递失败(codex 不存在、thread 已死)自动降级进 inbox。
- **未注册/投递失败时**:通知堆进 inbox,**任何工具调用的返回都会捎带 `inbox` 字段**——主代理不 poll 也有机会在下一次工具结果里看到,不会静默丢失(inbox 上限 100 条)。
- **接线要求**:`codex queue` 目标必须是在 app-server daemon 上存活的会话(UUID 或确切会话名;`codex agents` 可查)。注册写入 `<statePath>.notify.json`,桥重启后沿用;换会话用 `notify(thread)` 重注册或 `off` 注销。
- **注意**:queue 是"排队"语义——主会话正在跑的 turn 不会被半路打断,消息在该 turn 结束时送达;要"立刻催"请配合让主代理周期性做工具调用(任何一次结果都可能捎带 inbox)。

## 权限与隔离边界(重要)

- **`permission=operator` 的裁决者是主代理(调用方 LLM),不是人类弹窗,也不是某种沙箱**:权限请求经 `poll` 的 `pendingPermission` 浮上来,由主代理读 options 后用 `permission` 工具回答;桥只负责挂起/转达/超时兜底(找不到会话/被顶掉/stop 时回 `cancelled`,绝不挂死 agent)。
- **`mode` 与 `cwd` 都不构成文件系统隔离**:smart/bypass 等 mode 是 agent 内部的审批策略,cwd 只是工作目录——子代理在自己进程内执行 shell 与写文件,能力等同直接跑 `devin`。需要隔离请在外层(容器/VM/用户权限)做,本仓库不实现沙箱。
- `smart + auto` ≈ 全权委托(smart 自行放行它认为安全的动作——实测隔离目录里 `git init` 不询问——其余由 `auto` 答 allow_once);想保留"危险动作要拍板"语义用 `operator`。

## 构建与接入

```bash
npm install && npm run build
npm run smoke    # 冒烟:对 agent 发 initialize(可用 -- --config PATH)
npm test         # 确定性单测:内置 fake ACP agent,不依赖外部服务
npm run e2e      # 端到端全链路(需 devin 凭据;自动生成临时配置文件)
```

Codex(`~/.codex/config.toml`)——最小接入,无需配置文件(全用内置默认):

```toml
[mcp_servers.devin]
command = "node"
args = ["/home/duro/Projects/devin_subagents/dist/index.js"]
# 无需 env 块——桥不读 DEVIN_* 变量
```

要自定义时:`cp devin-subagents.config.example.json devin-subagents.config.json`,
改好后把 `--config <绝对路径>/devin-subagents.config.json` 追加到 `args` 末尾即可。

工具在 Codex 里以 `devin.spawn` / `devin.poll` 形式出现(server 名 `devin` + 裸工具名)。

## 设计要点

- **能力最小化**:`initialize` 时 `fs`/`terminal` 全声明为 false,devin 自己干活,桥只做传声筒;唯一预期的反向请求是 `session/request_permission`(其他方法一律回 `-32601`,agent 不会卡住)。
- **串行 turn 保证**:实测 `devin acp` 对运行中 `session/prompt` 的"排队"会提前双发 turn_end、串扰输出——所以桥自己做 FIFO:turn 内只许一个 prompt 在途,`send` 排队、`interrupt`/`stop` 清队,turn_end 严格按 `turn` 序。mode/model 变更(`set_mode`/`set_model`、spawn 初始化)期间 session 处于"配置中"状态:`send` 照常排队,待配置确认后才开跑,保证 prompt 永远落在确认过的配置上。
- **进程自愈**:agent 退出/启动失败后 `ensureStarted` 自动重拉新进程并重新 `initialize`;旧子进程迟到的 exit/error 事件不会污染新实例(handler 绑定 child 身份)。非 prompt RPC 有超时上限,`list` 把 agent 侧错误放进 `agentSessionsError` 而不是静默吞掉。
- **权限闭环**:`auto`/`always` 自动挑 allow 系选项;`operator` 挂起等主代理回答——`optionId` 不在 options 里会报错且请求保持 pending 可重试;`stop`/`interrupt`/新请求顶掉/找不到会话时主动回 `cancelled`。
- **中断语义**:`session/cancel` 只停当前 turn;`stop` 额外标 stopped + 落盘。桥被杀时 `devin acp` 子进程同死,会话在 Devin 侧仍可 `session/load`。
- **状态文件**:原子写(tmp+rename)、每次变更合并旧文件里未加载的记录;读/写失败记 stderr 日志不致命。
- **fake ACP 与真实 devin 协议对齐**:无 `session/set_model`;model/mode 走 `session/set_config_option` 并回执 `configOptions`;`session/cancel` 异步结算;`session/load` 对已知 id 恒成功(Devin session DB 持久)。

## 已有实现(调研结论 2026-09-11)

- **Oortonaut/mcacp**(`npm i -g mcacp`):22 工具通用 ACP 控制面,本项目最接近的替代品,把 `devin acp` 写进 `agent_servers` 即可用。
- **theorionic/mcp-acp-bridge**:多连接、后台生成、增量读取、手动审批;无显式 resume。
- **phenasdev/devin-mcp-bridge**:devin 专用但最小化(`devin_task`/`devin_reset`)。
- 本仓库差异化:devin 特化(默认钉 `swe-2-max`、权限策略、恢复语义)、FIFO 串行 turn 与 turn 号、规范化条目输出对齐 Codex item 模型、确定性 fake-ACP 测试套件。
