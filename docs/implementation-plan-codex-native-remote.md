# Codex Native Remote 最小改造实施计划

工程目录：`/Users/samxie/Documents/workspace/codex-feishu-remote`。当前分支：`codex-native-remote`。所有本功能资料保存在本工程内。

## P0：Bridge 持有会话的原生闭环

1. 扩展 app-server JSON-RPC 客户端，保存 server request 的 `id` 并支持同连接回复。
2. 在 Codex 后端把原生提问、命令、文件和额外权限请求交给 Feishu 卡片；校验 thread、turn、消息、项目和操作人，拒绝重复与过期点击。
3. `/plan <任务>` 传入原生 `collaborationMode`。映射 `plan` delta、完成项和步骤更新；同一张卡更新。下一个普通 turn 退出 Plan Mode。
4. 保留 Goal、已有 session/history、steer/stop、launchd/doctor。
5. 自动化验收：多问题、选项与自定义文本、审批、重复/过期/错误卡片、Plan 事件、模拟服务端原 request 响应且 `turn/start` 次数为 1。

## P1：实机飞书验收与控制体验

配置专用飞书机器人与授权群、项目 cwd、用户白名单；运行 `doctor`、`start/status/logs/stop`。在手机飞书实际验证提问、命令审批、多次连续提问、Goal/Plan/工具进度、steer 和历史恢复。只有完成此项后才能宣称手机端 Case 1–5 通过。

为最终 Plan 增加明确的执行/修改按钮时，按钮应启动**后续**默认模式 turn，并在 UI 标注它是 Bridge 操作；不能伪装成 Codex 原生 approve-plan RPC。

## P2：重启与多端接管

Bridge 重启后从持久 session 映射恢复 thread，并使旧卡失效。旧 app-server 连接上的 pending request 是否可在新连接恢复，需要协议实验；若不能，产品应明确将该请求视为中断并提供重新发起路径。Desktop/CLI 已运行 turn 的接管另行验证；不要靠普通消息模拟 request 回答。

## 当前检查点

P0 代码已实现并在模拟 app-server 上验证关键同 turn 闭环；真实 app-server 已确认接受 Plan turn，但模型在探针超时内未返回事件。飞书实机与重启 pending 恢复未验收。所有凭证应由本机配置流程创建，不写入仓库。
