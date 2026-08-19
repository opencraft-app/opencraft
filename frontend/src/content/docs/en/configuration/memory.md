# Memory Management

Memory helps Hermes retain important information across conversations and devices—your preferences, identity, work in progress, and the experience it develops through long-term collaboration. It is what turns Hermes from a one-off question-answering tool into a long-term assistant that understands you better over time.

![The Memory and User Profile page in the LightVela console](../images/memory-management-overview-en.png)

LightVela is cloud-hosted, so these memories are stored with your Hermes instance in the cloud. They are not lost when you change devices or switch between Telegram, WhatsApp, Discord, Slack, and WeChat. If you tell Hermes something in Telegram today, it can still remember it when you continue the conversation in WhatsApp tomorrow.

## What this page covers

- The problem memory solves

- Two types of memory: Agent memory and the user profile

- How to view memories and capacity usage in the console

- How to adjust memory capacity limits

- How to add or remove memories through conversation

- Frequently asked questions

> 💡 **Memory builds automatically—you do not need to enter it manually**
>
> You do not need to fill in a memory form. During normal conversations, Hermes decides which information is useful enough to retain. The Memory page in the console is primarily for **reviewing** what Hermes remembers and **adjusting capacity** when needed.

---

## Why memory matters

Without memory, every conversation with an AI assistant starts from a blank page. You have to explain who you are, what you prefer, and where the last conversation ended. Memory solves that problem:

- **Repeat yourself less**: Tell Hermes once that you live in Singapore and prefer a morning briefing, and you do not need to restate it every time.

- **Stay consistent across channels**: Telegram, WhatsApp, Discord, Slack, and WeChat share the same memory. When you switch channels, you are still talking to the same assistant that understands you.

- **Improve through continued use**: As you work together, Hermes remembers your routines, preferred names, and active projects, making its responses increasingly relevant.

Think of memory as Hermes's long-term notebook. It does not preserve every casual message; it retains the details that are likely to be useful later.

---

## Two types of memory

The Memory page in the console has two tabs, each serving a different purpose:

### Memory

This contains the **experience and facts** Hermes develops through long-term collaboration—preferences you have shared, agreed ways of working, and needs that recur over time. Hermes maintains this content automatically during conversations, and entries evolve as you continue using it.

### User Profile

This is a stable record of **who you are**, such as your identity, location, professional background, and long-term preferences. Compared with general memory, the user profile works more like a persistent profile card that helps Hermes quickly understand your basic context in any conversation.

> ℹ️ **How they differ**
>
> In short, the **user profile** answers “What kind of person are you?” while **memory** answers “What has happened between us, and what have we agreed on?” Together, they help Hermes understand both you and the history of your collaboration.

---

## View memories and capacity usage

1. Sign in to LightVela and click “My Hermes” in the upper-right corner to open the console.

2. Find “Memory” in the settings navigation and open the Memory page.

3. At the top of the page, review the **memory statistics**: characters currently used, the capacity limit, and the percentage used.

4. Switch between the “Memory” and “User Profile” tabs to review each type of content.

If either type is empty, the page displays “No Agent memory” or “No user profile.” This usually means you have not worked with Hermes for long enough to build that type of memory. Content will accumulate over time.

> 💡 **What the usage percentage means**
>
> Memory has a capacity limit. As usage approaches that limit, Hermes favors more important information and removes outdated entries. Monitoring the percentage helps you decide whether to increase capacity or remove information you no longer need.

---

## Adjust memory capacity limits

You can increase a capacity limit when you want Hermes to retain more information, or reduce it when appropriate.

- **Memory** can be set from 500 to 4,000 characters.

- **User Profile** can be set from 500 to 3,000 characters.

The new limit takes effect after you save it.

> ⚠️ **Saving a new limit briefly restarts the gateway and may interrupt the current conversation**
>
> When you save a new capacity limit, the Hermes gateway briefly restarts to apply the configuration. A conversation in progress may be interrupted for a moment and will recover shortly afterward. Make the change at a time when a brief interruption will not affect your work.

---

## Add or remove memory through conversation

In addition to reviewing content in the console, you can ask Hermes directly to remember or forget information. This is usually the most natural way to maintain memory during everyday use.

**Ask it to remember:**

```
Remember that I want my daily briefing at 8:00 AM.
```

```
Remember that I prefer concise, direct answers.
```

**Ask it to forget:**

```
I no longer need the daily briefing we discussed. Please forget that preference.
```

Hermes interprets your intent, updates the relevant memory entry, and tells you what changed.

> ℹ️ **Memory content is currently maintained through conversation**
>
> LightVela uses a managed cloud model and does not expose user-facing file-system operations. Add or remove memory content primarily by talking to Hermes; use the console to review content and adjust capacity limits.

---

## FAQ

### Why did Hermes remember something I did not explicitly ask it to save?

This is expected. Hermes automatically identifies information that may be useful over time, such as your preferences, identity, and working agreements. If you do not want it to keep something, ask it to forget that information in the conversation.

### Does memory remain when I change devices or channels?

Yes. Memory is stored with the cloud instance and is independent of any one device or channel. Telegram, WhatsApp, Discord, Slack, and WeChat all share the same memory.

### What happens when memory reaches capacity?

As usage approaches the limit, Hermes prioritizes more important information and gradually removes outdated or less useful entries. If you need it to retain more, increase the capacity limit on the Memory page.

### Why does the Memory page say there is no memory?

That type of memory has not accumulated any content yet. Continue working with Hermes, or directly ask it to remember an important detail, and content will begin to appear.

### Why did my conversation pause after I changed the capacity limit?

Saving a new limit triggers a brief gateway restart, which can interrupt a conversation momentarily. Wait a short time, then send the message again.

---

## Next steps

Memory helps Hermes remember you. Next, give it more ways to act:

- [Configure Skills](./skill.md) — Add capabilities such as weather lookup, briefings, and web browsing

- [Automations](./automation.md) — Let Hermes run tasks proactively on a schedule

- [Configuration Overview](../05-configuration.md)
