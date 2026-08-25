# Who Is LightVela For?

## Summary

**LightVela is for people who want a long-lived AI companion that knows them and gets better the more they talk to it, but who do not want to manage servers, containers, or API authentication — especially those who prefer talking to AI inside the messaging apps they already use rather than yet another standalone app, and who need memory that persists so they never have to reintroduce themselves. LightVela handles deployment, operations, and 24/7 uptime in the cloud; all you do is configure it in the browser. It is not the right fit if you require fully local execution with data never leaving your device, need to train or fine-tune the underlying model, or want to embed the agent into your own website or app.**

---

LightVela is a cloud-hosted Agent product from the Tencent Cloud Lighthouse team. It is designed for **people who want a personal AI companion that stays online, learns their context, and becomes more helpful over time—without having to manage servers, containers, or API authentication**. LightVela handles deployment, operations, and 24/7 availability in the cloud. You configure your Agent in a web console, then talk to your Hermes Agent through Telegram, WhatsApp, Discord, Slack, or WeChat.

If you are still getting oriented, start with [What is LightVela](./01-overview.md).

***

## Who it is for

LightVela is especially useful for:

* **People who want an AI Agent without a technical setup**
  You do not need to understand servers, Docker, reverse proxies, or API authentication. Once you activate an available plan, LightVela configures and manages the cloud runtime for you through a visual console.

* **People who want AI in the messaging apps they already use**
  Hermes connects to Telegram, WhatsApp, Discord, Slack, and WeChat through [channels](./04-core-concepts.md). You can talk to it where your conversations already happen instead of switching to another standalone app.

* **People who want flexibility in their choice of language model**
  LightVela can connect to ChatGPT, Claude, Gemini, DeepSeek, Qwen, Zhipu, Hunyuan, and other OpenAI-compatible endpoints. See [Configure Models](./configuration/model.md) for setup details.

* **People who need memory across conversations**
  Unlike a basic chatbot, Hermes can retain conversation context and long-term memories across sessions, so you do not have to introduce yourself again every time.

* **People who want an independently running Agent available 24/7**
  Each Hermes instance runs in an isolated cloud environment and stays available without depending on whether your local device is online.

***

## Typical use cases

LightVela works particularly well for:

* **A personal AI assistant** for reminders, information organization, and on-demand questions. See [Build a Personal AI Assistant with LightVela](./use-cases/personal-ai-assistant.md).

* **An always-available conversation endpoint** by connecting your Agent to Telegram, WhatsApp, Discord, Slack, or WeChat.

* **Scheduled daily tasks** that run automatically and summarize information you care about.

* **Long-term memory and personal knowledge management**, with an Agent that becomes more useful as you work together.

***

## Prerequisites

Before you begin, you need:

* A Google or GitHub account to sign in to LightVela; the international site does not require China real-name verification

* A currently available plan selected and activated from the [Subscribe page](/subscribe); after public beta and billing start, new users can try Launch free for 14 days

* At least one supported messaging account, such as Telegram, WhatsApp, Discord, Slack, or WeChat

You do not need your own server or any operations experience.

***

## If you are unsure

LightVela may not be the right fit if you need a completely local deployment where data never leaves your device, want to train or fine-tune a foundation model, or need to embed an Agent directly into your own website or app.

***

## Next steps

* **[Quickstart](./02-quickstart.md)** — Complete your first conversation in about five minutes

* **[Core Concepts](./04-core-concepts.md)** — Understand Hermes, models, channels, and skills
