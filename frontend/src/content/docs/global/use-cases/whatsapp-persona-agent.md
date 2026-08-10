# 如何在 WhatsApp 中配置一个具有独立人格的 Hermes Agent？

WhatsApp 是 Hermes Agent 与你保持日常联系的一个消息入口。
它负责传递消息，而 Agent 的角色、语气、行为边界和长期上下文由 LightVela 中的 Agent 配置决定。

本指南会带你把 Hermes Agent 接入 WhatsApp，再选择一套适合个人沟通、提醒或客户沟通的稳定人设。

![在 WhatsApp 中使用具有独立人格的 Hermes Agent](../images/use-case-04-whatsapp-persona-agent.png)

## 适合谁

这篇指南适合希望在 WhatsApp 中与一个表达方式稳定、能够持续记住工作背景的 Hermes Agent 对话的用户。
它尤其适合个人助理、日常提醒、信息整理，以及需要保持固定沟通语气的 1 对 1 场景。

WhatsApp 通道当前以 1 对 1 对话为主要使用方式。
如果你还没有接入 WhatsApp，请先阅读[配置通道 - WhatsApp](../configuration/channel-whatsapp.md)。

## 前置条件

- 一个已经运行中的 LightVela Hermes Agent。
  如果你还没有创建 Agent，可以先查看[快速开始](../02-quickstart.md)。

- 已经配置好的模型或可用的体验积分。
  如果 Hermes 还不能回复，请先完成[配置模型](../configuration/model.md)。

- 一个可以接收验证信息的 WhatsApp 账号，并按照[配置通道 - WhatsApp](../configuration/channel-whatsapp.md)完成通道授权。

- 一份简短的人格目标。
  先想清楚你希望它服务谁、解决什么问题、用什么语气沟通，以及哪些操作必须先征得你的确认。

## 操作步骤 / 核心说明

### 1. 先完成 WhatsApp 通道接入

在 LightVela 管理台打开目标 Hermes Agent，进入「通道」并选择 WhatsApp。
按照[配置通道 - WhatsApp](../configuration/channel-whatsapp.md)完成手机授权、验证码或二维码流程，并发送一条测试消息。

确认管理台显示 WhatsApp 已接入，并且你能在 WhatsApp 中收到 Hermes Agent 回复。
如果通道还没有成功连接，先处理授权、模型或体验积分问题，再开始调整人格。

### 2. 为 WhatsApp 场景写一份角色简报

WhatsApp 的对话通常更短、更即时，也更容易混入生活或工作中的临时请求。
因此，除了描述“它是谁”，还要规定回复长度、主动追问方式和高风险操作边界。

可以先发送类似下面的角色简报：

```text
你是我的 WhatsApp 日常助理。
你帮助我整理待办、跟进提醒和简短信息，不替我做未经确认的外部操作。
默认用简洁、自然、友好的语气回复；需要解释时分点表达，不要一次发送过长的段落。
如果我的请求缺少时间、对象或目标，先问一个最关键的澄清问题。
```

如果你的 WhatsApp Agent 面向客户或团队使用，可以把“我的”改成具体的服务对象，并补充品牌语气、可处理范围和升级人工的条件。

### 3. 在「人设」中选择并注入 Soul

打开目标 Agent 的设置页面，进入「人设」区域。
你可以随机抽取一张人设卡，也可以通过答题测试寻找更接近目标的 Soul。

查看人设卡的角色、语气和行为描述，选中后点击「注入人设」。
LightVela 会把选中的 Soul 写入当前 Hermes Agent 的 `SOUL.md`，并在替换旧人设前保留备份。

同一个 Agent 同一时间只有一个当前生效的人设。
如果你重新注入，WhatsApp 中的回复会在新会话里采用新的人设，因此请先确认新旧角色的差异。

### 4. 在 WhatsApp 中开启新会话

人设注入完成后，在 WhatsApp 对话中发送：

```text
/new
```

这样可以让 Hermes Agent 在新会话开始时读取新的 `SOUL.md`。
如果旧会话仍然表现出之前的语气，先确认 `/new` 已经发送成功，再继续测试。

可以用以下消息确认新的人设是否符合预期：

```text
请说明你现在服务的对象、默认回复风格，以及遇到需要对外发送消息时的处理方式。
```

### 5. 用真实的 WhatsApp 消息校准节奏

WhatsApp 场景中，合适的人格不仅是“听起来像谁”，还包括消息长度、分段方式和何时追问。
可以用三类消息做测试：

```text
把这段内容整理成三条可以直接发给同事的消息。
```

```text
提醒我明天下午三点跟进这个事项，并先告诉我你准备记录哪些信息。
```

```text
这条请求可能会触发外部操作，请先列出风险和需要我确认的内容。
```

如果它回复过长，可以把“默认一条消息不超过三段”保存为你的沟通偏好。
如果它忘记了项目背景，可以通过[记忆管理](../configuration/memory.md)相关能力让 Hermes 记住稳定事实。

## 不要把人格和客服流程混在一起

人格决定 Agent 以什么角色和语气工作。
技能决定它能不能完成某类具体任务。
自动任务决定它什么时候主动发起工作。
记忆和用户画像决定它应该保留哪些长期背景。

例如，一个温和的客服人格并不会自动获得订单查询、知识库检索或退款处理能力。
这些能力需要经过模型配置、技能、文件资料和明确的操作边界共同支持。

如果你需要先理解人格、用户偏好和长期记忆的区别，可以阅读[Hermes Agent 的性格从哪里来](../hermes-agent/10-persona-user-memory.md)。

## 常见问题

### WhatsApp 号码和 Hermes Agent 是一一对应的吗？

通常建议一个 WhatsApp 号码绑定一个 Hermes Agent。
如果需要多个不同角色，建议使用不同的 WhatsApp 号码和不同的 Hermes Agent，而不是在同一个对话中频繁替换人格。

### 重新注入人设会删除 WhatsApp 的历史记忆吗？

不会。
重新注入主要替换 Agent 当前的 `SOUL.md`，而 `/new` 只是开启新的会话。
长期记忆和用户画像仍然属于 Agent 的其他上下文层，但新的人格可能会改变它解释和使用这些背景的方式。

### WhatsApp 群聊可以使用这套配置吗？

当前 WhatsApp 文档将 1 对 1 对话作为支持范围，群聊暂不作为本指南的使用场景。
需要确认最新能力时，请查看[配置通道 - WhatsApp](../configuration/channel-whatsapp.md)。

### 可以让 WhatsApp Agent 主动发送消息吗？

主动消息还会受到 WhatsApp 消息模板和会话窗口等通道规则限制。
如果要发送定时提醒，请先阅读[自动任务](../configuration/automation.md)，并确认消息发送方式符合 WhatsApp 通道的实际限制。

## 下一步

- [如何在 Telegram 中配置一个具有独立人格的 Hermes Agent](./telegram-persona-agent.md) - 对比另一个国际站消息通道的接入方式。

- [如何通过 SOUL.md 设定 IM Agent 的角色、性格与说话方式](./im-agent-persona-soul-md.md) - 将人格、用户画像、记忆和技能分开配置。

- [配置通道 - WhatsApp](../configuration/channel-whatsapp.md) - 查看 WhatsApp 的完整授权和故障排查流程。

- [自动任务](../configuration/automation.md) - 为已经验证有效的提醒或复盘流程安排执行时间。
