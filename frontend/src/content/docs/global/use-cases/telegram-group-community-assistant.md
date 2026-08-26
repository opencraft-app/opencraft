# 如何使用 Telegram 群组 AI 社群助手：问答、摘要与提醒？

## 摘要

**LightVela 支持 Telegram 群消息。
先在 BotFather 为机器人关闭 Group Privacy，再将机器人添加到群组，并通过 `@机器人用户名` 发起对话即可。**
本文说明这条已验证的接入路径，以及如何用同一个 Hermes Agent 完成群内问答、讨论摘要和提醒草稿。
本文不把尚未验证的入群事件、自动欢迎或未提及机器人的被动回复写成已配置功能。

![Telegram 群组 AI 社群助手的问答、摘要与提醒方案](../images/use-case-08-telegram-group-community-assistant.png)

## 开始前的准备

你需要先按[配置通道 - Telegram](../configuration/channel-telegram.md)将 Telegram Bot 连接到 Hermes Agent。
你还需要有权限把该机器人添加到目标 Telegram 群组。

## 开启 Telegram 群消息

### 1. 在 BotFather 中选择机器人

1. 在 Telegram 打开 `@BotFather`。
2. 发送 `/mybots`。
3. 选择已经连接到 Hermes Agent 的机器人。

### 2. 关闭 Group Privacy

1. 进入「Bot Settings」。
2. 选择「Group Privacy」。
3. 选择关闭隐私模式。

该设置让机器人能够接收群内提及它的消息。

### 3. 将机器人加入 Telegram 群组

1. 打开要使用的 Telegram 群组。
2. 选择「添加成员」或对应的群管理操作。
3. 按机器人用户名搜索，并将机器人添加到群组。

### 4. 通过提及机器人测试群消息

在群内使用 `@机器人用户名` 提及机器人并发送测试消息，例如 `@机器人用户名 总结目前的讨论`。

预期结果是 Hermes Agent 在同一个群组中回复。

## 已验证的消息范围

| 交互 | 当前文档范围 | 验证方式 |
|---|---|---|
| 群组对话 | 已支持。
机器人已加入群组、Group Privacy 已关闭且消息提及机器人时可用 | 在群内发送 `@机器人用户名 你好`，确认机器人在该群回复 |
| 私聊 | 通过已连接的 Telegram Bot 支持 | 在机器人的私聊窗口发送消息并确认回复 |
| 自动入群欢迎或未提及机器人的被动回复 | 本文尚未验证 | 在将其作为运营流程前单独验证这些行为 |

## 将机器人用于社群协作

群消息测试成功后，可通过[SOUL.md 人设指南](./im-agent-persona-soul-md.md)为助手定义角色和信息边界。
群内提示词应保持明确，让成员知道何时在请求 Agent 回复。

| 工作流 | 群内示例提示词 | 需要检查的结果 |
|---|---|---|
| FAQ | `@机器人用户名 只根据已准备的 FAQ 回答` | 回答引用已准备的资料，或明确提示转交人工 |
| 讨论摘要 | `@机器人用户名 总结结论、待办、负责人和未决问题` | 回复区分已确认结论和未解决事项 |
| 提醒草稿 | `@机器人用户名 起草一条包含时间、对象、目的和取消方式的提醒` | 使用自动任务发送前先人工审核草稿 |

如需检索、摘要或定时内容，请选择可信 Skill，并在[配置技能](../configuration/skill.md)中检查其权限。
在依赖自动任务发送前，先在受支持的目标通道中单独验证自动任务。

## 安全与运营边界

关闭 Group Privacy 会打开 Telegram 群消息的投递路径。
它不能替代群规、敏感信息保护和高风险外部操作前的确认机制。
定义谁可以要求 Agent 执行敏感操作时，请参考[Telegram 和 WhatsApp Agent 的安全边界指南](./telegram-whatsapp-safety-boundaries.md)。

## 常见问题

### 现在可以把 LightVela Telegram Bot 加入群组吗？

可以。
在 BotFather 中关闭 Group Privacy，将机器人添加到群组后，用 `@机器人用户名` 提及它即可开始对话。

### 关闭 Group Privacy 后，机器人会在群内回复吗？

这是当前文档接入流程中的必要步骤。
关闭后，将机器人添加到群组，并用 `@机器人用户名` 发送测试消息。

### 本文是否配置新成员自动欢迎？

否。
本文只记录通过提及机器人发起的群组对话。
在向社群承诺自动欢迎前，需要单独验证入群事件和自动化流程。

### WhatsApp 群组可以作为替代吗？

当前 WhatsApp 通道文档仍说明不支持群聊。
不要将 Telegram 的群消息支持外推到 WhatsApp。

## 下一步

- [配置通道 - Telegram](../configuration/channel-telegram.md) - 连接机器人并完成群消息接入步骤。

- [如何通过 Skill 把 IM Agent 变成客服、社群助手或 AI 伴侣](./im-agent-skill-scenarios.md) - 准备群内问答和摘要所需的 Skill 与内容。

- [如何通过 SOUL.md 设定 IM Agent 的角色、性格与说话方式](./im-agent-persona-soul-md.md) - 定义助手的角色和边界。
