# P5 Cursor CLI 与 hook 可行性

2026-11-11；本机 CLI `2026.11.05-86047df`。最终采用 SDK run.steer：已验证的
CLI 接口未提供可交付的同轮注入路径。**不交付 CLI steer、next-turn 队列或 interrupt
接入。** 这是指定版本和已核路径的结论，不是对所有 CLI/IDE hooks 的全版本否定。

## 实际帮助与协议

| 核查 | 实际结果 |
| --- | --- |
| `cursor-agent --version`、`cursor-agent acp --version` | 同为上述版本 |
| `cursor-agent acp --help` | 隐藏 ACP 子命令实际存在 |
| `cursor-agent --acp` | unknown option |
| `cursor-agent --input-format stream-json` | unknown option；只支持 stream-json 输出 |
| ACP initialize | protocolVersion 1、loadSession、image、session list、HTTP/SSE MCP；无 midTurnSteering 声明 |
| `session/steer {}` | -32601 Method not found |
| 工具执行中并发 `session/prompt` | 原请求 cancelled，替换请求 end_turn；是 interrupt-replace |

模型只用于最小临时任务。CLI 广义目录含 Haiku，但 ACP 会话目录没有且实际拒绝选择
（-32602，未发模型任务）；随后使用 ACP 目录中低价的 GLM 5.3 Flash，model selection
明确接纳。[官方报价](https://cursor.com/docs/models/glm-5-3-flash)为每百万 token 输入
$0.15、输出 $0.50，低于本次对照的 Nano、Luna、Gemini Flash 和 DeepSeek Flash。

一次原生 ACP `sleep 4` 任务中，按 tool_call_update in_progress 才发送第二条 prompt。
原 prompt 返回 cancelled，第二条 end_turn；回答里的标记不作为上下文证据。

- [原生并发行为](recordings/p5/cursor-cli-feasibility.json)
- [Haiku 被拒（未发模型任务）](recordings/p5/cursor-cli-model-selection.json)

## Hooks 与插件补查

[官方 hook contract](https://cursor.com/docs/hooks) 的 postToolUse 可返回额外上下文，
与 stop 后续消息不同。因此不能仅凭 ACP 没有 session/steer 就推导 Cursor 没有
hook 能力。补查约 10 分钟，未修改全局配置：本机用户 hooks 为 version 1，只有
 afterAgentResponse；实际帮助有 plugin-dir；现有缓存插件为 MCP/skills，没有已安装
的同轮注入插件。配置里的 steering=true 也不能代替协议能力或逐条回执。

| 原生探针 | 结果及证据限度 |
| --- | --- |
| ACP 临时工作区，八类项目 hooks | sleep 工具期间写入私有输入；hook 调用 0，原 prompt 正常完成，返回原答案 |
| ACP 临时 Git 项目 | 同上；排除仅因缺 Git 项目而未发现 hooks 的疑点，仍未观察到 hook 调用 |
| 普通 CLI print + 项目 hooks + 显式 plugin-dir | 60s 无任何原生输出，终止本次整个进程组；该路径未验，不能据此宣称 print/interactive 不支持 hooks |

没有 hook 调用、返回上下文或原生 transcript 新输入行，因此没有把 hook 输出或模型
口头确认冒充同轮上下文证据。记录保留顺序和不透明关联 ID，删除机器路径、账号、
凭据、工具参数与思考正文：

- [ACP 工作区](recordings/p5/cursor-cli-hook.json)
- [ACP Git 项目](recordings/p5/cursor-cli-hook-repo.json)
- [print/plugin 未验](recordings/p5/cursor-cli-hook-print.json)

## SDK 与最终契约

SDK 活动 Run.steer 提供 complete_delivered / revert_to_followup 的逐条结果；CLI 的
已验证接口没有暴露这份契约。本轮只将 complete_delivered 记为 SDK 交付，不以本地
recordUserMessage 或模型回答证明上下文。revert 明确 rejected，告诉用户未插入当前轮，
不自动排入下一轮。[最终 SDK 验收](../../apps/cursor-bridge/VALIDATION.md)单独记录。
