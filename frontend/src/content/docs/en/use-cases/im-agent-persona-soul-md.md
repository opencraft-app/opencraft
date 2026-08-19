# How to Define an IM Agent's Role, Personality, and Voice with SOUL.md

## Summary

**Whether an IM Agent feels like "the same person" depends on its persona, not on which channel it runs through. `SOUL.md` carries the role, tone, priorities, behaviour, and limits, and it is the core persona file in the Hermes runtime.** On LightVela you never touch the cloud filesystem directly — the Persona section on an Agent's settings page offers two entry points, drawing a persona at random or answering a short quiz. Review a persona card's role, tone, and behaviour notes, then choose Inject Persona to apply it. Write judgeable principles rather than specific facts: "lead with the conclusion", "state uncertainty explicitly", and "confirm before sending external messages" are persona rules, while project names and ports belong in long-term memory. After injecting, verify tone and limits with one real conversation.

![Defining an IM Agent's role, personality, and voice with SOUL.md](../images/use-case-05-im-agent-persona-soul-md.png)

## Who this is for

This guide is for people who want to give an IM Agent a stable role, such as a personal assistant, research partner, study companion, or everyday customer-communication assistant.
If you have not chosen a messaging channel yet, start with [How to Connect an AI Agent to Messaging Platforms](./chinese-messaging-channels.md).

## Understand the three context layers first

### `SOUL.md`: who the Agent is and how it works

`SOUL.md` is best for stable persona rules, including role, voice, priorities, behavior, and boundaries.
Rules such as "give the conclusion first", "state uncertainty clearly", and "ask before sending an external message" belong here.

### User profile: who you are and how you want to be treated

The user profile is best for your language, time zone, identity, background, and communication preferences.
For example, "I am in Singapore", "use English by default", and "show deadlines first" are usually user preferences, not Agent identity rules.

### Long-term memory: what you have established together

Long-term memory is best for project state, decisions, and reusable context from your shared work.
It grows through continued conversation and can be reviewed or capacity-managed in [Memory Management](../configuration/memory.md).

Mixing the three makes the Agent's identity, user preferences, and temporary project context interfere with one another.
Keeping them separate lets the personality stay stable while the conversation adapts to the real user and work.

## Prerequisites

- A running LightVela Hermes Agent.
  If you have not created one yet, start with the [Quickstart](../02-quickstart.md).

- A configured model and at least one available conversation channel.

- A short persona brief.
  Decide who the Agent serves, what it mainly does, how it should sound, and which actions always require confirmation.

## Steps / key concepts

### 1. Define the persona goal with five questions

Before choosing a Soul, answer these five questions:

- Who is the Agent?

- Who does it mainly help?

- How should it normally sound?

- What should it do when information is uncertain?

- Which external actions require confirmation first?

Turn the answers into a planning brief like this:

```text
Role: A research assistant for personal projects
Audience: A user who wants reliable conclusions quickly
Voice: Concise, professional, friendly, conclusion first, evidence second
Behavior: Break down questions, flag uncertainty, and ask only one key question when needed
Boundaries: Never send external messages, change files, or take high-risk actions without confirmation
```

This template helps you choose and calibrate a persona.
It does not mean that LightVela exposes a general-purpose editor for arbitrary cloud files.

### 2. Open Personality in Agent settings

In the LightVela console, open the target Hermes Agent's settings and select "Personality".
The international site provides both "Draw random soul" and "Soul personality test" entry points.

Use the random draw to explore different role styles.
Use the personality test when you want a Soul that better matches your communication and behavior preferences.

Review the role, voice, and behavior description on each card, then choose the one that best matches your planning brief.

### 3. Inject the selected Soul into `SOUL.md`

Select the Soul and click "Inject soul".
LightVela writes the selected Soul to the current Hermes Agent's `SOUL.md` and keeps a backup before replacing an existing file.

Only one personality is active for an Agent at a time.
If you want to switch roles, review the new card's boundaries before injecting it again.

After the injection succeeds, return to your IM channel and send:

```text
/new
```

Hermes Agent reads the new `SOUL.md` when a new conversation starts.
This matters because an existing conversation may still hold the previous persona snapshot.

### 4. Add user preferences and durable facts through conversation

Do not put every piece of information into `SOUL.md`.
Keep the stable persona short, and let the user profile and long-term memory handle personal preferences and project facts.

For example, tell Hermes:

```text
Remember that I am in Singapore time and want a concise weekday plan at 8:00 AM, with deadlines listed first.
```

Or:

```text
Forget the Friday evening reminder preference I mentioned earlier. Do not schedule it again.
```

Hermes handles remember and forget requests through conversation.
Use [Memory Management](../configuration/memory.md) to review Memory and User Profile content and capacity.

### 5. Install skills only for real work

Personality defines how the Agent works, but it does not automatically add external capabilities.
If you want it to browse, organize material, look up information, or perform another concrete task, install a suitable skill and check its source and permissions first.

Start with [Configure Skills](../configuration/skill.md).
Skills and personality should reinforce each other, not use a high-risk skill to compensate for unclear persona boundaries.

## Verify that the personality is active

After starting a new conversation, do more than ask for a self-introduction.
Test at least these four cases:

```text
What is your current role, main job, and default voice?
```

```text
How do you respond when you are uncertain about a fact?
```

```text
If I ask you to send a message to an external service, what do you do first?
```

```text
Turn this material into conclusions, evidence, and questions that still need confirmation.
```

Check whether the Agent preserves the role, voice, and safety boundaries, and whether it can still use relevant context from the user profile and long-term memory.
If the behavior is unstable, simplify the persona rules before choosing or injecting another Soul.

## FAQ

### Do I need to edit the cloud `SOUL.md` manually?

Usually not.
LightVela's Personality entry generates and injects the Soul, so normal use does not require direct cloud file-system operations.

### Does changing `SOUL.md` affect every messaging channel?

It affects Agent-level behavior for the same Hermes Agent.
If that Agent is connected to Telegram and WhatsApp, both channels use the personality in new conversations, while each channel still has its own authorization, message format, and capability limits.

### Can `SOUL.md` replace memory?

No.
`SOUL.md` should describe stable identity and behavior rules, while memory should retain changing facts, project context, and shared experience.

### Can one Agent have several active personalities at the same time?

Currently, one Agent has one active personality at a time.
If you need completely different roles, create separate Agents instead of repeatedly overwriting the Soul on one Agent.

### When should I send `/new`?

Send `/new` in the IM channel after injecting a new personality.
This makes it explicit that the new Soul should load during conversation initialization.

## Next steps

- [How to Configure a Hermes Agent with a Distinct Personality in Telegram](./telegram-persona-agent.md) - Apply the personality to 1-to-1 Telegram conversations.

- [How to Configure a Hermes Agent with a Distinct Personality in WhatsApp](./whatsapp-persona-agent.md) - Apply the personality to 1-to-1 WhatsApp conversations.

- [Where Hermes Agent's Personality Comes From](../hermes-agent/10-persona-user-memory.md) - Understand Persona, user preferences, and long-term memory in more depth.

- [Cloud Storage](../configuration/files.md) - Manage reference material and work files that the Agent can use.
