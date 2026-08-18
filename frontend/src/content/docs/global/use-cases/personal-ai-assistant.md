# 如何用 LightVela 搭建个人 AI 助手？

## 摘要

**搭建个人 AI 助手的正确顺序不是一次把所有事情自动化，而是先让一个云端 Hermes Agent 在你已经在用的聊天工具里可用，再逐步叠加记忆、技能与自动任务。** 五个基础组件各自解决一个问题：模型决定推理质量，通道决定你从哪里找到它，记忆让它记住你的工作方式，技能让它掌握可复用的方法，自动任务让它在你不在场时也完成约定工作。建议第一周只做三件事：配置一个模型、接入一个通道、验证记忆确实跨会话生效；确认这条链路可靠后再引入技能与自动任务，这样出问题时能快速定位是哪一层。

![通过 LightVela 跨通道使用个人 AI 助手](../images/use-case-personal-ai-assistant.webp)

## 适合谁

如果你希望由一个助手协助日常规划、研究跟进、提醒，以及需要了解个人偏好的问题，这套方式很适合你。你不需要复杂的工作流；从一个 Hermes Agent 和一个你每天都会打开的通道开始即可。

当你不断重复说明自己的时区、偏好的总结格式、正在推进的项目，或每天早上希望获得哪类帮助时，这个助手尤其有价值。

## 前置条件

- 一个 LightVela 账号和正在运行的 Hermes Agent。若尚未创建，请先完成[快速上手](https://lightvela.ai/zh-sg/docs/quickstart)。

- 一个对话通道。Telegram、WhatsApp、Discord、Slack 和微信都是常见起点；优先选择你最常打开的那个。

- 已配置可用模型，或仍有可用的试用额度。若 Hermes 还不能回复，可查看[配置模型](https://lightvela.ai/zh-sg/docs/configuration/model)。

- 一个最先想解决的小习惯，例如规划当天工作或收集待跟进事项。

## 操作步骤 / 核心说明

### 1. 让 Hermes 进入你的日常习惯

先连接一个消息通道，再从你平时整理一天安排的地方发送前几条消息。通道不只是消息投递方式，更是让你愿意持续回到这个助手的使用习惯。可以按说明配置 [Telegram](https://lightvela.ai/zh-sg/docs/configuration/channel-telegram)、[WhatsApp](https://lightvela.ai/zh-sg/docs/configuration/channel-whatsapp)、[Discord](https://lightvela.ai/zh-sg/docs/configuration/channel-discord)、[Slack](https://lightvela.ai/zh-sg/docs/configuration/channel-slack) 或[微信](https://lightvela.ai/zh-sg/docs/configuration/channel-wechat)。

![LightVela 控制台中的通道页面](../images/personal-ai-assistant-channel.webp)

与其直接提出一个很宽泛的请求，不如先清楚介绍你希望它如何协助。例如：

```text
我想让你做我的个人规划助手。我使用新加坡时区。
每天的计划请保持简短，先标出截止时间；信息不明确时，先问我一个追问问题。
```

### 2. 让记忆承接反复出现的上下文

Hermes 会随着协作积累有用的上下文，因此你不必在每次对话里重复所有偏好。告诉它哪些事实和工作偏好值得长期保留：你的时区、希望简报如何组织、重要项目名称，或你喜欢在哪几天提前规划。

你也可以直接这样说：

```text
请记住：我希望在每个工作日早上 8:00 收到简洁简报，
其中包含会议、截止时间和最重要的三项下一步行动。
```

在[记忆管理](https://lightvela.ai/zh-sg/docs/configuration/memory)页面中，可以查看 Hermes 已积累的记忆和用户画像。记忆的目的应是减少重复，而不是保存每一个短暂出现的细节。

### 3. 只有在真实任务需要时再添加技能

Hermes 即使没有额外技能也可以正常对话。只有当你能明确说出某项实际工作需要什么能力时，再添加技能，例如查询信息、整理待办事项或准备周期性报告。这样能让助手更容易理解，也更容易建立信任。

![LightVela 控制台中的技能页面](../images/personal-ai-assistant-skills.webp)

先在 ClawHub 浏览适合的技能，再通过[配置技能](https://lightvela.ai/zh-sg/docs/configuration/skill)安装。安装前请阅读技能说明，并优先选择你信任的来源。

### 4. 把已经有用的对话变成重复执行的检查

当某个提示词已经稳定地产生有用结果时，再考虑是否应该按计划执行。一个简单的自动任务可以让 Hermes 在早晨生成计划、在一天结束时进行回顾，或每周帮你重置重点，而无需你记得每次都手动开启对话。

例如：

```text
每个工作日早上 8:00，请为我准备一份简洁的当天计划。
先列出截止时间和会议，再给出三项最需要专注的下一步行动。
```

在[自动任务](https://lightvela.ai/zh-sg/docs/configuration/automation)中设置执行时间和通知通道。第一个自动任务应保持简单；看过几次真实结果后，再逐步调整指令。

![LightVela 控制台中的自动任务页面](../images/personal-ai-assistant-automations.webp)

## 常见问题

### 必须先配置全部功能，Hermes 才能有用吗？

不需要。一个消息通道和可用模型就足以开始。随着你发现哪些重复任务值得保留，再逐步加入记忆、技能和自动任务。

### Hermes 会记住我发送的每一条消息吗？

不会。记忆用于保存跨对话仍然有价值的信息，例如偏好、重复性工作和稳定上下文。需要时，你可以要求 Hermes 记住或忘记某项信息，再通过记忆管理页面查看。

### 我可以从多个通道使用同一个助手吗？

可以。多个已连接通道可以指向同一个 Hermes Agent，因此你可以在支持的消息平台之间切换，同时延续同一份助手上下文。

### 最适合先自动化什么？

选择一个你会在固定时间重复执行的任务。晨间规划、简短的每日回顾或每周优先级检查都是不错的起点，因为你能很快判断结果是否真的有帮助。

## 下一步

- [对话](https://lightvela.ai/zh-sg/docs/configuration/agent-chat) —— 直接在控制台中与 Hermes 协作。

- [记忆管理](https://lightvela.ai/zh-sg/docs/configuration/memory) —— 查看助手跨对话保留的上下文。

- [自动任务](https://lightvela.ai/zh-sg/docs/configuration/automation) —— 将已验证有效的习惯安排到固定计划中。
