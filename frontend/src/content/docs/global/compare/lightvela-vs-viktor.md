# LightVela vs Viktor.com：哪个更适合你的个人 AI Agent？

## 摘要

**如果你想要一个始终在线、拥有长期记忆、支持灵活配置模型、消息通道、技能和定时任务的个人 AI 伙伴，可以选择 LightVela。** 如果你想要一个在团队工作空间中运行，并能跨 Slack、GitHub、Notion、Stripe、Salesforce 和 Google Ads 等业务工具工作的共享 AI 同事，可以选择 Viktor.com。

差异不只是“哪个 AI 更聪明”，而在于 Agent 位于哪里、属于谁，以及它被设计来负责什么类型的工作。

![LightVela 与 Viktor.com 运行个人 AI Agent 的对比](../images/lightvela-vs-viktor.png)

## 快速对比

| 你关心的方面 | LightVela | Viktor.com |
| --- | --- | --- |
| **主要角色** | 个人云端 AI Agent | 面向团队的共享 AI 同事 |
| **主要入口** | Web 控制台和消息通道 | Slack、Microsoft Teams、Web 应用和 Discord |
| **记忆模式** | 跨对话和通道的个人 Agent 记忆 | 共享工作空间上下文和记忆 |
| **集成方式** | 消息通道、技能、自动任务和模型提供商 | 3,200+ 个业务工具集成 |
| **设置方式** | 无需维护服务器的托管云端 Agent | 连接 Viktor、授权工具并交办工作 |
| **适合场景** | 个人助手和长期协作 | 跨业务工具的运营工作 |

## 真正的差异在于归属关系

LightVela 围绕拥有一个长期运行的个人 Agent 这一理念构建。
你的 Hermes Agent 运行在云端，即使设备离线也能保持可用，并可以通过支持的消息通道联系。
它的记忆、人设、模型、技能和自动任务，都围绕同一段持续的协作关系进行配置。
[LightVela 概览](../01-overview.md)介绍了这些部分如何配合工作。

Viktor.com 采用了另一种方式。
Viktor 将自己定位为一个运行在 Slack 和 Microsoft Teams 中的 AI 同事，整个团队都可以向它发消息、把它邀请到频道，并共享工作空间上下文。
它当前的产品资料也介绍了 Web 聊天和 Discord 入口，但核心理念仍然是共享工作环境，而不是私人的个人伙伴。

这一区别很重要。
如果你想问“这个 Agent 能否记住我的工作方式，并长期陪伴我”，LightVela 会更适合。
如果你想问“这个 AI 能否为整个团队跨公司的工具执行工作”，Viktor 就是为此设计的。

在 [LightVela 与 Mira 的对比](./lightvela-vs-mira.md)中也出现过类似的归属差异，但比较重点不同。
Mira 从 Telegram 对话出发，而 Viktor 从共享业务工作空间和连接后的运营流程出发。

## 哪些情况下 LightVela 更适合

如果你的 Agent 需要出现在日常沟通的多个地方，LightVela 会很适合。
你可以连接通道，配置模型，安装[技能](../configuration/skill.md)，并在 LightVela 中创建周期性的[自动任务](../configuration/automation.md)。
同一个 Agent 可以支持提醒、研究、信息整理、内容工作和日常对话，而不要求你自行维护服务器。

这种模型也有意保持灵活。
你可以在 LightVela 中配置支持的模型提供商，在不重建 Agent 关系的情况下更换模型层。
技能扩展 Hermes 的能力，自动任务则决定它什么时候主动运行工作。

LightVela 还允许你在同一个云端环境中探索不止一种 Agent 运行时。
[DeepSeek Harness](../configuration/deepseek-harness.md)可以和 Hermes Agent 并行运行，作为独立管理的服务，拥有自己的 WebUI、提供商配置和插件能力。
如果你想尝试插件优先的 Agent 环境，又不想替换主要的个人 Agent，这种方式会很有用。

