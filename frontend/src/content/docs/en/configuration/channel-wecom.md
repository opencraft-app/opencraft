# Configure Channel - WeCom

## Summary

**The WeCom channel connects by QR code and is, alongside WeChat, the simplest to set up — a good fit for using Hermes Agent in a corporate workplace: pick WeCom in the console Channels section, click to authorize and generate a QR code, then scan it with WeCom on your phone to start talking. You need a phone with WeCom installed and a configured model (or simply the monthly model credits included with your plan). One agent can be connected to several channels at once, sharing the same persona and long-term memory.**

---

The WeCom channel uses QR-code access and is the simplest channel to configure.

## This page covers

- Generating a WeCom access QR code in LightVela

- Scanning the QR code with WeCom on your phone

- Chatting with Hermes Agent in WeCom


> 💡 **Prerequisites**
>
> -   A phone with WeCom installed
>
> -   Complete [model configuration](./model.md) (or use the 100 trial credits included in the Launch plan)
>

---

## Steps

### 1. Enter the console

Sign in to LightVela, click "My Hermes" in the upper-right corner to enter the console, and find the "Channel" button.

### 2. Select the WeCom channel

Find the WeCom module and click "+ Connect".

### 3. Click "Authorize Access"

A QR code appears on the page.

![](../images/wecom1-en.webp)

> ⚠️ **QR code expiration**
>
> The QR code expires after a few minutes. If it expires, close the dialog and click "Authorize Access" again to generate a new QR code.

### 4. Scan with WeCom on your phone

1. Open WeCom on your phone

2. Tap "+" in the upper-right corner → "Scan"

3. Scan the QR code on your computer screen


![](../images/wecom2.webp)

4. Follow the prompts on your phone to complete authorization

![](../images/wecom3.webp)

![](../images/wecom4.webp)

### 5. Chat with the created bot

After a successful scan:

- The dialog closes automatically and you'll be taken to the created bot page

- WeCom automatically adds the bot to your contacts


Open the bot's chat window and send a test message:

```
Hello
```

You'll receive a Hermes Agent reply within seconds.

![](../images/wecom5-en.webp)

---

## Success state

- A "WeCom" entry appears in the console's "Connected Channels" list

- The bot can be found in your WeCom contacts

- Sending a message receives a Hermes Agent reply


---

## Supported message types

After integration, the WeCom bot supports more than basic text. The full list:

| WeCom bot — supported message types | Supported |
| --- | --- |
| Receive text messages | ✅ Yes |
| Receive images / video | ✅ Yes |
| Receive files | ✅ Yes |
| Receive voice messages | ✅ Yes |
| Reply with text messages | ✅ Yes |
| Reply with images / video | ✅ Yes |
| Reply with files | ✅ Yes |
| Send messages proactively (e.g. scheduled reminders) | ✅ Yes |

> ℹ️ **Actual capability depends on the model**
>
> The table above only reflects what the WeCom bot can receive and reply with at the channel layer. Whether tasks such as image / file processing actually work depends on whether the underlying LLM connected to Hermes Agent supports those capabilities.

---

## FAQ

| Symptom | Possible cause | Resolution |
| --- | --- | --- |
| WeCom shows "Invalid QR code" after scanning | The QR code has expired | Close the dialog and click "Authorize Access" again |
| No response on the desktop after scanning | Network delay or authorization not yet completed | Refresh the console page to confirm the status; if not connected, retry |
| Bot contact not found in WeCom | Messages collapsed under "Service Notifications" | Search "LightVela" or your Hermes Agent name from the top of WeCom |
| No reply after sending a message | Model not configured or trial credits exhausted | Check the "Current Model" status on the "1. Model" card |
| How to disconnect | — | Delete the entry from the "Connected Channels" list |
| Can a single WeCom account connect to multiple Hermes Agent instances | The Launch plan caps you at 1 Hermes Agent | Not applicable |

---

## Channel notes

- **Message types**: Text, images, video, files, voice, and more — see "Supported message types" above

- **Group chat support**: Group chat is not supported for now; only 1-on-1 conversations work

- **Connection drops**: Long unresponsive periods usually mean the authorization was revoked — re-authorize from the console


---

## Next steps

- [Configure Channel - Lark](./channel-feishu.md) — Office scenarios with rich text and group chat

- [Configure Skills](./skill.md) — Extend Hermes Agent capabilities
