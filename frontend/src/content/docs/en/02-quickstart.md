# Quickstart

## Summary

**Getting your first LightVela conversation running takes about 5 minutes: sign in to LightVela, activate a plan, let the platform create your Hermes Agent instance, configure a model (or just use the monthly model credits included with your plan), connect one messaging channel, then send a message and get a reply. Everything happens in the browser — no servers to buy, nothing to deploy locally. The fastest path is to use your plan credits together with WeChat, which connects by scanning a QR code, and add your own model API key and more channels later.**

---

This tutorial walks through the full process from signing in to receiving a Hermes reply in WeChat. Allow extra time for plan checkout and Agent provisioning.

## This page covers

- Signing in to LightVela

- Activating a Launch option and opening your Hermes instance

- Connecting Telegram / WhatsApp / Discord / Slack / WeChat channels

- Sending a message in WeChat and receiving a reply

> 💡 **Prerequisites**
>
> - A Google or GitHub account
>
> The Launch plan includes 100 trial credits, so you can start chatting without preparing a large language model API Key in advance.

---

## 1. Sign in to LightVela

Visit [lightvela.ai](https://lightvela.ai) and click "Log in" in the upper-right corner. In the login dialog, choose Google or GitHub, accept the agreements, and complete authorization.

![](./images/2-1.webp)

---

## 2. Activate the Launch plan

Open the [Subscribe page](/subscribe), choose the **100-credit Launch** option in the Launch series, and follow the plan card through checkout. Check the displayed price and first-order offer before confirming.

> ⚠️ **New-user introductory offers**
>
> Eligible new users can try Launch for 1 month. Check the [Subscribe page](/subscribe/) for current terms and availability.

---

## 3. Open your Hermes Agent

After plan activation, open the [Agent console](/agents/overview/). LightVela provisions the cloud instance for your plan. If the console asks you to create the Agent, follow that on-screen step and wait until its status is **Running**. The sidebar then provides **Channels**, **Models**, **Skills**, and **Scheduled Tasks**. You can use plan model credits without entering your own API key.

---

## 4. Connect WeChat

Open **Channels** in the Agent sidebar. On the **WeChat** card, select **+ Connect** and follow the QR-code instructions. Scan the code with WeChat on your phone and finish authorization there. Confirm that WeChat appears as connected in the console before sending a message. See [Configure Channel - WeChat](./configuration/channel-wechat.md) if the code expires or connection fails.

---

## 5. Send your first message

Find the added bot account in WeChat and send a test message:

```
Hi
```

![](./images/2-7.webp)

You should receive a reply from Hermes within a few seconds. Hermes can now chat through WeChat.

> 💡 **Message billing**
>
> By default, model calls use the 100 credits included in the Launch option. If they run out, you can buy an eligible [credit pack](./credits.md) or configure your own API key in **Models**.

---

## Advanced: configure your own model (optional)

If you need a specific provider, open **Models** in the Agent sidebar, choose the provider and model, add its API key, and set a primary model. See [Configure Models](./configuration/model.md).

---

## FAQ

| Issue | What to check | Next step |
|---|---|---|
| The Launch option cannot be activated | Current availability, eligibility, or checkout status | Recheck the [Subscribe page](/subscribe) and the final checkout message; avoid repeating a completed order. |
| Agent setup takes longer than expected | Whether the console still shows provisioning or an error | Refresh the Agent overview once; if the state does not change, use [Diagnostics](./configuration/diagnostics.md) or contact support. |
| The WeChat QR code expires | Whether authorization completed on the phone | Reopen **Channels** and start a new connection attempt. |
| A message gets no reply | Channel connection, Agent status, and model credits | Check **Channels** and **Diagnostics**. If credits are exhausted, review [credit options](./credits.md). |
---

## Next steps

- [Core Concepts](./04-core-concepts.md) — Understand the five core concepts: Hermes Agent, Bots, models, channels, and skills

- [Configuration Overview](./05-configuration.md) — Overall console structure

- [Configure Skills](./configuration/skill.md) — Install Skills from Skills.sh or ClawHub
