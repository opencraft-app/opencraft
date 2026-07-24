# FAQ

This page summarizes common questions when using LightVela. We recommend using `Cmd/Ctrl + F` to search keywords first. If you cannot find an answer, continue checking [Quickstart](./02-quickstart.md), [Configuration Overview](./05-configuration.md), or the FAQ sections in specific configuration pages.

---

## Account and sign-in

### Why are only Google and GitHub login supported?

LightVela mainly serves international users. Google / GitHub one-click login has broad coverage, and phone-number login is not currently planned.

### Can the same user log in once with Google and once with GitHub?

Yes, but they will be two independent accounts. Hermes Agent, conversation memory, and plan status are not shared. We recommend using one login method consistently.

### How to log out

Click the avatar in the upper-right corner and choose "Log out"; or open the account information page and click the logout button in the "Basic account information" card. Account data is retained after logout and can be continued on the next login.

---

## Launch plan and trial credits

### What does the Launch plan include?

For plan contents and quota, see [What is LightVela - About plans](./01-overview.md#about-plans).

### What do "100 trial credits" mean?

They are the model calling quota included in the Launch plan. You can use Hermes Agent without preparing your own API Key—the conversations started after creating Hermes Agent and connecting a channel consume this quota.

### What happens after credits run out?

After credits run out, messages cannot receive model responses. Configure your own API Key in the "Model" card. See [Configure Models](./configuration/model.md).

### Can credits be topped up?

Standalone credit top-up is not currently supported. To continue using Hermes Agent, configure your own API Key.

### Is the Launch plan free forever?

It is currently free for a limited time. Policy changes will be announced in advance.

### Can one account create only 1 Hermes Agent?

The Launch plan is limited to 1 Hermes Agent. Cruise and Voyage plans are coming soon.

### When will Cruise / Voyage be available?

The exact schedule is subject to official updates.

---

## Models

### How to obtain an API Key

After selecting a provider in the console "Model" card, the "Get API KEY" link appears below. Click it to open the provider website registration and Key management page. See [Configure Models](./configuration/model.md).

### How to choose a model

See [Configure Models - Selection guidance](./configuration/model.md#selection-guidance).

### Can I use Chinese models such as Deepseek / Kimi?

Yes. Connect them through "Custom Model" and prepare an accessible Deepseek-compatible endpoint yourself.

### How to troubleshoot when Hermes Agent does not respond after sending a message

Check in the following order:

1. Whether the console "Connected channels" list has a record

2. If using your own model: whether "Current model" has a record and whether the provider balance is sufficient

3. If using trial credits: whether credits are exhausted

4. Whether the Key has been disabled in the provider console

### Will switching models lose conversation memory?

No. Conversation memory is Hermes Agent data. The model is only responsible for generating responses.

### Can multiple models be configured at the same time?

Not in the current version. Each Hermes Agent can have only one active model. To compare different model performance, you need multiple Hermes Agent instances (the Launch plan supports only 1).

---

## Channels

### Can WeChat, Telegram, WhatsApp, and Discord be connected at the same time?

Yes. Multiple channels point to the same Hermes Agent instance and share memory and Agent behavior.

### Can the bot be added to a WeChat group?

Not currently. The WeChat channel supports only 1-to-1 conversations.

### What happens after changing phone or Google / GitHub account?

Accounts are identified by Google / GitHub OpenID. Changing accounts is treated as a new account, and data is not migrated. To keep your data, continue signing in with the original account.

### How to unlink a connected channel

Delete the corresponding item in the console "Connected channels" list. After unlinking, the bot in that messaging platform becomes invalid.

---

## Conversations and memory

### Can a single message be deleted?

Not currently. To clear memory, delete the entire Hermes Agent instance.

### Can Hermes Agent be restored after deletion?

No. Deletion is irreversible. Conversations, channel bindings, and installed skills are all cleared.

---

## Skills

### Do skills require trigger words after installation?

No. Describe your needs in natural language, and Hermes Agent automatically determines whether to call a skill.

### How to uninstall a skill

The LightVela console does not currently support panel-based uninstall. You can ask Hermes Agent through conversation to delete it. See [Configure Skills - Delete installed skills](./configuration/skill.md#delete-installed-skills).

### Are skills charged separately?

It depends on the skill author. Most skills listed on SkillHub are free, while some may call external paid services (consuming your own API quota). See the skill details page.

### Can I develop and publish skills myself?

Developer publishing capabilities are planned. Currently, only listed skills can be used.

---

## Troubleshooting

### Hermes Agent creation stays on the transition page for a long time

This may be caused by slow cloud initialization or network instability. Recommended actions:

1. Wait for 1 minute

2. If there is still no response, refresh the page

3. If there is still no response, click "+ Create Hermes Agent" again

### No response in the console after scanning

Authorization may not have completed or there may be network delay. Close the dialog and click "Authorize Access" again to generate a new QR code.

### Troubleshooting order when the bot has no response at all

| Check item | Method |
|---|---|
| Channel status | Whether the "Connected channels" list still contains the channel |
| Trial credits | Whether credits are exhausted |
| Model status (if using your own model) | Whether "Current model" has a record |
| Key status (if using your own model) | Confirm balance and Key status in the provider console |
| Network | Whether the browser can open LightVela normally |

### Reply content is garbled or meaningless

In most cases, the custom model endpoint is not compatible with the OpenAI protocol. Verify the endpoint with another OpenAI-compatible client first.

### "Model response timeout"

Provider rate limiting or network instability. Try again later or switch to another provider.

### How to recreate Hermes Agent

Delete the current Hermes Agent and click "+ Create Hermes Agent" again. All data will be cleared.

---

## Migration and compatibility

### Can data be exported?

The console does not currently provide data export.

### Can I sign in on multiple devices?

Yes. After signing in with the same account on any device, you can access the same data.

---

## Other

### Questions not covered in this documentation

We recommend using `Cmd/Ctrl + F` first. If you still cannot find an answer, provide feedback through official channels (the specific entry is subject to the official website).
