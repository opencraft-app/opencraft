# Credits

## Summary

**Model credits measure usage of model calls, including input and output. Launch, Launch AI, Cruise, and Cruise AI include 100, 4,500, 200, and 10,000 credits per month respectively. Users with an active plan can also buy one-time credit packs; those credits expire one month after delivery and do not auto-renew. Conversations and model-backed Agent tasks consume credits, while Notification and Script Tasks do not call a model. If credits run out, you can buy an eligible pack, wait for the next plan allocation, or configure your own model API key.**

---

Model credits are the units LightVela uses to measure model usage by a Hermes Agent. Each plan includes a monthly credit allocation. Whenever your Agent calls a language model during a conversation or task, credits are deducted according to usage. This page explains what credits are, how they are allocated and consumed, and how they relate to plans.

## What this page covers

- What model credits mean and how they are converted

- How plans allocate credits each month

- How credits are consumed and how they relate to tokens

- How credits relate to plans and models

---

## What are model credits?

Model credits measure calls to a language model. Conversations, model-backed [Agent Tasks](./configuration/automation.md), and Skills that invoke a model use credits; Notification and Script Tasks do not call a model.

The approximate conversion is **1 credit ≈ 10,000 tokens**. A token is a basic unit of text processed by a model. Both input—the content you send to your Agent—and output—the response it generates—count toward usage.

> ℹ️ The exact conversion and measurement rules shown by the platform are authoritative. Cost per token may vary between models.

---

## How credits are allocated

Credits are **allocated monthly with a plan**, and the monthly amount differs by tier:

| Plan | Monthly model credits |
|---|---:|
| Launch | 100 |
| Cruise | 200 |
| Launch AI | 4,500 |
| Cruise AI | 10,000 |

See [Plans](./plans.md) for the corresponding resources and the [Subscribe page](/subscribe) for current availability and pricing.

## Additional credit packs

Users with an active plan can buy a one-time model credit pack on the [Subscribe page](/subscribe#subscribe-credits). Each pack is valid for one month from delivery and does not auto-renew. Credits with earlier expiration dates are used first; when dates match, the older credits are used first. Check the checkout page for the current price and available denominations.

---

## How credits are consumed

Credits are consumed in the following situations because each one requires Hermes to call a language model:

- **Talking to your Agent** — Messaging through Telegram, WhatsApp, Discord, Slack, WeChat, or another supported channel

- **Running Agent Tasks** — Letting your Agent run model-backed [scheduled tasks](./configuration/automation.md)

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

Credits are allocated monthly with a plan. Active subscribers can also buy one-time credit packs. Check the [Subscribe page](/subscribe) for available options and prices.

### How long does one credit last?

One credit is approximately 10,000 tokens. The number of conversation turns this supports depends on the length of each input and output and on the selected model, so there is no fixed conversion to messages. Longer conversations usually consume credits faster.

### Do all models consume credits at the same rate?

No. Models have different per-token costs, so the same task may consume a different number of credits depending on the model. Choose the model that fits your needs under [Configure Models](./configuration/model.md).

### Can I continue after using all my credits?

You can buy an eligible one-time credit pack, wait for the next plan allocation, or configure your own model API key. Model-backed features are limited while no usable credits or key are available.

---

## Next steps

- [Plans](./plans.md) — Compare resources and credit allocations by tier

- [Configure Models](./configuration/model.md) — Choose a more economical or more capable model

- [Activate Your First Hermes Instance](./create-first-hermes.md) — Go from plan activation to a running Agent

- [Core Concepts](./04-core-concepts.md) — Understand Hermes, models, channels, and skills
