# Configure Channel - Slack

## Summary

**The Slack channel connects with a bot token and an app token, which suits bringing your Hermes Agent into team channels, direct messages, and automated task notifications: create an app in the Slack app management console, configure its permissions, obtain both tokens, and paste them into the Channels section of the LightVela console. You need a Slack workspace where you can install apps and a configured model (or simply the monthly model credits included with your plan). Both tokens are sensitive credentials — never share them publicly. Once connected, the agent in Slack shares the same persona and long-term memory as your other channels.**

---

Slack uses a Bot Token and an App Token to connect Hermes Agent to team channels, direct messages, and automated task notifications.

## This page covers

- Creating a Slack app and configuring Socket Mode, permissions, and events

- Binding the Slack Bot Token and App Token in LightVela

- Chatting with Hermes Agent through Slack channels and direct messages

> 💡 **Before you start**
>
> - You have a Hermes Agent with a working model configured in [Configure Models](./model.md)
>
> - You have a Slack workspace and permission to create and install apps
>
> - If app installation requires administrator approval, contact your workspace administrator
>
> - Prepare a secure place to temporarily store both tokens
>
> Bot Tokens and App Tokens are sensitive credentials. If a token is exposed, revoke it in Slack and generate a replacement.

---

## Steps

### 1. Open the Slack channel settings in LightVela

Sign in to the LightVela international site, open **My Hermes → Channel**, find the **Slack** card, and click **+ Connect**. You will return with two credentials:

- **Slack Bot Token**: starts with `xoxb-`.
- **Slack App Token**: starts with `xapp-`.

### 2. Create a Slack app

