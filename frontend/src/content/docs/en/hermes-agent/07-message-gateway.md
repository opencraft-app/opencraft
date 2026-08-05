## Summary

**One agent can appear in several messaging apps because channels are entry points, while the agent is the durable worker.**
A message gateway receives platform-specific messages from Telegram, WhatsApp, Discord, and more, routes them to the same agent, then delivers the result back to the right conversation.
Persona, memory, Skills, and automations do not need to be copied per platform.

---

## Why can the conversation continue in another app?

Moving from Telegram to WhatsApp should not feel like meeting a new bot.
The hard part is not connecting several APIs.
It is making every entry point resolve to the same agent identity and working context.

## 1. A channel is not the agent

Telegram, WhatsApp, Discord, and WeChat are **messaging channels**.
They deliver messages to the gateway and receive the completed response.
The agent is the channel-independent worker.

```text
Messaging app → message gateway → one Hermes Agent → tools, memory, Skills → original channel
```

## 2. The gateway has three jobs

1. **Receive and normalize** platform-specific messages, users, and conversation IDs.
2. **Route** the request to the configured agent instead of creating another persona or memory store.
3. **Deliver** the completed result to the correct platform and conversation.

## 3. Shared does not mean boundary-free

One agent can have several entrances, but each channel still has its own authorization, message format, and delivery limits.
After connecting a channel, send a test message and confirm that the reply returns to the intended conversation.

## Conclusion

Multi-channel support is not seven copied bots.
It is seven entry points sharing one durable agent.

Next: [How Hermes Agent reaches you on schedule](./08-automation-scheduling.md).
