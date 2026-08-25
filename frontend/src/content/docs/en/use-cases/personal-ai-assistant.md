# How to Build a Personal AI Assistant with LightVela

## Summary

**The right order for building a personal AI assistant is not automating everything at once. Start by making a cloud Hermes Agent reachable in the chat app you already use, then layer on memory, skills, and automations.** Five building blocks each solve one problem: the model determines reasoning quality, the channel determines where you reach it, memory lets it retain how you work, skills give it reusable methods, and automations let it complete agreed work while you are absent. For the first week, do only three things: configure one model, connect one channel, and verify memory genuinely persists across sessions. Once that path is reliable, add skills and automations — this way, when something breaks, you can tell which layer caused it.

![A personal AI assistant with LightVela across channels](../images/use-case-personal-ai-assistant.webp)

## Who this is for

This setup works well if you want one assistant for everyday planning, research follow-ups, reminders, and questions that benefit from knowing your preferences. You do not need a complex workflow. Start with a single Hermes Agent and one channel you already check regularly.

It is especially useful when you find yourself repeating context such as your time zone, the format you prefer for summaries, the projects you are working on, or the kind of help you want each morning.

## Prerequisites

- A LightVela account and a running Hermes Agent. If you have not created one yet, start with the [Quickstart](https://lightvela.ai/docs/quickstart).

- One conversation channel. Telegram, WhatsApp, Discord, Slack, and WeChat are common starting points; choose the one you are most likely to open every day.

- A working model configuration or available trial credits. See [Configure Models](https://lightvela.ai/docs/configuration/model) if Hermes cannot reply yet.

- A short idea of what you want help with first. A single routine, such as planning your day or collecting follow-ups, is enough.

## Steps / key concepts

### 1. Give Hermes a place in your daily routine

Connect one messaging channel, then send the first few messages from the same place you normally organize your day. The channel is not just a delivery method—it is the habit that makes the assistant easy to return to. Follow the setup page for [Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), [Discord](https://lightvela.ai/docs/configuration/channel-discord), [Slack](https://lightvela.ai/docs/configuration/channel-slack), or [WeChat](https://lightvela.ai/docs/configuration/channel-wechat).

![The Channel page in the LightVela console](../images/personal-ai-assistant-channel.webp)

Begin with a clear introduction rather than a broad request. For example:

```text
I want you to be my personal planning assistant. I am in Singapore time.
Keep daily plans short, call out deadlines first, and ask one follow-up question when something is unclear.
```

### 2. Let memory carry the context that repeats

Hermes builds useful context over time, so you do not need to restate every preference in every conversation. Tell it the facts and working preferences that should remain useful: your time zone, how you want a briefing structured, important project names, or the days you prefer to plan ahead.

You can also state the request directly:

```text
Remember that I prefer a concise weekday briefing at 8:00 AM,
with meetings, deadlines, and the three most important next actions.
```

Use the [Memory Management](https://lightvela.ai/docs/configuration/memory) page to review the memory and user-profile information that Hermes has accumulated. Memory should reduce repetition, not become a dumping ground for every passing detail.

### 3. Add a skill only when a real task needs it

Hermes can chat without extra skills. Add one when you can name the practical job it should help with, such as looking up information, organizing a to-do list, or preparing a recurring report. This keeps the assistant understandable and easier to trust.

![The Skills page in the LightVela console](../images/personal-ai-assistant-skills.webp)

Browse a suitable option in ClawHub, then use [Configure Skills](https://lightvela.ai/docs/configuration/skill) to install it. Before you install anything, read its description and choose sources you trust.

### 4. Turn a useful conversation into a repeatable check-in

Once a prompt is reliably useful, decide whether it should run on a schedule. A simple automation can ask Hermes for a morning plan, an end-of-day review, or a weekly reset without you remembering to start the conversation.

For example:

```text
Every weekday at 8:00 AM, prepare a concise plan for today.
Start with deadlines and meetings, then suggest three focused next actions.
```

Set the schedule and notification channel in [Automations](https://lightvela.ai/docs/configuration/automation). Keep the first automation small; you can refine the instruction after you have seen a few real results.

![The Automations page in the LightVela console](../images/personal-ai-assistant-automations.webp)

## FAQ

### Do I need to configure every feature before Hermes is useful?

No. A channel and a working model are enough to begin. Add memory, skills, and automations gradually as you discover which repeated tasks are worth keeping.

### Will Hermes remember every message I send?

No. Memory is intended for information that remains useful across conversations, such as preferences, recurring work, and stable context. You can ask Hermes to remember or forget information when needed, then review it in Memory Management.

### Can I use the same assistant from more than one channel?

Yes. Multiple connected channels can point to the same Hermes Agent, so the assistant can retain the same context while you move between supported messaging platforms.

### What should I automate first?

Choose a task you already repeat at a predictable time. Morning planning, a short daily review, or a weekly priority check are good first candidates because you can quickly tell whether the output is helping.

## Next steps

- [Chat](https://lightvela.ai/docs/configuration/agent-chat) — work with Hermes directly in the console.

- [Memory Management](https://lightvela.ai/docs/configuration/memory) — review what your assistant retains across conversations.

- [Automations](https://lightvela.ai/docs/configuration/automation) — schedule the routines that prove useful.