1. Open [Slack API Apps](https://api.slack.com/apps) and sign in.
2. Click **Create New App**.

![Create a new app from Slack API Apps](../images/slack-create-app.png)

3. Select **From scratch**.

![Select From scratch to create the Slack app](../images/slack-create-from-scratch.png)

4. Enter an app name such as `Hermes Agent`.
5. Select the workspace where Hermes Agent should run, then click **Create App**.

![Name the Slack app and select a workspace](../images/slack-select-workspace.png)

If the workspace is missing, verify that the current Slack account belongs to it and can create apps.

### 3. Create the App Token

The App Token establishes the Socket Mode WebSocket connection. It must include the `connections:write` scope.

1. In the Slack app sidebar, open **Settings → Basic Information**.

![Open Basic Information in the Slack app](../images/slack-basic-information.png)

2. Scroll to **App-Level Tokens** and click **Generate Token and Scopes**.

![Generate an app-level token](../images/slack-generate-app-token.png)

3. Enter a recognizable token name, such as `HermesSocket`.
4. Click **Add Scope**.

![Add a scope to the App Token](../images/slack-add-connection-scope.png)

5. Search for and select `connections:write`.

![Select the connections write scope](../images/slack-select-connections-write.png)

6. Confirm the scope is listed, then click **Generate**.

![Generate the App Token with connections write](../images/slack-generate-token.png)

7. Copy the generated `xapp-...` token and store it securely. Click **Done** after copying it.

![Copy the Slack App Token](../images/slack-copy-app-token.png)

Do not paste the App Token into the Bot Token field. A Client Secret or Signing Secret is not a replacement for this token.

### 4. Configure Socket Mode, permissions, and events

#### 4.1 Enable Socket Mode

1. Open **Settings → Socket Mode**.
2. Turn on **Enable Socket Mode**.

![Enable Slack Socket Mode](../images/slack-enable-socket-mode.png)

Socket Mode sends Slack events to Hermes Agent over WebSocket. This setup does not require an Event Subscriptions Request URL or an OAuth Redirect URL.

#### 4.2 Add Bot Token Scopes

1. Open **Features → OAuth & Permissions**.
2. Scroll to **Scopes → Bot Token Scopes**.
3. Click **Add an OAuth Scope**.

![Add a bot scope in OAuth and Permissions](../images/slack-add-oauth-scope.png)

Add scopes for the interaction modes you need:

| Scope | Required for | Purpose |
|---|---|---|
| `app_mentions:read` | Channel use | Receive messages that mention the bot |
| `channels:read` | Public channels | Read basic public-channel information |
| `channels:history` | Public channels | Read messages in public channels the bot has joined |
| `chat:write` | All replies | Send messages as the bot |
| `im:read` | Direct messages | Read direct-message conversation information |
| `im:history` | Direct messages | Read direct messages sent to the bot |
| `im:write` | Direct messages | Open or manage direct-message conversations |
| `groups:read` | Optional private channels | Read private-channel information |
| `groups:history` | Optional private channels | Read messages in private channels the bot has joined |

![Review the Slack Bot Token Scopes](../images/slack-bot-token-scopes.png)

Only add the two `groups:*` scopes when private-channel access is required. The app must still be invited to each target channel.

#### 4.3 Enable direct messages in App Home

If users should be able to message Hermes Agent directly:

1. Open **Features → App Home**.
2. Scroll to **Show Tabs**.
3. Enable **Messages Tab**.
4. Enable the option that allows users to send messages from the Messages tab.

If you only use channel mentions, you can skip this section and omit the `im:*` scopes and `message.im` event.

#### 4.4 Subscribe to bot events

1. Open **Features → Event Subscriptions**.
2. Turn on **Enable Events**.
3. Under **Subscribe to bot events**, click **Add Bot User Event**.
4. Add `app_mention` for channel mentions.
5. Add `message.im` if direct messages are enabled.
6. Click **Save Changes**.

![Configure Slack bot event subscriptions](../images/slack-event-subscriptions.png)

> If you change scopes or events after installation, return to **OAuth & Permissions** and click **Reinstall to Workspace**. New permissions do not take effect until the app is reinstalled.

### 5. Install the app and copy the Bot Token

1. Return to **Features → OAuth & Permissions**.
2. Click **Install to Workspace**. If the app is already installed, click **Reinstall to Workspace**.

![Install the Slack app to the workspace](../images/slack-install-workspace.png)

3. Review the requested permissions and click **Allow**.

![Authorize the Slack app permissions](../images/slack-authorize-workspace.png)

4. After Slack returns to **OAuth & Permissions**, find **OAuth Tokens for Your Workspace**.
5. Copy the **Bot User OAuth Token** that starts with `xoxb-`.

![Copy the Slack Bot User OAuth Token](../images/slack-copy-bot-token.png)

Do not use a Signing Secret, Client Secret, Verification Token, or an `xoxp-...` User OAuth Token. LightVela requires one `xapp-...` App Token and one `xoxb-...` Bot Token.

### 6. Bind Slack in LightVela

1. Return to **My Hermes → Channel → Slack**.
2. Paste the `xoxb-...` token into **Slack Bot Token**.
3. Paste the `xapp-...` token into **Slack App Token**.
4. Confirm that the tokens are in the correct fields, then submit the connection.
5. Wait for the Slack card to show as connected.

### 7. Test Hermes Agent in Slack

#### 7.1 Test a channel mention

1. Open the Slack channel where you want to use Hermes Agent.
2. Invite the app:

```text
/invite @Hermes Agent
```

3. Send a message that mentions the bot:

```text
@Hermes Agent Summarize the key points discussed in this channel today.
```

The bot only receives channel messages after it has joined that channel.

#### 7.2 Test a direct message

1. Open the new app from the **Apps** section in Slack.
2. Select the **Messages** tab.
3. Send a short message such as `Hello`.

![Test a direct message in Slack App Home](../images/slack-direct-message-test.png)

---

## Success state

The setup is complete when all applicable checks pass:

- The Slack card in LightVela shows as connected.
- The Slack app is installed in the target workspace.
- Hermes Agent replies to a mention in a channel the app has joined.
- When App Home and IM permissions are enabled, Hermes Agent replies to a direct message.

---

## Supported message types

After Slack is connected, the channel supports these messaging scenarios:

| Slack message type | Supported |
|---|---|
| Receive text mentions in channels | ✅ Supported |
| Receive direct-message text in App Home | ✅ Supported |
| Reply with text in channels and direct messages | ✅ Supported |
| Send proactive messages, such as automated task notifications | ✅ Supported |

> ℹ️ **Actual task handling depends on the model**
>
> This table describes Slack channel-level messaging support. Summarization, translation, and other tasks still depend on the configured model and installed skills.

---

## FAQ

| Issue | Possible cause | Resolution |
|---|---|---|
| App Token is rejected | Wrong token type or missing `connections:write` | Generate a new `xapp-...` token under **Basic Information → App-Level Tokens** |
| Bot Token is rejected | A User OAuth Token or another credential was copied | Copy the `xoxb-...` Bot User OAuth Token from **OAuth & Permissions** |
| Event Subscriptions asks for a Request URL | Socket Mode is disabled | Enable **Settings → Socket Mode**, then return to Event Subscriptions |
| Channel mentions are not received | App is not in the channel, scopes are missing, or `app_mention` is absent | Invite the app, add channel scopes and `app_mention`, then reinstall the app |
| Direct messages are not received | Messages Tab is disabled, IM scopes are missing, or `message.im` is absent | Enable Messages Tab, add `im:*` and `message.im`, then reinstall the app |
| New permissions do not work | App was not reinstalled after a change | Click **Reinstall to Workspace** under **OAuth & Permissions** |
| The channel is connected but there is no reply | Model unavailable, insufficient credits, or Agent status issue | Check [Configure Models](./model.md), instance status, and available credits |

---

## Next steps

- [Configure Channel - Telegram](./channel-telegram.md) — Personal conversations and group notifications

- [Configure Channel - WhatsApp](./channel-whatsapp.md) — International user communication and customer service

- [Configure Channel - Discord](./channel-discord.md) — Community operations and developer communities

- [Configure Automations](./automation.md) — Send scheduled reminders and task results to Slack

- [Configure Skills](./skill.md) — Extend Hermes Agent capabilities
