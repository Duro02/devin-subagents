# devin_subagents

把 `devin acp` 的会话暴露成 MCP 工具,让 Codex(或任何 MCP client)像管理子代理一样管理 Devin:并行派发、中途查看输出、插入消息、中断、停止后恢复。

```
Codex CLI ──stdio/MCP──▶ devin-subagents(本仓库)──stdio/ACP──▶ devin acp
```

**生命周期模型**:桥进程由 Codex 在会话启动时拉起(stdio MCP 的标准语义),Codex 退出时桥带着 `devin acp` 子进程一起退出。会话本体持久化在 Devin 自己的 session DB 里,桥只把 `session_id` 记到 `.devin-subagents.json`,所以**桥重启后 `devin_resume` 照样恢复旧会话**。

## 工具面(9 个)

| 工具 | 对应 ACP | 说明 |
| --- | --- | --- |
| `devin_spawn(name, task, cwd?, mode?)` | `session/new` + `session/prompt` | 后台起一个子代理,立即返回 |
| `devin_send(name, text)` | `session/prompt` | 追加指令;turn 进行中时为排队注入 |
| `devin_poll(name, wait_ms?, since?)` | `session/update` 缓冲 | 增量读取子代理输出(agent 文本/tool call/turn_end) |
| `devin_interrupt(name)` | `session/cancel` | 中断当前 turn,会话保留 |
| `devin_stop(name)` | cancel + 标记 | 停止并保留以供恢复 |
| `devin_resume(name)` | `session/load` | 恢复持久化会话(跨桥重启有效) |
| `devin_list()` | `session/list` + 本地注册表 | 看所有子代理状态 |
| `devin_permission(name, optionId?)` | `session/request_permission` 应答 | operator 模式下人工裁决权限 |
| `devin_set_mode(name, mode)` | `session/set_mode` | 切会话权限模式(bypass/smart/…) |

## 构建与接入

```bash
npm install && npm run build
npm run smoke   # 冒烟:对 devin acp 发 initialize,打印能力
```

Codex(`~/.codex/config.toml`):

```toml
[mcp_servers.devin]
command = "node"
args = ["/home/duro/Projects/devin_subagents/dist/index.js"]
env = { DEVIN_MODEL = "swe-2-max", DEVIN_SUBAGENT_PERMISSION = "auto" }
```

## 配置(环境变量)

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEVIN_BIN` | `devin` | agent 二进制 |
| `DEVIN_ACP_ARGS` | `acp` | 传给 agent 的参数 |
| `DEVIN_MODEL` | — | 透传给 `devin acp`,如 `swe-2-max` |
| `DEVIN_SUBAGENT_PERMISSION` | `auto` | `auto`=自动选 allow_once;`always`=自动选 allow_always;`operator`=挂起等待 `devin_permission` 裁决 |
| `DEVIN_SUBAGENT_MODE` | `smart` | 每次 `session/new` 后若 agent 支持则 `set_mode`。设为 `"default"` 可关掉 |
| `DEVIN_SUBAGENT_STATE` | `./.devin-subagents.json` | name→sessionId 映射落盘路径 |
| `DEVIN_SUBAGENT_BUFFER` | `500` | 每个会话的事件环形缓冲上限 |

## 设计要点

- **能力最小化**:`initialize` 时 `fs`/`terminal` 全声明为 false,devin 自己干活,桥只做传声筒;唯一预期的反向请求是 `session/request_permission`。
- **事件缓冲**:`session/update` 按序存入每会话环形 buffer,`devin_poll` 增量返回(自上次读取以来),超限丢弃并在 `droppedEvents` 里报数。
- **权限闭环**:`auto` 模式自动挑 `allow_once` 选项;`operator` 模式把请求转成事件,由编排方用 `devin_permission` 回答——绝不挂起 agent。
- **smart 模式与权限策略的相互作用(重要)**:smart 自身只对"明确安全"的动作放行;装包、`rm`、`sudo`、写 git 等**永远会**以 `session/request_permission` 回到桥上。此时 `DEVIN_SUBAGENT_PERMISSION=auto` 会替它们答 allow_once——实际效果≈bypass,smart 的高风险护栏被桥抹掉了。想保留"危险动作要人拍板"的语义,配 `operator`(由 Codex 编排方逐个裁决)。两者搭配建议:`smart + operator` 最接近交互式 smart 体验;`smart + auto` 等于"全权委托但要走一遍询问流程"。
- **中断语义**:`session/cancel` 只停当前 turn;`devin_stop` 额外把会话标记为 stopped(可 resume)。桥被杀时 `devin acp` 子进程同死,会话在 Devin 侧仍可 `session/load`。

## 待验证事项

- **turn 进行中发 `session/prompt`**:Devin REPL 有"排队消息"语义,ACP 端预期同构但未实测;若被拒,退路是 `session/cancel` + `session/load` + 重发(上下文不丢)。
- `devin acp` 是否对 `session/prompt` 强制要求 `authenticate`——本机已有 `devin auth login` 凭据时预期直接可用。
- Codex 的 MCP stdio 字段名以你的 codex 版本为准(`[mcp_servers.*]` vs 新版 `mcp_servers` 表)。

## 已有实现(调研结论 2026-09-11)

- **Oortonaut/mcacp**(`npm i -g mcacp`):22 工具通用 ACP 控制面,`initialize`/`new_session`/`load_session`/`prompt_start`/`prompt_events`/`cancel`/`set_mode` + 权限策略,本项目最接近的替代品,把 `devin acp` 写进 `agent_servers` 即可用。
- **theorionic/mcp-acp-bridge**:多连接、后台生成、增量读取、手动审批;无显式 resume。
- **phenasdev/devin-mcp-bridge**:devin 专用但最小化(`devin_task`/`devin_reset`)。
- 本仓库差异化:devin 特化(默认钉 `swe-2-max`、权限策略、恢复语义)、工具语义按"子代理"组织、~400 行易改。
