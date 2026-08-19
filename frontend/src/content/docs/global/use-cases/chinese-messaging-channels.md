# 如何把 AI Agent 接入消息平台？

## 摘要

**把 Hermes Agent 接入消息平台的关键，是理解通道只是入口、Agent 才是工作主体：同一个云端 Agent 会在所有已连接通道间共享同一套模型、技能与记忆，因此不需要为每个平台各建一个机器人。** 完整流程是四步：确认目标通道在你所在区域可用（国际站支持 Telegram、WhatsApp、Discord、Slack、WeChat、QQ、企业微信、飞书，国内站面向微信、飞书、QQ）；在平台侧完成授权取得凭据；在管理台连接并确认显示为已接入；最后发一条测试消息，确认回复落在你发消息的那一条会话里。凭据属于敏感信息，不要写入长期上下文或粘贴到聊天中。

![LightVela 中的消息平台连接](../images/use-case-messaging-platforms.webp)

## 适合谁

这篇指南适合希望通过消息应用与 Hermes 对话，而不只是使用网页控制台的人。
如果你希望同一个助手出现在多个地方，它也同样适合你，例如用 Telegram 处理个人事务，用 Discord 服务社群。

先从一个通道开始。
只有当另一个通道对应不同的场景、受众或设备习惯时，再添加它。

## 前置条件

- 一个已经运行中的 LightVela Hermes Agent 账号。
  如果你还没有创建 Agent，可以先查看[快速开始](../02-quickstart.md)。

- 已经配置好的模型或可用的体验积分，以便通道连接后 Hermes 能够回复消息。

- 你想连接的平台的访问权限。
  有些平台使用二维码授权流程，其他平台则需要机器人 Token 或平台凭据。

- 一条可以在配置完成后立即发送的测试消息。

## 操作步骤 / 核心说明

### 1. 选择适合对话场景的通道

选择通道时，应根据你真正会在哪里使用助手来决定，而不是看能连接多少个平台。
Telegram、WhatsApp、Discord、Slack 和 WeChat 是常见选项：

| 通道 | 适合场景 |
| --- | --- |
| Telegram | 个人消息、轻量日常任务和直接对话 |
| WhatsApp | 日常沟通，以及你已经习惯使用 WhatsApp 接收的通知 |
| Discord | 社群、开发者群组和结构化讨论空间 |
| Slack | 团队协作、工作区通知和频道任务流转 |
| WeChat | 经常使用微信进行个人沟通的场景 |

LightVela 也会为其他受支持的通道提供配置页面。
控制台中的通道页面是当前你的 Hermes Agent 可用通道的准确信息来源。

### 2. 完成平台对应的连接流程

打开控制台中的通道区域，选择平台，然后按照对应的授权或凭据流程操作。
请使用对应平台的指南，不要从无关的平台复制凭据：

- [Telegram](../configuration/channel-telegram.md)
- [WhatsApp](../configuration/channel-whatsapp.md)
- [Discord](../configuration/channel-discord.md)
- [Slack](../configuration/channel-slack.md)
- [WeChat](../configuration/channel-wechat.md)

请像保护密码一样保护机器人 Token、应用 ID 和密钥。
不要把它们粘贴到群聊、公开文档或发给其他人的消息中。
如果凭据已经泄露，请先在签发凭据的平台中轮换凭据，再重新连接 Hermes。

![LightVela 中的通道连接页面](../images/use-case-messaging-connection.png)

### 3. 通过简单对话验证连接

当控制台显示通道已连接后，在对应平台中找到机器人或会话，并发送一条简短消息：

```text
你好 Hermes，请回复你收到这条消息的平台名称。
```

这可以验证完整链路：平台能够投递消息，Hermes 有可用模型，并且回复能够返回到同一个地方。
如果没有正常工作，请先检查连接状态，再确认[配置模型](../configuration/model.md)中当前启用的模型。

### 4. 决定哪些内容应在不同通道之间共享

当多个通道连接到同一个 Hermes Agent 时，它们只是通往同一个助手的不同入口。
这意味着 Agent 可以在受支持的通道之间共享相同的记忆、工作偏好和已安装技能。

使用[记忆管理](../configuration/memory.md)查看你希望 Hermes 长期保留的上下文。
如果某个通道面向不同受众，或需要完全不同的角色定位，可以考虑把它作为独立使用场景，而不是把无关的预期混入同一段对话历史。

![不同通道之间共享同一个 Hermes Agent 的上下文](../images/use-case-messaging-memory.png)

## 常见问题

### 我可以把多个消息平台连接到同一个 Hermes Agent 吗？

可以。
受支持的通道可以指向同一个 Agent，让你从多个消息应用联系它，同时保留相同的配置行为和记忆。

### 我应该先连接哪个通道？

选择你最常使用的那个。
当第一条消息很容易发出时，个人助手更容易真正融入你的日常。
Telegram、WhatsApp、Discord、Slack 和 WeChat 都有对应的详细配置指南。

### 为什么通道显示已连接，但 Hermes 没有回复？

先发送一条简单的测试消息，然后检查是否有启用的模型或可用的体验积分。
如果问题仍然存在，请重新连接通道，并使用[诊断](../configuration/diagnostics.md)查看维护选项和最近的日志。

### 我可以让多个 Hermes Agent 共用同一个机器人凭据吗？

除非平台和你的使用流程明确支持，否则不建议这样做。
让一个凭据只对应一个清晰的用途，会更容易排查问题并控制访问权限。

## 下一步

- [配置模型](../configuration/model.md)：确认 Hermes 已经准备好可用模型。

- [记忆管理](../configuration/memory.md)：管理已连接通道之间共享的上下文。

- [自动任务](../configuration/automation.md)：在合适的情况下，把定时更新发送到已连接的通道。
