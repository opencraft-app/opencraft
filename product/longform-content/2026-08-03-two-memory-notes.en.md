# Why USER.md and MEMORY.md Cannot Be Merged

[RECOMMEND ADD IMAGE: A side-by-side visual. On the left, a sticky note on a monitor bezel with structured fields (name, role, communication preference); on the right, an open journal with dated entries. A divider between them emphasizes that the two ledgers evolve independently. — Conveys at a glance that profile and archive are two different kinds of memory.]

> **What is LightVela?** LightVela is a cloud-hosted personal AI agent platform for running an always-on agent with memory, skills, automations, and messaging channels. [Visit LightVela](https://lightvela.ai/?from=social_techpedia)

Hermes Agent's two long-term memory notes add up to only about **1,300 tokens** — remarkably restrained in an era of six-figure context windows. What surprises people more: it insists on keeping those 1,300 tokens in **two separate files** instead of merging them.

The reason is three hard constraints: **independent capacity, different loading semantics, and different update semantics.** Merging looks simpler and works worse.

## What each note holds

The **user profile** (~500 tokens) is a stable description of you: name, role, communication style, usual stack, schedule and constraints, long-term goals. It is **stable** (updated once every few days or weeks), **structured** (sectioned and field-based), and **loaded every session**.

The **factual archive** (~800 tokens) holds what you and the agent have done together: which port a project runs on, the hero section changed to an animated gradient last week, the agreement with team A to ship X in Q4, this API authenticating through an internal SDK rather than the public endpoint. It is **dynamic** (nearly every substantive session appends one or two entries), **itemized**, and targets 8–15 entries.

The distinction in one line: **the profile changes only when you change; the archive grows with every day of conversation.**

## Why they cannot be merged: three hard constraints

### Constraint 1: independent capacity, no mutual squeezing

Merge 500 + 800 into a single 1,300-token note and you immediately face an absurd decision: **when the archive is nearly full, should the agent delete a line about "who the user is" in order to record one more event?**

Obviously not — but once merged, that decision has to be made, and made **on every single write**. Kept separate, the two pools evolve independently: a full archive only squeezes itself and never contaminates the profile.

### Constraint 2: different loading semantics

Both load every session, but their roles in the system prompt are completely different:

- The profile answers "**who you are dealing with**", setting tone, level of detail, and stack assumptions.
- The archive answers "**what you have done together**", providing factual handles.

Merged, the two would **dilute each other** — the agent could no longer quickly tell "is this a communication style I must follow, or a past fact I should cite?"

### Constraint 3: different update semantics

- Preference fields in the profile mostly **overwrite the old value**: when you say "stop summarizing from now on", that line is replaced.
- The archive mostly **appends and consolidates on demand**: events are a time series, so history cannot be erased casually; a full store triggers active consolidation.

After merging, add / replace / remove would all have to coexist on one file, making both the implementation and your mental model **worse at the same time**.

## A concrete example

Suppose you tell the agent:

> "I'm Jasmin, a frontend engineer, and I like conclusion-first communication. I'm working on the global site for agent-demo (an AI agent app) with Next.js. Last week we changed the hero section to an animated gradient."

A well-trained agent splits that as follows.

**Into the profile:**

```md
## Identity
- Name: Jasmin
- Role: Frontend engineer

## Preferences
- Communication style: conclusion first
- Usual stack: Next.js
```

**Into the archive:**

```md
- [2026-07-30] agent-demo: hero section on the global site changed to an animated gradient.
- Related project: agent-demo / global site
```

The difference is clear: **"what kind of person you are" goes into the profile, "what we did together" goes into the archive.** The former changes only when you switch jobs or teams; the latter grows daily. **Separate files are what let each evolve on its own.**

## There is also a "what not to remember" list

The agent does not push everything into the profile. It keeps a skip list:

1. **One-off moods**: "my head hurts today" — not a stable attribute.
2. **Temporary task parameters**: "change this title to X for me" — disposable.
3. **Vague attitudes**: "I think I prefer things a bit more concise" — not reusable enough.
4. **Anything inferable from live context** — no need to persist.
5. **Sensitive information you have not explicitly confirmed** (emails, passwords, addresses) — not written by default.

That skip list is what keeps the profile at "500 tokens and high density."

## What this means for products

For an AI agent product, this layering is more than an engineering detail. It determines three things:

1. **Whether you can see "what it thinks of you"** — that needs a stable, readable, editable profile.
2. **Whether it avoids amnesia long term** — that needs a growing, recallable factual archive.
3. **Whether cost stays bounded** — only layered loading can both know who you are and avoid burning the whole context.

[LightVela](https://lightvela.ai/docs/overview?from=social_techpedia) turns this thinking into a product: in [memory management](https://lightvela.ai/docs/configuration/memory?from=social_techpedia), everything the agent remembers about you is transparent, viewable, correctable, and deletable — no config files to edit by hand. The [Skill system](https://lightvela.ai/docs/configuration/skill?from=social_techpedia) carries the other leg: how to actually do things.

To get started quickly, the [quickstart](https://lightvela.ai/docs/quickstart?from=social_techpedia) is the place to begin.

## Join LightVela's Community for More Updates!

**Visit us at [LightVela](https://lightvela.ai/?from=social_techpedia)**

**Discord** — scan the QR code to join our Discord community and connect with builders for the latest updates.

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** — scan the QR code to join our WhatsApp group, try LightVela, and chat with us directly.

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
