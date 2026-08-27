# How to Design a More Natural IM Agent: Conversation Rhythm, Group Norms, and Long-Term Social Memory

## Summary

**"More lifelike" does not mean impersonating a real person. It means keeping stable, understandable behaviour in expression, response, and long-term collaboration, and it comes down to three things: conversational rhythm, group norms, and long-term social memory.** Rhythm decides when it answers briefly, when it elaborates, and when it should stop and wait for confirmation. Group norms decide how it speaks in shared spaces, how it cites context, and how it respects members' boundaries. Long-term social memory decides whether it retains confirmed relationship context without turning every message into a permanent record. Implement these in layers: rhythm and norms are stable persona-level rules, while memory keeps only confirmed, durable facts. Use the natural-conversation checklist in this guide to verify the design.

![Designing a more natural IM Agent with conversation rhythm, group norms, and social memory](../images/use-case-10-lifelike-im-agent-rhythm-social-memory.png)

## Who this is for

This guide is for people who want an IM Agent to feel more natural and consistent while remaining transparent and controllable.

It works for personal assistants, study partners, research partners, and teams designing community assistants.

Telegram supports group messages after you disable Group Privacy in BotFather, add the Bot to the group, and mention it with `@bot_username`.
WhatsApp group capability remains subject to its own channel documentation, so apply these group norms to Telegram after setup and verify support before using another channel.

## Decide what should stay stable

Split the Agent's durable behavior into four layers:

| Layer | Responsibility | Recommended configuration |
|---|---|---|
| Personality | Role, voice, principles, and boundaries | SOUL.md |
| Relationship preferences | Name, language, detail level, and interaction habits | User profile |
| Social memory | Confirmed shared context, project background, and ongoing agreements | Memory |
| Current rhythm | Conversation context, length, and urgency for this task | Current session and task prompt |

Do not let one temporary emotion or accidental reply change the durable personality.

Do not save every greeting, every group member's message, or an unconfirmed inference as long-term social memory.

## Steps

### 1. Define a natural role without impersonation

Use the [SOUL.md personality guide](./im-agent-persona-soul-md.md) to define the Agent's role, voice, initiative level, and limitations.

Start with a brief like this:

    You are a stable, direct, and friendly research partner.
    Give the conclusion first, then add evidence and detail as needed.
    When the request is ambiguous, ask the single most important clarifying question.
    Remember confirmed long-term preferences, but do not save sensitive information or unconfirmed inferences.
    You are an AI assistant. Do not claim to be a human or pretend to have real-world experiences.

This keeps the voice coherent without building misleading trust through a fictional identity.

### 2. Design the conversation rhythm

Start with rules like these:

- Give a direct answer in one to three sentences for a simple factual question.

- Restate the goal and break down steps and risks before handling a complex task.

- Ask only the most important question when information is missing instead of sending a long form.

- Reduce response length when the user says they are busy, rushed, or wants only the conclusion.

- Expand the reasoning when the user asks for a derivation, tutorial, or retrospective.

- Stop and wait for confirmation before external, sensitive, or irreversible actions.

Validate the rhythm with real tasks:

    Give me the three most important tasks for today in three sentences.

    Give me the conclusion first, then explain why you ranked them this way.

    This action changes external data. First tell me the impact and what needs confirmation.

Check whether the Agent changes response length with the task and user preference while keeping the same principles.

### 3. Put relationship preferences in the user profile

The user profile is suitable for language, name, time zone, detail level, and common working style.

For example, a user can tell Hermes:

    Remember that I prefer concise, direct, conclusion-first replies.

Relationship preferences should improve communication efficiency, not become permanent personality labels that the user cannot change.

When a preference changes, ask Hermes to update or forget it instead of repeatedly editing the personality file.

### 4. Design long-term social memory

Good long-term candidates include confirmed project context, durable collaboration agreements, a stable preferred name, and repeatedly verified preferences.

Poor long-term candidates include passwords, verification codes, payment information, medical details, unconfirmed psychological judgments, and one-time small talk.

Ask Hermes explicitly to remember or forget an item, and periodically review and clean it in [Memory Management](../configuration/memory.md).

Long-term memory should reduce repeated questions without taking away the user's control over their information.

### 5. Prepare group norms for shared spaces

Telegram group messages are supported.
After disabling Group Privacy, adding the Bot to the group, and mentioning it with `@bot_username`, apply group norms to the live conversation.

Before using a group, define at least:

- Whether the Bot replies only after an @mention or explicit command.

- Whether an admin must trigger a welcome message for new members.

- Frequency limits for FAQs, summaries, and reminders.

- How to distinguish members, admins, and messages that require human handoff.

- Whether member messages enter shared memory and how they are prevented from leaking to other members.

- How disputes, complaints, moderation suggestions, and sensitive content are handed to an admin.

Group norms belong to channel and operating rules and should not rely only on a personality prompt.

### 6. Use automations to control proactive rhythm

Proactive messages need an explicit frequency, time window, target channel, and pause method.

Use [Automations](../configuration/automation.md) for personal reminders, internal summaries, or periodic checks.

Set quiet hours for every automation and confirm that the target channel supports the relevant proactive delivery method.

Do not create a sense of companionship through high-frequency messages, and do not make reminders difficult to stop.

## A natural-conversation checklist

- Did the Agent answer the user's actual question first?

- Did it adjust length to the task complexity?

- Did it ask a useful clarifying question when needed?

- Did it remember a confirmed preference rather than guessing the user's psychology?

- Did it remain clear that it is an AI instead of implying a real identity or offline experience?

- Did it explain the impact and wait for confirmation before an external action?

- Did it respect quiet hours, refusal, and forget requests?

## FAQ

### Does being more lifelike mean hiding that the Agent is AI?

No.

Natural language, stable rhythm, and continuous context can improve the experience, but the Agent should not claim to be human or invent real-world experiences.

### Should I save every conversation as social memory?

No.

Keep only confirmed information that helps future collaboration, and review the memory and user profile regularly.

### Can I use group norms in Telegram and WhatsApp now?

You can apply the group norms in this guide to Telegram group messages.
Disable Group Privacy, add the Bot to the group, and validate personality, rhythm, FAQs, and reminders by mentioning it with `@bot_username`.
For WhatsApp or another channel, first confirm that channel's own group-support scope.

### Why are some Agent replies long and others short?

Response length reflects task complexity, the current prompt, model output, and user preferences.

Set a preference in the user profile, or state in the current request that you want only the conclusion or a complete derivation.

## Next steps

- [How to Define an IM Agent's Role, Personality, and Voice with SOUL.md](./im-agent-persona-soul-md.md) - Stabilize the role, voice, and boundaries.

- [Memory Management](../configuration/memory.md) - Manage the user profile and long-term memory.

- [How to Turn an IM Agent into a Customer-Service, Community, or Companion Assistant with Skills](./im-agent-skill-scenarios.md) - Extend natural conversation with concrete capabilities.

- [How to Use a Telegram Group AI Community Assistant](./telegram-group-community-assistant.md) - Complete the group-message setup and apply group norms in practice.
