# Configure Channel - Telegram

## Summary

**The Telegram channel connects with a bot token, making it a quick way to bring your Hermes Agent into Telegram direct messages or groups: create a bot through BotFather in Telegram, copy its bot token, and paste it into the Channels section of the LightVela console. You need a Telegram account and a configured model (or simply the monthly model credits included with your plan). The bot token is a sensitive credential — never share it publicly. Once connected, the agent in Telegram shares the same persona and long-term memory as your other channels.**

---

The Telegram channel uses Bot Token access and is suitable for quickly connecting Hermes Agent to Telegram private chats or groups.

## This page covers

- Authorizing access by scanning a code or opening a link in Telegram on your phone

- Chatting with Hermes Agent in Telegram


> 💡 **Prerequisites**
>
> -   A phone with Telegram installed
>
> -   Complete [model configuration](./model.md) (or use the 100 trial credits included in the Launch plan)
>

---

## Steps

### 1. Enter the console

Sign in to LightVela, click "My Hermes" in the upper-right corner to enter the console, and find the "Channel" button.

### 2. Select the Telegram channel

Find the Telegram card and click "+ Connect".

### 3. Open Telegram

1. Open the Telegram app on your phone

2. Search for @BotFather and open the chat

<img src="../images/telegram-botfather-2-global.webp" alt="" width="360" />

3. Send `/start`

4. Send `/newbot`

5. Enter a name for your agent: the username must be unique and end with "bot"

6. Copy the HTTP API token:

![](../images/telegram-botfather-3-global.webp)


### 4. Paste the HTTP API token into Telegram

Paste the HTTP API token into the token field.

<img src="../images/telegram-botfather-4-global.webp" alt="" width="360" />

> ⚠️ **Keep your token safe**
>
> Store the token securely. Anyone who obtains the token can take control of your bot!

### 5. Chat with the new bot in Telegram

Click the link provided by BotFather and start interacting with the bot.

![](../images/telegram-botfather-5-global.webp)

Open the chat with the bot and send a test message:

```
Hi
```

You should receive a Hermes Agent reply within a few seconds.

<img src="../images/telegram-botfather-6-global-en.webp" alt="" width="360" />

### 6. Optional: Enable group messages in BotFather

Only complete steps 6 and 7 if you want to use the bot in a group.
Direct messages are already available after step 5.

1. Open `@BotFather` in Telegram.
2. Send `/mybots`.
3. Select the Bot that is connected to your Hermes Agent.
4. Open "Bot Settings".
5. Select "Group Privacy".
6. Choose "Turn off" or "Disable privacy mode".

### 7. Optional: Add and test the Bot in a group

1. Open the Telegram group you want to use.
2. Choose "Add Members" or the equivalent group-management action.
3. Search for the Bot by its username and add it to the group.
4. Mention it with `@bot_username` and send a test message.

After Group Privacy is disabled, the bot can receive and reply to group messages that mention it.

---

## Success state

- The "Connected channels" list in the console contains "Telegram"

- The corresponding bot can be found in Telegram contacts

- Hermes Agent replies after you send a message

- Hermes Agent replies after you mention the bot and send a message in a group where it has been added


---

## Supported message types

After access succeeds, the Telegram bot can receive and reply to basic text messages and supports more message types as follows:

| Message type supported by Telegram bot | Supported |
|---|---|
| Receive text messages | ✅ Supported |
| Receive images and videos | ✅ Supported |
| Receive files | ✅ Supported |
| Reply with text messages | ✅ Supported |
| Reply with images and videos | ✅ Supported |
| Reply with files | ✅ Supported |
| Proactively send messages (such as scheduled reminders) | ✅ Supported |

> ℹ️ **Actual processing capability depends on the model**
>
> The table above only indicates the message types supported by the Telegram bot at the channel layer. Whether images, files, and other tasks can actually be processed also depends on whether the large language model connected to Hermes Agent has the corresponding capabilities.

---

## FAQ

| Issue | Possible cause | Solution |
|---|---|---|
| BotFather cannot create a bot | The bot name or username does not meet Telegram's requirements | The display name can be anything, but the username must end with `bot`, e.g. `my_hermes_bot` |
| BotFather did not return an HTTP API token | The creation flow was not completed | Return to the BotFather chat, run `/newbot` again, and follow the prompts to set the name and username |
| Token shows as invalid after pasting | The token is incomplete or contains extra spaces / line breaks | Re-copy the full HTTP API token from BotFather and paste it into the token field |
| No response after clicking access | Network delay or authorization not completed | Refresh the console to confirm status; if access did not succeed, try again |
| Cannot find the bot in Telegram | You did not click the link provided by BotFather, or did not start the chat | Click the link provided by BotFather, then click Start on the bot page |
| No reply after sending a message | Model is not configured, trial credits are exhausted, or the bot has not been connected successfully | Check the "Current model" status in the "1. Model" card and confirm the Telegram channel shows as connected |
| Bot cannot receive group messages | Group Privacy is still enabled, the bot has not been added to the group, or the message does not mention it | In BotFather, send `/mybots`, select the bot, then open "Bot Settings" → "Group Privacy" and turn privacy mode off. Add the bot to the group and send a test message with `@bot_username` |
| How to unlink | — | Delete the corresponding Telegram record in the "Connected channels" list |
| Can the same Telegram bot connect to multiple Hermes Agent instances | Not recommended; one Bot Token should be bound to one Hermes Agent | If you need multiple Hermes Agent instances, create separate Telegram bots |

---

## Channel notes

- **Message types**: Supports text, images, videos, files, voice messages, and more. See "Supported message types" above

- **Group chat support**: Group messages are supported after you disable Group Privacy in BotFather, add the bot to the group, and start the conversation with `@bot_username`

- **Connection interruption**: Long periods of no response may indicate authorization was revoked. Return to the console and authorize access again

---

## Next steps

- [Configure Channel - WhatsApp](./channel-whatsapp.md) — International user communication and customer service

- [Configure Channel - Discord](./channel-discord.md) — Community operations and developer communities

- [Configure Channel - Slack](./channel-slack.md) — Team collaboration, workspace notifications, and channel workflows

- [Configure Channel - QQ](./channel-qq.md) — Bot created manually, integrated via AppID/AppSecret

- [Configure Skills](./skill.md) — Extend Hermes Agent capabilities