因此，LightVela 适合希望拥有多种工作方式的个人 Agent 用户：

- 从消息通道提问。
- 给 Agent 安排周期性任务。
- 为专业工作流安装技能。
- 更换模型，同时保留 Agent 的整体上下文。
- 尝试另一个 Agent 运行时，同时保留 Hermes。

这种选择的代价是，LightVela 以一段个人协作关系为中心。
如果你的主要需求是一个能够为整个团队服务、并写入大量业务系统的运营型 Agent，Viktor 可能更直接。

## 哪些情况下 Viktor.com 更适合

Viktor 最强的优势是覆盖业务软件的广度。
其官方资料介绍了 3,200 多个集成，涵盖客户关系管理、分析、广告、工程、财务和生产力工具。
[Viktor 集成目录](https://viktor.com/integrations)展示了这些连接如何支持企业现有技术栈中的工作。

这会改变你可以提出的任务类型。
你不只是让 Agent 帮你思考工作流，还可以让 Viktor 对账 Stripe 和 HubSpot、更新 Notion 看板、整理 Linear 问题，或跨多个连接系统准备报告。

Viktor 也支持直接从对话中安排周期性工作。
你可以在 Slack 或 Teams 中描述任务、指定时间表、确认设置，然后让 Viktor 重复运行。
其[定时任务文档](https://viktor.com/docs/scheduled-tasks)介绍了这种周期性业务操作方式。

对于技术团队，Viktor 提供公共 API、MCP Server，以及兼容 OpenAI 和 Anthropic 的访问方式。
它的开发者能力面向异步线程、运行、产物、集成发现、用量数据和审批状态设计。
如果 Agent 本身需要成为程序化业务工作流的一部分，Viktor 会更合适。

Viktor 的安全模型也围绕委托式业务操作设计。
其[安全文档](https://viktor.com/security)介绍了 OAuth 或安全 API 连接、范围化访问、敏感操作前审批、可审计性，以及在执行时注入凭证而不是将凭证暴露给模型。

这种选择的代价是共享归属。
Viktor 面向的是一个由多人和业务工具共同参与的工作空间上下文。
这对团队执行很有价值，但它不同于一个主要属于你的个人 Agent，以及它的记忆、人设和日常流程。

## 你应该如何选择

如果符合以下情况，可以选择 LightVela：

- **你想要个人 Agent：** 希望拥有一个始终在线、围绕日常习惯变得更有用的 AI 伙伴。
- **你看重连续性：** 长期记忆和持续的 Agent 关系比团队共享上下文更重要。
- **你偏好消息入口：** 希望通过日常使用的通道联系 Agent。
- **你希望配置可控：** 想围绕自己的工作流管理模型、技能、自动任务和 Agent 行为。
- **你需要运行时灵活性：** 想在同一个云端环境中探索 Hermes 和其他 Agent 运行时。

如果符合以下情况，可以选择 Viktor.com：

- **你在共享工作空间中工作：** 工作已经发生在 Slack、Microsoft Teams 或 Discord 中。
- **你需要一个多人共享的 AI 同事：** 希望整个团队都能向同一个 Agent 发消息并把它邀请到频道。
- **你依赖业务工具广度：** 价值主要来自连接客户关系管理、分析、财务、项目管理和工程工具。
- **你想要跨工具执行：** 希望 Agent 直接完成业务操作，而不只是准备回复。
- **你需要开发者入口：** 公共 API、MCP 或 SDK 兼容访问是工作流的一部分。

我的判断是：**LightVela 更适合建立个人、持久化的 Agent 协作关系，Viktor.com 更适合希望把 AI 运营者连接到业务工具栈的团队。**

如果你问的是“哪个 Agent 应该记住我的工作方式，并每天陪伴我”，LightVela 会更合适。

如果你问的是“哪个 AI 同事能连接业务工具，并让团队交办工作”，Viktor.com 可能是更直接的答案。
