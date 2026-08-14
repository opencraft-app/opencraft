# What is LightVela

> A cloud-hosted Hermes Agent that understands you better over time.

> ℹ️ **Public beta and billing notice**
>
> LightVela is entering public beta and starting billing. Documentation and product capabilities are still evolving, and some descriptions may change as new versions are released.
>
> * **Public beta and billing**: LightVela plans to enter public beta and start billing on August 18, 2026 (Singapore Time). After public beta and billing officially start, beta users' existing plan validity will be extended by one additional month. See [LightVela Paid Version Announcement](./announcements/public-beta.md).
>
> * **New-user benefit after public beta and billing start**: New users can try the Launch plan free for 14 days.

LightVela is a cloud Agent hosting product from the Tencent Lighthouse team. It is designed to let everyone own an **AI companion that truly belongs to them**—not a tool that asks you to introduce yourself every time, but a long-term presence that **knows you, remembers you, and understands you better over time**.

Your Agent stays online 24/7, runs independently, and is always ready to chat. You decide its model, tools, and persona.

We lower the configuration barrier through a visual console: no config files, no server login, just select options on the web page to complete setup.

The current LightVela product is **Hermes Agent**, an AI Agent powered by large language models. More ready-to-use products may be added in the future. This documentation focuses on Hermes Agent.

![1.00](./images/1-1.webp)

***

## Who it is for

* Users who want to use an AI Agent but do not have technical knowledge of servers, containers, API authentication, and related infrastructure

* Users who prefer interacting with AI through everyday messaging platforms (WeChat / Telegram / WhatsApp / Discord) instead of a standalone app

* Users who want to choose from multiple large language model providers (including ChatGPT, Claude, Gemini, Deepseek, Qwen, Zhipu, Hunyuan, and more)

* Users who need persistent memory across conversations instead of starting from scratch every time

## Not suitable for

* Users who require fully local execution with no data leaving their device

* Users who need to train or fine-tune the underlying model

* Developers who need to integrate an Agent into their own website or application

***

## Product features

* **Fully managed deployment**: The cloud automatically handles environment setup and runtime management. No server operations, container images, or infrastructure knowledge required

* **Isolated runtime environment**: Each Hermes Agent instance has its own runtime environment, resource isolation, 24/7 availability, and no dependency on local devices

* **Multi-model support**: Connect to mainstream Chinese large language models, provider Coding Plan subscriptions, or any OpenAI-compatible endpoint. See [Configure Models](./configuration/model.md)

* **Multi-channel access**: Chat with Hermes Agent through WeChat, Telegram, WhatsApp, and Discord

* **Skill extensions**: Install skill packages from [SkillHub](https://skillhub.tencent.com) to extend Hermes Agent capabilities

* **Ready to use**: The Launch plan includes trial credits, so you can start chatting after activation without configuring a model separately

* **Dedicated cloud storage**: Conversation and memory data are stored independently

***

## How it works

LightVela runs a dedicated Hermes Agent instance for each user in the cloud, then connects it to the messaging platform selected by the user through an adapter layer.

```
User (sends a message in WeChat / Telegram / WhatsApp / Discord)
      ↓
User-dedicated Hermes Agent instance in the LightVela cloud
      ↓
Calls the configured large language model (GPT / Claude / Gemin / ...)
      ↓
Response returns through the original channel
```

A complete conversation loop requires three configurations:

1. **Model**: The large language model called by Hermes Agent. The Launch plan includes trial credits and can be used directly; you can also configure your own API Key

2. **Channel**: The messaging platform used to chat with Hermes Agent (WeChat / Telegram / WhatsApp / Discord)

3. **Skill** (optional): Additional capabilities for Hermes Agent

![1.00](./images/1-2.webp)

***

## About plans

LightVela uses plan-based billing. Activating a plan gives you one available Hermes Agent instance and the resources and credits included in that plan.

Currently available plans:

| Plan | Original price | Current status |
| --------- | ------- | ---- |
| Launch | $7.5 / month | 14-day free trial for new users after public beta and billing start |
| Cruise | $15 / month | Paid plan |

The Launch plan includes: 1 Hermes Agent instance, 2-core 4G isolated runtime environment, 50G dedicated cloud storage, 100 trial credits, 24/7 availability, and console access.

> ℹ️ **Beta plan notice**
>
> LightVela plans to enter public beta and start billing on August 18, 2026 (Singapore Time). After public beta and billing officially start, beta users' existing plan validity will be extended by one additional month, and new users can try Launch free for 14 days. See [LightVela Paid Version Announcement](./announcements/public-beta.md).

***

## Relationship with Lighthouse (optional)

For users familiar with Tencent Cloud: LightVela can be understood as a ready-to-use packaging of Tencent Lighthouse cloud Agent deployment capabilities. LightVela removes concepts such as Tencent Cloud accounts, resource management, and cloud resource operations, leaving only two core actions: configuring an Agent and connecting it to a messaging platform.

If you are new to cloud Agents, you can skip this section.

***

## Next steps

* **[Quickstart](./02-quickstart.md)** — Complete your first conversation in 5 minutes

* **[Core Concepts](./04-core-concepts.md)** — Understand the four core concepts: Hermes Agent, models, channels, and skills

* **[Configuration Overview](./05-configuration.md)** — Console features and configuration flow
