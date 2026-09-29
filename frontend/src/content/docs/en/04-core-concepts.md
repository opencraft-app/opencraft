# Core Concepts

## Summary

**LightVela has five core concepts: a Hermes Agent is the cloud instance; Bots are separate profiles inside it; each Bot has model settings, connected messaging channels, and installable Skills. Bots can keep separate personas, memory, and scheduled tasks. Channels connected to the same Bot share its behavior, while different Bots do not automatically share their settings. A message arrives through a channel, the selected Bot may use a Skill and a model, and the reply returns through that channel.**

---

LightVela has five related concepts: Hermes Agent, Bots, models, channels, and Skills. This page explains how they fit together.

## This page covers

- The relationship among five concepts

- Characteristics of a Hermes Agent instance

- The positioning and configuration entry points of models, channels, and skills

- The internal flow of a complete conversation

---

## Concept relationship

```text
Hermes Agent (cloud instance)
  └─ Bot profiles (main Bot and optional additional Bots)
       ├─ Primary model and optional fallbacks
       ├─ Connected channels
       └─ Skills, Soul, memory, scheduled tasks
```

| Concept | Role | Description |
|---|---|---|
| Hermes Agent | Cloud instance | The environment that hosts the Bot profiles |
| Bot | Independent profile | Has its own model, channels, Skills, persona, memory, and scheduled tasks |
| Model | Language capability | The language model used by a Bot |
| Channel | Interaction entry point | The platform where users chat with a Bot |
| Skill | Capability extension | An additional capability package a Bot can call |


---

## Hermes Agent

Hermes Agent is the AI Agent instance in LightVela. Creating a Hermes Agent is equivalent to starting an independent Agent instance in the cloud.

Hermes Agent has the following characteristics:

- **Dedicated cloud environment**: Each Hermes Agent runs in its own environment, with resources isolated from other instances

- **Persistent memory**: Conversation content is saved across sessions, and the Agent uses historical context when responding

- **Always online**: Runs 24/7 and does not depend on the user's local device

The current Launch plan supports creating up to 1 Hermes Agent instance.

---

## Bots

Each Hermes Agent has a main Bot and may support additional Bots, depending on plan allowance and availability. Bots live inside the same cloud instance but keep their settings and data separate. Select the intended Bot before changing a model, channel, Skill, or memory. See [Manage Bots](./configuration/bots.md).

---

## Models

A model is the large language model (LLM) that drives Hermes Agent thinking and responses. LightVela does not train models itself. Instead, users select a calling method in the "Model" card of the console:

| Method | Billing mode | API Key source | Use case |
|---|---|---|---|
| Model Coding Plan | Monthly | Provider | High-frequency usage |
| Model API | Pay-as-you-go | Provider | Low-frequency use or trial |
| Custom model | Depends on endpoint | User-provided | Connect overseas models or OpenAI-compatible endpoints |

In addition, the Launch plan includes 100 trial credits, so you can chat out of the box without any configuration; after the trial credits run out, you can configure your own API Key.

For supported models, API Key acquisition, and model selection guidance, see [Configure Models](./configuration/model.md).

> A Bot uses one primary model at a time. Additional configured models or fallbacks can be available; switching the active model does not require deleting the previous configuration. See [Model Switching](./configuration/multiple-models.md).

---

## Channels

Channels are the messaging platform entry points where users chat with Hermes Agent. LightVela currently supports the following channels:

| Channel | Access method | Use case |
|---|---|---|
| WeChat | QR-code authorization | Daily personal use, suitable for users in China |
| Telegram | Bot Token access | Personal or team messaging, simple setup, suitable for lightweight automation |
| WhatsApp | QR-code scan | International user communication, customer service, notifications, and reminders |
| Discord | Bot Token access | Community operations, developer communities, gaming or interest groups |
| Slack | Bot Token / App Token access | Team collaboration, workspace notifications, and channel-based workflows |

On the **WeChat** card in **Channels**, select **+ Connect** and scan the QR code with your phone.

Detailed access steps for each channel: [Configure Channel - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md).

> 💡 **Multiple channels can coexist**
>
> Channels connected to the same Bot share that Bot's persona and memory. Channels attached to different Bots do not automatically share those settings.

---

## Skills

Skills are additional capability packages callable by Hermes Agent. They extend Hermes Agent beyond basic conversation for specific tasks such as organizing to-dos, generating daily reports, browsing the web, generating images, and more.

Skills are available from [Skills.sh](https://skills.sh/) and [ClawHub](https://clawhub.ai/). Browse these sources in the console **Skills** page and review a result before installing.

Open **Skills** in the console, search for an individual Skill or browse **Skill Packages**, then select **Install**. Check the **Installed** tab to verify the result. See [Configure Skills](./configuration/skill.md).

> ⚠️ **Security check before installation**
>
> Skills have permission to call Hermes Agent capabilities at runtime. Before installing a skill, confirm that the author is trustworthy and prefer skills with high downloads and good ratings.

---

## Interaction flow

A complete conversation flow works as follows:

1. The user sends a message to Hermes Agent through a channel (such as WeChat)

2. Hermes Agent determines whether a skill needs to be called based on the message

3. The model processes the context and generates a response

4. The response returns to the user through the original channel

---

## Next steps

- [Configuration Overview](./05-configuration.md) — Full console feature guide

- [Quickstart](./02-quickstart.md) — Getting started when no Hermes Agent has been created
