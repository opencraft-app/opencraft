# Core Concepts

LightVela involves four core concepts: Hermes Agent, models, channels, and skills. This page explains their roles. For detailed configuration steps, see the corresponding configuration pages.

## This page covers

- The relationship between the four concepts

- Characteristics of a Hermes Agent instance

- The positioning and configuration entry points of models, channels, and skills

- The internal flow of a complete conversation

---

## Concept relationship

```
┌──────────────────────────────────────────────────────────────┐
│                         Hermes Agent                         │
│              (Agent running in the LightVela cloud)           │
└──────────────────────────────────────────────────────────────┘
      │                          │                        │
┌─────┘                          │                        └──────┐
▼                                ▼                               ▼
┌───────┐                   ┌────────┐                   ┌────────┐
│ Model │                   │Channel │                   │ Skill  │
└───────┘                   └────────┘                   └────────┘
 Model provider    Telegram/WhatsApp/Discord/Slack/WeChat      SkillHub
```

| Concept | Role | Description |
|---|---|---|
| Hermes Agent | Conversation subject | The AI Agent instance itself |
| Model | Language capability | The large language model called by Hermes Agent |
| Channel | Interaction entry point | The platform where users chat with Hermes Agent |
| Skill | Capability extension | Additional capability packages callable by Hermes Agent |

![](./images/3-1.webp)

---

## Hermes Agent

Hermes Agent is the AI Agent instance in LightVela. Creating a Hermes Agent is equivalent to starting an independent Agent instance in the cloud.

Hermes Agent has the following characteristics:

- **Isolated runtime environment**: Each Hermes Agent runs in a dedicated environment isolated from other instances

- **Persistent memory**: Conversation content is saved across sessions, and the Agent uses historical context when responding

- **Always online**: Runs 24/7 and does not depend on the user's local device

The current Launch plan supports creating up to 1 Hermes Agent instance.

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

> ⚠️ **Only one model is active**
>
> Currently, each Hermes Agent can have only one active model configuration. To switch models, use "Add as default" to overwrite the previous configuration.

---

## Channels

Channels are the messaging platform entry points where users chat with Hermes Agent. LightVela currently supports the following channels:

| Channel | Access method | Use case |
|---|---|---|
| WeChat | QR-code authorization | Daily personal use, suitable for users in China |
| Telegram | Bot Token access | Personal or team messaging, simple setup, suitable for lightweight automation |
| WhatsApp | WhatsApp Business API access | International user communication, customer service, notifications, and reminders |
| Discord | Bot Token access | Community operations, developer communities, gaming or interest groups |
| Slack | Bot Token / App Token access | Team collaboration, workspace notifications, and channel-based workflows |

For WeChat, choose the channel and click "Authorize Access" to generate a QR code. Scan it with your phone to complete authorization.

Detailed access steps for each channel: [Configure Channel - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md).

> 💡 **Multiple channels can coexist**
>
> Multiple channels can be connected to the same Hermes Agent instance and share memory and Agent behavior. No matter which channel sends a message, the conversation target is the same Hermes Agent.

---

## Skills

Skills are additional capability packages callable by Hermes Agent. They extend Hermes Agent beyond basic conversation for specific tasks such as organizing to-dos, generating daily reports, browsing the web, generating images, and more.

All skills come from [SkillHub](https://skillhub.tencent.com), an independent skill marketplace launched by Tencent. In SkillHub, you can browse listed skills and view their feature descriptions and examples.

Enter the skill name recorded on SkillHub in the "3. Skills" card of the console and click "Install Skill" to install it. You can also ask Hermes Agent directly in conversation to install or delete skills. See [Configure Skills](./configuration/skill.md).

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
