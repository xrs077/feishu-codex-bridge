# Codex ↔ 飞书远程控制桥：技术审计

审计日期：2026-09-27。主基线 `modelzen/feishu-codex-bridge`：`6698118352d7eca87887d3ee1b58736caca204bc`。参考 `JayZtwo/codex-feishu`：`aef661e`。协议依据：本机 `codex-cli 0.155.0-alpha.16.4` 生成的 app-server v2 类型，以及本仓库 vendored v2 类型。实验字段以运行时版本为准。

## 基线选择

选择 modelzen 主工程二次开发。它已有 Feishu 长连接、CardKit 2.0、按群与话题绑定 session、`thread/start`/`thread/resume`/`thread/read`、`turn/start`/`turn/steer`/`turn/interrupt`、Goal、历史卡、项目与用户权限、macOS launchd 与 `status|start|stop|restart|logs|doctor`。关键代码分别位于 `src/agent/codex-appserver/`、`src/bot/handle-message.ts`、`src/card/`、`src/service/`、`src/cli/`。这些能力直接复用。

JayZtwo 工程可参考原生审批转发的交互，但当前基线的 session、卡片和常驻设施更完整。当前 Bridge 自己持有 app-server stdio 连接；Codex Desktop/CLI 中已经运行的 turn 的 server request 无法凭 `threadId` 在另一条连接上回答。首版验收限于 Bridge 持有的会话。

## 原生协议与缺口

| 能力 | 协议事实 | 基线状态 | 本分支处理 |
| --- | --- | --- | --- |
| Plan Mode | `turn/start.collaborationMode={mode:'plan',settings:{model,reasoning_effort,developer_instructions:null}}` | 未传入 | `/plan <任务>` 传入原生模式 |
| 规划 | `item/plan/delta`、完成的 `ThreadItem.type='plan'`、`turn/plan/updated` | 映射器忽略 | 映射并合并更新一张 Plan 卡 |
| 提问 | `item/tool/requestUserInput` 是带 JSON-RPC `id` 的 server request；`questions[]` 有 `id/header/question/options/isOther/isSecret` | 原客户端自动拒绝 | 生成卡片，以 `{answers:{[questionId]:{answers:string[]}}}` 响应原 `id` |
| 权限 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` | `approvalPolicy:'never'` | `on-request`，原生审批卡回原请求 |
| Goal | `thread/goal/set|get|clear` 与 `thread/goal/updated` | 已有 | 保留，挂接原生提问和审批 |
| 历史 | `thread/list` 与 `thread/read(includeTurns=true)` | 已有 | 复用 |
| steer/stop | `turn/steer`、`turn/interrupt` | 已有 | 复用 |
| 最终 Plan 确认 | 此版本没有 `proposed_plan` notification 或 approve-plan RPC | 无 | 展示完成的 `plan` item；用户另发执行指令启动默认模式 turn |

`request_user_input` 的 `itemId` 是工具 item 标识；真正的 RPC 关联键是 server request 的 `id`，再加 `threadId/turnId` 校验。回答原 `id` 让原 turn 继续；向 `turn/start` 发送“我选 A”会改变语义，不能替代。多问题用问题 `id` 分别映射。CardKit 表单可以带选项与自定义文本；secret 输入不经飞书卡片存储，当前拒绝此请求。

## 风险与验收边界

- 当前每个会话的 app-server 是 Bridge 子进程。Bridge 重启后，持久化 session 映射可用 `thread/resume` 找回 thread；旧连接上的 pending JSON-RPC request 无法迁移到新进程。Case 6 的“pending 原地恢复”尚无协议证据，不能宣称通过。
- `on-request` 改变上游原先“永不逐条审批”的行为。只有项目授权用户可触发任务，卡片回答还校验群、项目 cwd、任务发起人或管理员；依然需要实机检查沙箱和飞书回调。
- 本机没有 `~/.feishu-codex-bridge/` 机器人配置，因此不能做手机飞书端到端验收。模拟 app-server 集成测试覆盖同一 turn 继续。
- 真实本机 app-server 探针两次收到 `turn_started`，但 30 秒和 120 秒内均未收到模型事件或原生提问；这是运行态阻断，尚不能判断是模型服务、账户、网络还是协议兼容问题。测试命令为 `RUN_CODEX_NATIVE_LIVE=1 npx vitest run test/native-plan.live.test.ts`，默认测试套件跳过该探针。
- Desktop/CLI 既有运行 turn 的接管需独立研究其连接所有权和多客户端订阅语义，不能以 Bridge 自持会话测试外推。
