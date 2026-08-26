# 如何让一个 Agent 同时接入 Telegram 和 WhatsApp，并保持统一人格与长期记忆？

## 摘要

**Telegram 与 WhatsApp 可以作为同一个 Hermes Agent 的两个入口：只要两个通道连接到同一个 Agent，它们就共享 Agent 级的人格、Skill、自动任务与长期记忆，不需要为每个平台复制一份配置。** 但「统一」有明确范围——共享的是 Agent 级资产，每个通道仍保有各自的授权方式与消息限制，因此接入是两次独立的授权动作。验证是否真的共享，最直接的方法是在一个通道说一件事，再到另一个通道询问同一件事；能答出来才说明两个入口指向同一个 Agent。接入新通道后还要确认回复落在你发消息的那一条会话里，避免投递到错误会话。

![一个 Agent 同时连接 Telegram 和 WhatsApp 并共享人格与长期记忆](../images/use-case-07-multi-channel-personality-memory.png)

## 适合谁

这篇指南适合希望在不同消息应用之间切换，同时保持同一个 AI 助手身份的用户。

它适合需要在 Telegram 和 WhatsApp 之间切换设备或联系人，也适合希望把个人助理、研究伙伴或客服草稿助手集中管理的用户。

## 先理解“统一”的范围

同一个 Agent 不等于两个通道实时共享完整聊天记录。

两个入口共享的是 Agent 级配置和长期上下文，当前对话中的全部消息仍然属于各自的通道会话。

如果你希望另一端知道某个已经确认的事实，可以直接让 Hermes 记住它，再在另一端继续验证。

人格、长期记忆和 Skill 属于 Agent 层，而 Bot Token、扫码授权、会话入口和消息格式属于通道层。

## 前置条件

- 一个已经运行中的 LightVela Hermes Agent。
  如果你还没有创建 Agent，可以先查看[快速开始](../02-quickstart.md)。

- 一个已经配置好的模型或可用的体验积分。

- 一个可以正常使用的 Telegram 账号和 Bot。

- 一个可以正常使用的 WhatsApp 账号。

- 了解 Telegram 支持群消息的前置条件：在 BotFather 中关闭 Group Privacy，将机器人加入群组后再通过 `@机器人用户名` 发起对话。
- 了解 WhatsApp 的群聊支持范围仍以其通道文档为准。

## 操作步骤

### 1. 先选定唯一的目标 Agent

打开 LightVela 管理台，先确定 Telegram 和 WhatsApp 都要连接到哪一个 Hermes Agent。

不要为每个通道分别创建一个 Agent，除非你确实希望它们拥有不同的人格、记忆和 Skill。

### 2. 接入 Telegram

按照[配置通道 - Telegram](../configuration/channel-telegram.md)创建 Bot，并把 HTTP API Token 填入目标 Agent 的 Telegram 通道设置。

在 Telegram 中发送一条测试消息，确认管理台显示已接入，并确认回复回到了预期的 Bot。

如果你还需要为 Telegram 配置独立人格，可以参考[如何在 Telegram 中配置一个具有独立人格的 Hermes Agent](./telegram-persona-agent.md)。

### 3. 接入 WhatsApp

在同一个 Hermes Agent 的通道设置中选择 WhatsApp，按照[配置通道 - WhatsApp](../configuration/channel-whatsapp.md)完成扫码授权。

在 WhatsApp 中打开对应的机器人联系人，发送一条测试消息，确认回复正常返回。

如果你还需要为 WhatsApp 配置独立人格，可以参考[如何在 WhatsApp 中配置一个具有独立人格的 Hermes Agent](./whatsapp-persona-agent.md)。

### 4. 在 Agent 层设置统一人格

进入目标 Agent 的“人设”区域，确认 SOUL.md 中的角色、语气、优先级和行为边界适合两个通道。

人格写在 Agent 层，因此不需要在 Telegram 和 WhatsApp 中重复配置两份。

如果需要修改人格，可以查看[如何通过 SOUL.md 设定 IM Agent 的角色、性格与说话方式](./im-agent-persona-soul-md.md)。

