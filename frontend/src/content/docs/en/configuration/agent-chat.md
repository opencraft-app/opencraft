# Chat

Open the "Chat" page to interact with your Hermes agent through a chat window.

> ℹ️ **Heads-up**
>
> AgentChat's interface guide is currently primarily in Chinese; full localization is on the way.

![](../images/agentchat-1-global-en.webp)

---

## Conversation memory

The Hermes agent can iterate and evolve on its own as conversations continue. Learn more about your memory by visiting the "Memory" page.

![](../images/agentchat-2-global-en.webp)

### How memory works

Hermes builds up long-term memory automatically through two mechanisms:

- **Context compression**: distills the key information from long conversations into long-lived memory.

- **Key memory nodes**: automatically captures personal preferences, usage habits, and project-related information worth reusing later.

### How memory is stored

Memory is persisted into two kinds of documents:

- `MEMORY.md`: project information, runtime environment, and collaboration conventions

- `USER.md`: the user's personal preferences, usage habits, and communication style

Only content with long-term value is retained, so that Hermes can give coherent, personalized replies in later conversations.

---
