# Configure Channel - WeChat

The WeChat channel uses QR-code access and is the simplest channel to configure.

## This page covers

- Generating a WeChat access QR code in LightVela
    
- Scanning the QR code with WeChat on your phone
    
- Chatting with Hermes in WeChat
    

> 💡 **Prerequisites**
> 
> -   A phone with WeChat installed
>     
> -   Complete [model configuration](./configuration/model.md) (or use the 100 trial credits included in the Launch plan)
>     

---

## Steps

### 1. Enter the console

Sign in to LightVela, click "My Hermes" in the upper-right corner to enter the console, and find the "Channel" button.

### 2. Select the WeChat channel

Click the dropdown and select "WeChat". The WeChat channel introduction and "View Details" link appear below.

### 3. Click "Authorize Access"

A QR code appears on the page.

![](../images/20260424-142558-0pl3.webp)

> ⚠️ **QR code expiration**
> 
> The QR code expires after a few minutes. If it expires, close the dialog and click "Authorize Access" again to generate a new QR code.

### 4. Scan with WeChat on your phone

1. Open WeChat on your phone
    
2. Tap "+" in the upper-right corner → "Scan"
    
3. Scan the QR code on your computer screen
    
4. Follow the prompts on your phone to complete authorization
    

### 5. Find Hermes in WeChat

After scanning succeeds:

- The dialog closes automatically, and a "WeChat" record is added to the "Connected channels" list in the console
    
- WeChat automatically adds the bot account
    

Open the chat with that bot and send a test message:

```
Hi
```

You should receive a Hermes reply within a few seconds.

![](../images/6.1-2.webp)

---

## Success state

- The "Connected channels" list in the console contains "WeChat"
    
- The corresponding bot can be found in WeChat contacts
    
- Hermes replies after you send a message
    

---

## Supported message types

After access succeeds, the WeChat bot can receive and reply to basic text messages and supports more message types as follows:

| Message type supported by WeChat bot | Supported |
|---|---|
| Receive text messages | ✅ Supported |
| Receive images and videos | ✅ Supported |
| Receive files | ✅ Supported |
| Receive voice messages | ✅ Supported |
| Reply with text messages | ✅ Supported |
| Reply with images and videos | ✅ Supported |
| Reply with files | ✅ Supported |
| Proactively send messages (such as scheduled reminders) | ✅ Supported |

> ℹ️ **Actual processing capability depends on the model**
> 
> The table above only indicates the message types supported by the WeChat bot at the channel layer. Whether images, files, and other tasks can actually be processed also depends on whether the large language model connected to Hermes has the corresponding capabilities.

---

## FAQ

| Issue | Possible cause | Solution |
|---|---|---|
| WeChat shows "invalid QR code" after scanning | The QR code has expired | Close the dialog and click "Authorize Access" again |
| No response on the computer after scanning | Network delay or authorization not completed | Refresh the console to confirm status; if access did not succeed, try again |
| Cannot find the bot contact in WeChat | The message is folded into "Service Notifications" | Search "LightVela" or the Hermes name at the top of WeChat |
| No reply after sending a message | Model is not configured or trial credits are exhausted | Check the "Current model" status in the "1. Model" card |
| How to unlink | — | Delete the corresponding record in the "Connected channels" list |
| Can the same WeChat account connect to multiple Hermes instances | Launch plan limit is 1 Hermes | Not applicable |

---

## Channel notes

- **Message types**: Supports text, images, videos, files, voice messages, and more. See "Supported message types" above
    
- **Group chat support**: Group chats are not currently supported; only 1-to-1 conversations are supported
    
- **Connection interruption**: Long periods of no response may indicate authorization was revoked. Return to the console and authorize access again
    

---

## Next steps

- [Configure Channel - Telegram](./configuration/channel-telegram.md) — Lightweight notifications and cross-platform communication

- [Configure Channel - WhatsApp](./configuration/channel-whatsapp.md) — International user communication and customer service

- [Configure Channel - Discord](./configuration/channel-discord.md) — Community operations and developer communities

- [Configure Skills](./configuration/skill.md) — Extend Hermes capabilities
