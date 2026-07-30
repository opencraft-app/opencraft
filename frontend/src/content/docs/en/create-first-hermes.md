# How Do I Activate My First Hermes Instance?

A Hermes instance is the cloud runtime where your LightVela Agent lives. Activating your first instance follows five steps: **sign in with Google or GitHub → select an available plan → activate it through the current beta flow → let LightVela provision the instance → configure a model and channel**. Everything happens in the browser, with no server purchase or local deployment required. This page walks through the process in order.

## What this page covers

- The complete process for activating your first Hermes instance

- Prerequisites and important details for each step

- How to configure and use your Agent after activation

## Prerequisites

- A Google or GitHub account

- A currently available plan selected from the [Subscribe page](/subscribe); the international site does not require China real-name verification

- At least one messaging account you plan to connect, such as Telegram, WhatsApp, Discord, or WeChat

---

## Activation flow

### 1. Sign in with Google or GitHub

Open LightVela and authorize access with Google or GitHub. Your LightVela account is created automatically the first time you sign in, so there is no separate password to set. Continue using the same sign-in identity on future visits to access the same Hermes instances and data.

### 2. Select an available plan on the Subscribe page

Open the [Subscribe page](/subscribe) to see which plans and quotas are currently available. [Plans](./plans.md) describes the Launch, Cruise, and Voyage resource structure, but the Subscribe page is authoritative for what can be activated now.

There is no China real-name verification step on the international site. After signing in with Google or GitHub, you can select any currently available plan.

### 3. Activate the plan through the current international beta flow

The international service is currently in beta, with **free access available to a limited number of users for a limited time**. Follow the prompt on the plan card to activate it. Quotas, available tiers, and future pricing may change, so refer to the Subscribe page for current information.

### 4. Let LightVela provision the instance automatically

After the plan is activated, LightVela **automatically assigns a dedicated cloud environment and creates your first Hermes instance**. You do not need to buy, deploy, or configure a server. Provisioning normally begins immediately, and you can open the console when the instance is ready.

### 5. Configure and wake up your Agent

Once the instance is ready, open the console and complete the basic setup:

1. **Configure a model** — Choose the underlying language model; see [Configure Models](./configuration/model.md)

2. **Connect a channel** — Add Telegram, WhatsApp, Discord, WeChat, or another supported channel, then talk to your Agent from the messaging app

3. **Optionally add skills and automations** — Extend what your Agent can do; see [Configure Automations](./configuration/automation.md)

Your first Hermes Agent is now ready to stay online in the cloud 24/7.

---

## FAQ

### How soon can I use the instance after activation?

LightVela starts provisioning the Hermes instance automatically after plan activation. When the instance is ready, configure a model and channel in the console and begin a conversation.

### What happens when the free beta period ends?

Availability, quotas, and future pricing may change as the beta evolves. Check the [Subscribe page](/subscribe) and in-product notices for the latest information before a change takes effect.

### How many Hermes instances can one account activate?

The number depends on the Agent allowance of the selected plan. Launch and Cruise each include one Agent. Voyage is designed for three but is still coming soon. See [Plans](./plans.md).

### Do I need to maintain a server after activation?

No. Your Hermes instance runs in a LightVela-managed cloud environment. LightVela handles operations and 24/7 availability; you only configure the Agent through the web console.

---

## Next steps

- [Quickstart](./02-quickstart.md) — Follow the complete onboarding flow

- [Plans](./plans.md) — Compare the available plan structure

- [Core Concepts](./04-core-concepts.md) — Understand Hermes, models, channels, and skills

- [Configure Models](./configuration/model.md) — Choose the underlying model for your Agent
