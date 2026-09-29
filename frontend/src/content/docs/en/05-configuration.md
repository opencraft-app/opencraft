# Configuration Overview

## Summary

**The Agent console separates Channels, Models, Skills, and Scheduled Tasks into pages in its sidebar. Select the intended Bot before changing its settings. Connect a messaging channel from its card, choose a model or use plan credits, and install Skills from Skills.sh or ClawHub when needed. Soul, Memory, Diagnostics, Advanced Settings, and Labs are available in separate sections. Cloud Storage opens from the user menu.**

---

The Agent console organizes everyday setup in sidebar pages for **Channels**, **Models**, **Skills**, and **Scheduled Tasks**. Select the Bot you intend to configure, then open the relevant page. This guide shows where to start and how to verify the result.

## This page covers

- How to enter the console

- Bot switcher and selected Bot information

- Where to find Channels, Models, Skills, and Cloud Storage

- Success state after configuration

- Common operations such as managing Bots, switching models, and connecting multiple channels

---

## Enter the console

After signing in, open the [Agent console](/agents/overview/). Choose the Hermes Agent and Bot you want to configure.

---

## Bots and selected Bot information

The top of the console contains Bot tabs for the current Hermes Agent. The first tab is the main Bot; each additional tab is a separate Bot profile. Your plan determines the total Bot limit, including the main Bot. During the staged international rollout, the creation entry is not shown by default. See [Manage Bots](./configuration/bots.md) for creation methods and inheritance rules.

After selecting a Bot, its basic information is shown below:

- Avatar

- Name (click the name or pencil icon to edit, then press Enter to save)

- Status (● Running / ● Unknown)

- Creation time

- Delete button (trash icon on the right)

> ⚠️ **Deletion is irreversible**
>
> Deleting an additional Bot permanently removes that Bot's profile and data. Deleting the main Bot deletes the entire Hermes Agent and all related data, and is allowed only after the other Bots have been deleted.

---

## Configure channels, models, and skills

### Channels

Open **Channels** in the Agent sidebar. The page shows separate cards for Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, and Lark. Select **+ Connect** on the channel you want and follow its guide. WhatsApp, WeChat, WeCom, and Lark use QR-code authorization; Telegram, Discord, and Slack use credentials. QQ offers QR code or App ID / Secret connection. See the [WhatsApp guide](./configuration/channel-whatsapp.md) for a QR-code example.

### Models

Open **Models** to review the active model or configure a provider. Plan model credits can be used without entering your own API key; you may add a provider when needed. A Bot uses one primary model at a time, and separately configured fallback models may be available. See [Configure Models](./configuration/model.md) and [Model Switching](./configuration/multiple-models.md).

### Skills

Open **Skills** to search individual skills or browse **Skill Packages** from [Skills.sh](https://skills.sh/) and [ClawHub](https://clawhub.ai/). Select **Install**, then verify the result in **Installed**. See [Configure Skills](./configuration/skill.md).

## Success state after configuration

After configuration is complete, the console should show the following state:

- The "Connected channels" list has at least one record (such as "WeChat")

- "Current model" is optional; no configuration is required if you use Launch trial credits

- "Installed skills" can be configured as needed and may be empty

Once "Connected channels" has at least one record, you can find the bot in the corresponding messaging platform and start a conversation. Hermes Agent will generate replies using the default model or Launch trial credits.

---

## Common operations

- **Switch models:** Open **Models** for the selected Bot and choose an available configured model. The Bot's memory is retained; see [Model Switching](./configuration/multiple-models.md).
- **Connect multiple channels:** Open **Channels** and use **+ Connect** on each required card. Channels connected to the same Bot share that Bot's persona and memory.
- **Manage Bots:** Select a Bot tab before changing settings. When creation is available, follow [Manage Bots](./configuration/bots.md) for copying and deletion rules.
- **Open Cloud Storage:** Use **Cloud Storage** in the user menu rather than looking for it in the Agent sidebar.

---

## Next steps

Detailed configuration for each module:

- [Manage Bots](./configuration/bots.md) — Create, copy, switch, rename, and delete Bots

- [Configure Models](./configuration/model.md) — Model sources, API Key acquisition, and selection guidance

- [Configure Channel - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [WeCom](./configuration/channel-wecom.md) / [Lark](./configuration/channel-feishu.md)

- [Configure Skills](./configuration/skill.md) — Skills.sh / ClawHub usage and skill installation

Related references:

- [Core Concepts](./04-core-concepts.md)

- [Quickstart](./02-quickstart.md)
