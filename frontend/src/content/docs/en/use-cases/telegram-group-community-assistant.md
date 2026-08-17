# How to Configure a Telegram Group AI Community Assistant: Welcome Messages, FAQs, Summaries, and Reminders

## Summary

**Start with the capability boundary: the Telegram channel page states plainly that group chats are not currently supported and only one-to-one conversations work, so the full flow of adding a bot to a Telegram group and auto-welcoming members cannot be completed on LightVela today.** Neither BotFather's privacy mode nor @-mentioning the bot in a group substitutes for channel-level group support in LightVela. The workable path right now: connect one-to-one conversations per the channel guide, mature all four content flows — welcome, FAQ, summaries, reminders — in direct messages, and complete the pre-launch checklist. That way, once group support ships, you only switch the trigger context; the content and persona need no rework. Treat this page as a design and preparation guide rather than an implementation walkthrough.

![A Telegram group AI community assistant for welcome messages, FAQs, summaries, and reminders](../images/use-case-08-telegram-group-community-assistant.png)

## Current capability boundary

The channel notes on the current Telegram channel page explicitly state that group chats are not currently supported and only 1-to-1 conversations are supported.

Therefore, LightVela cannot currently complete the full flow of adding a Bot to a Telegram group and automatically welcoming new members through this page.

BotFather privacy mode or Telegram group @mention settings do not replace LightVela support for group-chat processing.

If you need Telegram now, connect a 1-to-1 conversation through [Configure Channel - Telegram](../configuration/channel-telegram.md), then validate the FAQ, summary, and reminder workflows in private chat.


## Who this is for

This preparation guide is for people designing a Telegram community assistant or organizing product requirements and operating rules in advance.

It is also for teams that have validated Skills and content workflows in 1-to-1 conversations and are waiting for group-chat support.

## Design the four community-assistant capabilities

Before configuring a channel, define the trigger, output format, and failure behavior for each capability.

| Capability | Suggested trigger | Output requirement | Failure behavior |
|---|---|---|---|
| Welcome message | New-member event | A short welcome, community rules, and a question entry point | Do not repeat messages when the event is duplicated or missing |
| FAQ | Member question or @mention | Use confirmed material only and include a source when useful | Clearly hand off to a human or admin when no answer is available |
| Discussion summary | Admin request or scheduled time | Separate conclusions, action items, owners, and open questions | State the summary scope when context is incomplete |
| Reminder | Scheduled time or admin-created task | Include time, audience, purpose, and cancellation method | Notify the admin on failure instead of repeatedly spamming |

## Preparation checklist

### 1. Define the Agent personality and community rules

Use the [SOUL.md personality guide](./im-agent-persona-soul-md.md) to define the assistant's role, voice, information boundary, and human-handoff rule.

Also define whether it may speak proactively, whether it must be mentioned before replying, and how it should hand controversial content to an admin.

Do not treat the personality brief as a replacement for platform authorization, privacy, or message-rate limits.

### 2. Prepare FAQs and reference material

Organize the product overview, community rules, service hours, admin contacts, and escalation path into maintainable reference material.

Put material that needs to be consulted over time in [Cloud Storage](../configuration/files.md) instead of putting a large FAQ set into long-term memory.

Start by testing this request in a 1-to-1 conversation:

    Answer only from the prepared FAQ. If there is no supporting material, say that the information is missing and suggest a human handoff.

### 3. Design summary and reminder templates

A summary should separate confirmed conclusions, action items, owners, and unresolved questions.

A reminder should include the time, audience, purpose, and cancellation method, with a reasonable frequency and quiet hours.

Validate these workflows through [Automations](../configuration/automation.md) in a supported target channel before planning a group deployment.

### 4. Choose a trusted Skill

If you need reference retrieval, discussion summaries, or scheduled content, choose a Skill from [Skills.sh](https://skills.sh/) or [ClawHub](https://clawhub.ai/).

Read the permissions and high-risk Skill guidance in [Configure Skills](../configuration/skill.md) before installing anything.

Validate the Skill in a 1-to-1 conversation before considering any group deployment.

## What to verify if group support becomes available

- Whether the Bot can receive member-join events and distinguish members, admins, and anonymous identities.

- Whether group messages trigger only on @mentions or explicit commands.

- Whether you can configure allowed groups, members, or admin lists.

- Whether group messages enter shared long-term memory and how they are prevented from leaking to other members.

- Whether welcome messages, FAQs, summaries, and reminders have separate rate limits and deduplication.

- Whether external messages, file changes, moderation suggestions, and other high-risk actions require admin confirmation.

- How an admin takes over when the Bot fails, the service is unavailable, or the answer is uncertain.

## A currently workable validation path

Split the plan into two stages for now.

In stage one, validate the personality, FAQs, summaries, reminders, and Skills in a Telegram 1-to-1 conversation.

In stage two, after product documentation explicitly supports Telegram groups, add the actual Bot-join, group-permission, @mention, and group-memory-isolation steps.

If you need a group assistant immediately, choose a channel whose current product documentation explicitly confirms group support and follow that channel's access and permission guidance.

## FAQ

### Can I add a LightVela Telegram Bot to a group now?

Not according to the current international Telegram channel documentation.

The current support scope remains 1-to-1 conversations, and this page does not provide setup steps for an unavailable group feature.

### Will disabling privacy mode in BotFather make it work?

Not necessarily.

BotFather privacy mode changes how a Telegram Bot receives messages, but it does not add group-processing capability that LightVela has not currently exposed.

### Can I prepare the welcome, FAQ, and summary Skills now?

Yes.

Prepare the reference material, validate the outputs in a 1-to-1 conversation, and record the future requirements for triggers, permissions, privacy, and rate limits.

### Can WhatsApp groups be used as an alternative?

The current WhatsApp channel documentation also says that group chats are not supported and only 1-to-1 conversations are supported.

If you need group capability immediately, consult the current official documentation for another channel instead of assuming that Telegram or WhatsApp 1-to-1 support extends to groups.

## Next steps

- [Configure Channel - Telegram](../configuration/channel-telegram.md) - Complete the currently supported Telegram 1-to-1 setup.

- [How to Turn an IM Agent into a Customer-Service, Community, or Companion Assistant with Skills](./im-agent-skill-scenarios.md) - Prepare Skills for FAQs, summaries, and reminders.

- [How to Define an IM Agent's Role, Personality, and Voice with SOUL.md](./im-agent-persona-soul-md.md) - Define the community assistant's voice and boundaries.

- [Automations](../configuration/automation.md) - Validate scheduled reminders in supported channels.