修改后，分别在两个通道开启新会话并做一次自我检查，确认新的人格已经生效。

### 5. 在 Agent 层配置记忆和用户画像

在管理台打开“记忆”，确认 Agent 记忆和用户画像的容量设置符合你的使用方式。

Telegram 和 WhatsApp 共享同一个云端 Agent 的长期记忆，所以不需要分别录入相同的身份、语言和偏好。

你可以在任一通道发送：

    记住我希望所有日报先给结论，再给三条关键依据。

然后切换到另一个通道发送：

    按照我之前设定的日报格式，给我一个简短示例。

如果两个通道表现不一致，先检查它们是否确实连接到了同一个 Agent，再检查当前会话是否需要发送 /new。

### 6. 只安装一次需要共享的 Skill

Skill 属于 Agent 的能力配置，不需要为 Telegram 和 WhatsApp 各安装一份。

可以先在任一通道通过对话请求 Hermes 安装 Skill，再让它更新技能列表并用一个低风险任务验证。

详细步骤请查看[配置技能](../configuration/skill.md)，安全要求请先确认 Skill 的来源、权限和外部服务依赖。

### 7. 分别测试通道差异

用同一组问题在两个通道各测试一次：

    请介绍你现在的角色，并说明你会如何处理不确定的问题。

    请按照我记录的偏好，把这段内容整理成三条要点。

再测试一次通道特有的行为，例如媒体消息、主动提醒或 Bot 联系人显示方式。

人格和长期记忆应该保持一致，但消息格式、媒体能力、授权方式和主动投递限制可能不同。

## 一个 Agent、两个入口的建议结构

    同一个 Hermes Agent
    ├── 一份 SOUL.md
    ├── 一份 Agent 记忆和用户画像
    ├── 一套已安装的 Skills
    ├── 一组自动任务
    ├── Telegram 入口
    └── WhatsApp 入口

自动任务的通知方式需要单独选择目标通道。

不要因为两个通道共享 Agent，就默认每个提醒会同时发送到 Telegram 和 WhatsApp。

## 常见问题

### 在 Telegram 记住的内容会出现在 WhatsApp 吗？

会，只要两个通道连接的是同一个 Hermes Agent，并且内容已经写入 Agent 的长期记忆或用户画像。

当前 Telegram 会话中的每一句消息不会自动变成 WhatsApp 会话的实时聊天记录。

### 为什么两个通道的语气看起来不完全一样？

通道的消息格式、媒体能力、会话状态和模型输出都会影响细节。

先确认两端连接的是同一个 Agent，并在需要时发送 /new 让新的 SOUL.md 在会话开始时加载。

### 可以给 Telegram 和 WhatsApp 配置不同人格吗？

如果它们连接的是同一个 Agent，默认使用同一份 Agent 级人格。

如果确实需要完全不同的角色和记忆，应创建不同的 Agent，再分别连接对应通道。

### WhatsApp 群组可以和 Telegram 一起共享吗？

当前 WhatsApp 文档明确说明不支持群聊。
Telegram 支持群消息，但需要先关闭 Group Privacy，将机器人加入群组并通过 `@机器人用户名` 发起对话。

多通道共享解决的是 Agent 层的一致性，不会改变各通道自身的接入条件和能力边界。

### 自动任务会同时发到两个通道吗？

不会自动同时发送。

创建或编辑自动任务时，需要确认通知方式和目标通道，并分别测试投递结果。

## 下一步

- [Hermes Agent 如何连接多个消息通道](../hermes-agent/07-message-gateway.md) - 了解通道、网关和 Agent 层的关系。

- [记忆管理](../configuration/memory.md) - 查看 Agent 记忆和用户画像的管理方式。

- [配置通道 - Telegram](../configuration/channel-telegram.md) - 完成 Telegram Bot 接入。

- [配置通道 - WhatsApp](../configuration/channel-whatsapp.md) - 完成 WhatsApp 授权接入。

- [如何通过 Skill 把 IM Agent 变成客服、社群助手或 AI 伴侣](./im-agent-skill-scenarios.md) - 为统一人格扩展具体工作能力。
