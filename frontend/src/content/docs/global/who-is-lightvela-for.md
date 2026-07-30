# LightVela 适合哪些人使用？

LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，适合**想拥有一个长期在线、认识你、越聊越懂你的专属 AI 伙伴，但不想管理服务器、容器和 API 鉴权的用户**。它把 Agent 的部署、运维和 7×24 小时运行交给云端托管；你只需在网页上完成配置，就能通过 Telegram、WhatsApp、Discord 和 WeChat 与自己的 Hermes Agent 对话。

如果你还不清楚 LightVela 具体是什么，可以先看 [LightVela 是什么](./01-overview.md)。

***

## 适合谁

下面几类人从 LightVela 获益最明显：

* **想用 AI Agent、但没有技术背景的人**
  你不需要懂服务器、Docker、反向代理或 API 鉴权。开通可用套餐后，云端会自动完成环境配置与运行时管理，你面对的只有一个可视化管理面板。

* **希望在日常聊天软件里使用 AI，而不是再安装一个独立 App 的人**
  Hermes Agent 通过[通道](./04-core-concepts.md)接入 Telegram、WhatsApp、Discord 和 WeChat。你可以直接在常用的聊天入口与它交流，不用来回切换应用。

* **希望灵活选择大语言模型的人**
  LightVela 可接入 ChatGPT、Claude、Gemini、DeepSeek、Qwen、Zhipu、Hunyuan，以及其他 OpenAI-compatible endpoints。具体配置方式见[配置模型](./configuration/model.md)。

* **需要跨会话持续记忆的人**
  与普通聊天机器人不同，Hermes 会跨会话保存对话与记忆，并在响应时结合历史上下文——不用每次打开都重新自我介绍。

* **想要一个 7×24 小时在线、独立运行的 Agent 的人**
  每个 Hermes 实例拥有独立运行环境，资源隔离、持续在线，不依赖你的本地设备是否开机。

***

## 典型使用场景

LightVela 特别适合这些场景：

* **个人 AI 助手**：处理日程提醒、信息整理和随时问答，见[如何用 LightVela 搭建个人 AI 助手？](./use-cases/personal-ai-assistant.md)

* **常驻在线的对话入口**：把 Agent 接入 Telegram、WhatsApp、Discord 或 WeChat，随时都能找到它。

* **每日定时任务**：让 Agent 按固定时间自动执行任务、汇总你关心的内容。

* **长期记忆与个人知识管理**：把 Agent 当成越用越懂你的知识伙伴。

***

## 前置条件

开始使用前，你需要：

* 一个 Google 或 GitHub 账号，用于登录 LightVela；国际站不要求完成中国实名认证

* 从[订阅页](/subscribe)选择并开通当前可用的套餐；国际站目前采用限量、限时免费的内测开放方式

* 至少一个可接入的聊天通道账号，例如 Telegram、WhatsApp、Discord 或 WeChat

无需自备服务器，也无需具备任何运维能力。

***

## 如果你不确定是否适合

如果你的需求是“完全本地运行、数据不离开终端”“训练或微调底层模型”或“把 Agent 嵌入自己的网站或 App”，那么 LightVela 可能不是最合适的选择。

***

## 下一步

* **[快速开始](./02-quickstart.md)** — 5 分钟跑通第一个对话

* **[核心概念](./04-core-concepts.md)** — 理解 Hermes、模型、通道和技能
