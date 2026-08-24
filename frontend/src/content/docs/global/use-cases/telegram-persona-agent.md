# 如何在 Telegram 中配置一个具有独立人格的 Hermes Agent？

## 摘要

**Telegram 只是入口，真正决定 Agent 如何说话、如何做事、哪些事不能做的是它的人设与长期上下文。** 完整流程分两段：先按通道文档把 Hermes Agent 接入 Telegram（在 BotFather 侧创建机器人取得 Token，在管理台完成接入并确认显示为已接入），再通过管理台 Agent 设置页的「人设」区域选择一套稳定的角色、语气与行为边界并「注入人设」。三层分工要分清：人设写长期适用的行为原则，用户偏好写你希望被如何对待，长期记忆存已确认的事实与项目背景。注意 Telegram 通道当前不支持群聊，仅支持 1 对 1 对话。

![在 Telegram 中使用具有独立人格的 Hermes Agent](../images/use-case-03-telegram-persona-agent.png)

## 适合谁

这篇指南适合希望在 Telegram 中长期使用一个风格稳定的 Hermes Agent 的用户。
它尤其适合个人助理、研究伙伴、学习陪练或需要固定沟通方式的日常助手场景。

Telegram 通道当前以 1 对 1 对话为主要使用方式。
如果你需要接入 Telegram，请先阅读[配置通道 - Telegram](../configuration/channel-telegram.md)。

## 前置条件

- 一个已经运行中的 LightVela Hermes Agent。
  如果你还没有创建 Agent，可以先查看[快速开始](../02-quickstart.md)。

- 已经配置好的模型或可用的体验积分。
  如果 Hermes 还不能回复，请先完成[配置模型](../configuration/model.md)。

- 一个可以正常使用的 Telegram 账号，以及按照[配置通道 - Telegram](../configuration/channel-telegram.md)创建并接入的 Bot。

- 对 Agent 角色的初步设想。
  例如，你希望它是简洁的研究助理、温和的学习伙伴，还是只负责提醒和整理事项的执行助手。

## 操作步骤 / 核心说明

### 1. 先把 Hermes Agent 接入 Telegram

在 LightVela 管理台打开目标 Hermes Agent，进入「通道」并选择 Telegram。
按照[配置通道 - Telegram](../configuration/channel-telegram.md)的步骤创建 Bot、粘贴 HTTP API Token，并发送一条测试消息。

确认管理台显示 Telegram 已接入，并且 Bot 能够收到 Hermes Agent 的回复。
先验证通道本身可用，再开始调整人设，这样后续出现问题时更容易判断是通道问题还是人设问题。

### 2. 先写清楚你希望它怎样工作

一个有辨识度的人格不只是一个名字或几句口号。
开始配置前，先写下角色、语气、工作方式和边界。

可以用下面的简短说明作为起点：

```text
你是我的研究助理，主要帮助我拆解问题、比较可靠来源，并把结论写得清楚。
先给结论，再给关键依据；不确定时明确说明不确定之处。
语气专业、直接、友好，不要故意卖萌，也不要把猜测说成事实。
涉及发送消息、修改文件或其他外部操作时，先向我确认。
```

这段说明可以帮助你判断应该选择哪一种 Soul，也可以在接入 Telegram 后继续用对话细化 Agent 的工作方式。

### 3. 在「人设」中选择并注入 Soul

进入目标 Agent 的设置页面，打开「人设」区域。
你可以选择「随机抽取人设」，也可以选择「答题测试人设」，再查看卡片上的人设说明。

选中最符合目标的 Soul 后，点击「注入人设」。
LightVela 会将这套人设写入当前 Hermes Agent 的 `SOUL.md`，并在覆盖已有配置前保留备份。

如果当前 Agent 已经有其他人设，重新注入会替换当前生效的人设。
确认替换前，先检查卡片描述是否符合你对角色、语气和边界的要求。

### 4. 在 Telegram 中开启新会话

人设注入成功后，回到 Telegram 与该 Bot 的对话中发送：

```text
/new
```

Hermes Agent 会在新会话开始时读取新的 `SOUL.md`。
如果只继续旧会话而不发送 `/new`，当前会话可能仍然使用之前加载的人设快照。

新会话开始后，可以先发送一条自我介绍请求：

```text
请用三句话介绍你现在的角色、你能帮我做什么，以及你不会替我做什么。
```

### 5. 用几个真实任务校准语气

不要只用“你是谁”判断人格是否生效。
最好准备几种你日常真的会交给它的任务，例如：

```text
把下面这段研究材料整理成结论、依据和待确认问题。
```

```text
我今天有三个截止时间，请先按风险排序，再给一个简短计划。
```

```text
这个请求涉及向外部服务发送内容，你会先做什么？
```

观察它是否保持了预期的表达方式，是否会主动标出不确定内容，以及是否遵守你设置的操作边界。
如果只是某个用户偏好需要长期保留，例如语言、时区或简报格式，请通过对话让 Hermes 记住它，而不是把所有偏好都写成人设。

## 人格、用户偏好与记忆怎么分工

`SOUL.md` 更适合描述 Agent 的稳定角色、语气、优先级和行为边界。
用户画像适合描述你的身份、语言、时区和沟通偏好。
长期记忆适合保存你们已经确认过的事实、项目状态和可复用的共同背景。

如果你想更深入理解这三者的区别，可以阅读[Hermes Agent 的性格从哪里来](../hermes-agent/10-persona-user-memory.md)和[记忆管理](../configuration/memory.md)。

## 常见问题

### Telegram Bot 自己有独立人格吗？

人格属于连接到 Telegram 的 Hermes Agent，而不是 BotFather 中的 Bot Token。
同一个 Hermes Agent 如果连接了其他支持的通道，其他通道也会使用同一套 Agent 级人设和长期上下文。

### 发送 `/new` 会删除记忆吗？

不会。
`/new` 的作用是开启一个新的会话，让新的 `SOUL.md` 在会话开始时生效，不等于删除 Agent 的长期记忆或用户画像。

### 我可以把 Telegram Bot 加入群组使用吗？

当前 Telegram 文档将 1 对 1 对话作为主要支持方式，群聊能力还受到通道配置和隐私模式限制。
不要把当前文档当成群聊方案使用；如需确认最新支持范围，请先查看[配置通道 - Telegram](../configuration/channel-telegram.md)。

### 更换模型会让 Agent 失去人格吗？

通常不会。
模型、Agent 人设和长期记忆是不同的配置层，但更换模型可能会改变它的推理方式、工具调用方式和表达细节。

## 下一步

- [如何在 WhatsApp 中配置一个具有独立人格的 Hermes Agent](./whatsapp-persona-agent.md) - 将同样的 Agent 人格应用到 WhatsApp 1 对 1 对话。

- [如何通过 SOUL.md 设定 IM Agent 的角色、性格与说话方式](./im-agent-persona-soul-md.md) - 了解 Soul、人设和长期记忆的边界。

- [配置通道 - Telegram](../configuration/channel-telegram.md) - 查看 Telegram Bot 的完整接入步骤。

- [配置技能](../configuration/skill.md) - 在稳定的人格基础上扩展实际任务能力。
