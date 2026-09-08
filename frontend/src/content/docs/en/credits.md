# Credits

## Summary

**Model credits are the unit LightVela uses to meter how much your Hermes Agent spends on model calls, counting both input and output. Credits come with your plan on a monthly basis, are not sold separately, and reset each billing cycle: Launch includes 100 credits per month, and Cruise offers a larger allowance. Credits are consumed whenever the agent talks with you, runs a scheduled task, or executes a skill — all of which ultimately call the model — and longer conversations with more context burn through them faster. If you run out mid-cycle, model-dependent features are limited until the next allocation, or you can switch to your own model API key in the model settings and keep going.**

---

Model credits are the units LightVela uses to measure model usage by a Hermes Agent. Each plan includes a monthly credit allocation. Whenever your Agent calls a language model during a conversation or task, credits are deducted according to usage. This page explains what credits are, how they are allocated and consumed, and how they relate to plans.

## What this page covers

- What model credits mean and how they are converted

- How plans allocate credits each month

- How credits are consumed and how they relate to tokens

- How credits relate to plans and models

---

## What are model credits?

Model credits are the **measurement unit** for language-model calls made by a Hermes Agent. Every time your Agent responds in a conversation, runs a [scheduled task](./configuration/automation.md), or uses a skill, it sends requests to the underlying model. The tokens used by those requests are converted into credits.

The approximate conversion is **1 credit ≈ 10,000 tokens**. A token is a basic unit of text processed by a model. Both input—the content you send to your Agent—and output—the response it generates—count toward usage.

> ℹ️ The exact conversion and measurement rules shown by the platform are authoritative. Cost per token may vary between models.

---

## How credits are allocated

Credits are **allocated monthly with a plan**, and the monthly amount differs by tier:

| Plan | Model credits (standard allocation) |
|---|---|
| Launch | 100 credits / month |
| Cruise | 200 credits / month |

Some plans may offer a **higher credit allocation**. Check the plan cards on the [Subscribe page](/subscribe) for currently available options, and see [Plans](./plans.md) for the resource and credit structure of each tier.

---

## How credits are consumed

Credits are consumed in the following situations because each one requires Hermes to call a language model:

- **Talking to your Agent** — Messaging through Telegram, WhatsApp, Discord, Slack, WeChat, or another supported channel

- **Running scheduled tasks** — Letting your Agent execute [scheduled tasks](./configuration/automation.md)

- **Using skills** — Allowing a skill to call a model for reasoning during execution

Usage depends on conversation length and the selected model. Longer content and more context generally use more tokens and therefore more credits. Choosing a more economical model and keeping context focused can reduce usage. See [Configure Models](./configuration/model.md).

---

## How credits relate to plans and models

- **Tied to a plan**: Credits are part of a plan's resources and are allocated on its monthly cycle. Any currently available way to obtain or supplement credits is shown on the [Subscribe page](/subscribe) and governed by the platform's latest rules.

- **Dependent on the model**: Models can have different per-token costs, so the same conversation may consume a different number of credits with a different model.

- **Allocation cycle**: Credits are allocated monthly. Rollover and expiration follow the platform's current rules.

If you use all of the credits for the current period, Agent features that depend on model calls become limited until a new allocation is available or the platform offers another option.

---

## FAQ

### How are credits related to a plan?

Credits are resources included with a plan and allocated monthly. Current availability and any future pricing for different credit options are shown on the [Subscribe page](/subscribe).

### How long does one credit last?

One credit is approximately 10,000 tokens. The number of conversation turns this supports depends on the length of each input and output and on the selected model, so there is no fixed conversion to messages. Longer conversations usually consume credits faster.

### Do all models consume credits at the same rate?

No. Models have different per-token costs, so the same task may consume a different number of credits depending on the model. Choose the model that fits your needs under [Configure Models](./configuration/model.md).

### Can I continue after using all my credits?

Features that require model calls become limited after the allocation is exhausted. When a new allocation becomes available, or whether another option is offered, depends on the platform's current rules.

---

## Next steps

- [Plans](./plans.md) — Compare resources and credit allocations by tier

- [Configure Models](./configuration/model.md) — Choose a more economical or more capable model

- [Activate Your First Hermes Instance](./create-first-hermes.md) — Go from plan activation to a running Agent

- [Core Concepts](./04-core-concepts.md) — Understand Hermes, models, channels, and skills
