## Summary

**One Agent can appear across several messaging apps because the apps are only entry points — the Agent is the thing that actually works. The message gateway does three jobs: it normalises structurally different messages from Telegram, WhatsApp, Discord, WeChat and others into one request format; it routes each request to the same Agent based on your connection configuration, instead of cloning a personality and memory per platform; and after execution it delivers the result back to the exact conversation it came from. Because identity (`SOUL.md`), memory (`USER.md`, `MEMORY.md`), skills (`skills/`), and automations all live outside the channel layer, something you mentioned on Telegram is still known when you follow up on WhatsApp. But unified does not mean unbounded: every channel has its own authorisation flow, message format, and delivery limits, the supported channel set differs between the global and China regions, and after connecting a new channel you must send a test message to confirm replies land in the expected conversation.**

---

## The scenario this solves

Picture a single day of use. On Telegram you ask your Agent to summarise where a project stands. Heading out at midday, you follow up on WhatsApp: "what was the risk in the second option you mentioned?" In the evening you ask it to post the conclusion in a team Discord channel.

If those three interactions behaved like three unrelated bots, multi-platform access would be worthless — you would re-explain the context every time. The useful shape is different: three entry points, one assistant.

The difficulty here is commonly misread as "integrating a few more APIs." API integration is only the surface-level work. The real problem is this: **make every entry point resolve to the same identity and context, without breaking each platform's own rules.** The message gateway is the layer that resolves that tension.

---

## 1. First, a correction: a channel is not an Agent

This distinction is the prerequisite for everything else.

| Concept | What it is | Cardinality |
|---|---|---|
| **Channel** | An entry point for messages, e.g. Telegram, WhatsApp, Discord, WeChat | One Agent can connect many |
| **Agent** | The persistent working subject holding identity, memory, skills, tasks | Shared by many channels |

People instinctively treat "my Telegram bot" as a standalone entity, which naturally raises the question "so is my WhatsApp bot a different one?" Once channels are understood as entry points rather than subjects, the question dissolves.

The full path looks like this:

```text
Messaging apps (multiple entry points)
    ↓  platform-native messages
Message gateway (normalise / route / deliver)
    ↓  unified request
The same Hermes Agent
    ↓
model inference + tool execution + memory recall + skill loading
    ↓  execution result
Message gateway
    ↓  delivered in platform format
Original conversation on the original channel
```

Note that final step — *the original conversation on the original channel*. That is not a footnote; it is one of the core problems the gateway must get exactly right, covered below.

---

## 2. Gateway job one: receive and normalise

Platforms differ along nearly every dimension:

- **Different user identifiers** — numeric IDs, phone numbers, or platform-internal usernames.
- **Different conversation identifiers** — direct messages, groups, channels, and threads are each represented differently.
- **Different message structures** — text, images, voice, files, quoted replies, and reactions all have their own field designs.
- **Different event models** — some push via webhooks, others need a persistent connection or polling.

If the Agent faced these differences directly, platform-specific branching would spread through its core, and every new platform would mean touching core logic. Normalisation confines those differences to the gateway: platform-native messages become one uniform request, so the Agent only ever needs to understand a single input shape.

The practical payoff: **adding a channel should not require changing identity, memory, or skill logic.** The Agent cares about what was asked, not which app's field layout carried it.

---

## 3. Gateway job two: route to the same Agent

This is the step that makes "one personality across platforms" possible.

Once a request is normalised, the gateway uses your **connection configuration** to determine which Agent it belongs to, then hands the request to that Agent. It does not spin up a fresh personality or memory store just because the message arrived from a newly connected platform.

This matters because it decides whether long-term assets are shared or fragmented:

| Asset | Where it lives | Behaviour across channels |
|---|---|---|
| Identity and behavioural rules | `SOUL.md` | One copy, shared by all channels |
| User profile | `USER.md` | One copy, shared by all channels |
| Cross-session facts | `MEMORY.md` / `memories/` | One copy, shared by all channels |
| Captured methods | `skills/` | One copy, shared by all channels |
| Automations | Agent-layer configuration | Decoupled from channels; delivery target configurable |

Because all of these sit outside the channel layer, "it still knows the project name I mentioned on Telegram" is not a synchronisation feature someone had to build — it is a natural consequence of there only ever being one copy.

This is the same decoupling logic as "switching models does not lose memory": **separate the volatile access layer from the stable asset layer.** For the model-side version of this argument, see "Can a Hermes Agent's Brain Be Replaced? Model Layer vs Agent Layer."

---

## 4. Gateway job three: deliver back to the right place

Once the Agent finishes, the gateway sends the result back. "Sending it back" is harder than it sounds, because it must answer three questions correctly at once:

1. **Which platform** — a message from Telegram must return to Telegram, not WhatsApp.
2. **Which conversation** — on one platform you may have direct messages plus several groups and channels. Replying to the wrong conversation is not merely awkward; in a group context it can leak information.
3. **Which format** — platforms differ on message length limits, Markdown support, how images and files are sent, and whether quoted replies exist. The same content needs different presentation per platform.

The second point deserves emphasis. **Wrong delivery targets are the highest-severity class of problem in multi-channel setups**: private content posted to a group, or one team's conclusion sent to another team's channel. That is exactly why every newly connected channel should be verified with a test message in a safe conversation first.

---

## 5. Unified does not mean unbounded

"One Agent, many entry points" is easily over-read as "all platforms behave identically." In reality each channel keeps its own constraints, and sharing an Agent does not remove them.

### 5.1 Authorisation differs

Each platform has its own connection flow and credential shape: some require creating a bot in a developer portal and copying a token, some require scanning a QR code, some require an AppID and AppSecret. In other words, **connecting each channel is an independent authorisation step** — one setup does not cover them all.

### 5.2 Supported channels differ by region

This is an easy trap when reading documentation: LightVela's global and China regions do not support the same channel set. The global channel order is Telegram, WhatsApp, Discord, WeChat, QQ, WeCom, Lark. The China region currently targets locally common platforms such as WeChat, Lark, and QQ.

So when you see a claim like "Telegram is supported," confirm which region it applies to rather than assuming it carries across.

### 5.3 Group context differs from direct messages

In a direct message the Agent faces one person; in a group it faces many. Groups add questions: when should it respond, when should it stay silent, what content is inappropriate to expand on publicly, and who is allowed to trigger sensitive actions. These belong to behavioural rules and permission design — the gateway cannot decide them automatically.

### 5.4 Delivery capabilities differ

Message length caps, rich-text support, file sending, and the ability to quote a specific message all shape the output. A long reply that renders cleanly in Discord may need splitting or simplifying elsewhere.

---

## 6. A practical order for connecting a new channel

Turning the principles above into steps, this order avoids most problems.

1. **Confirm regional support** — verify the channel is available in your region, so you are not following documentation written for another one.
2. **Complete platform-side authorisation** — follow that channel's guide to create a bot or grant access and obtain the credentials. Credentials are sensitive: never write them into long-term context files or paste them into chat.
3. **Connect on the product side** — enter the credentials, save, and confirm the status shows as connected.
4. **Send a test message** — use a safe conversation (a direct message or a test group) and confirm the Agent replies.
5. **Verify the delivery target** — specifically check that the reply landed in **the same conversation you messaged from**, not another one.
6. **Verify shared memory** — ask about something you told it on a different channel. A correct answer proves this channel really routes to the same Agent.
7. **Only then add group access** — after direct messages check out, join groups and confirm the in-group response boundaries behave as expected.

Step 6 is the one most people skip, and it carries the most value: it is the most direct way to confirm that channels genuinely share one Agent.

---

## 7. Common symptoms and how to read them

| Symptom | More likely cause | Suggested action |
|---|---|---|
| No reply at all on a new channel | Authorisation incomplete or credentials wrong | Check connection status and credentials, redo authorisation |
| Reply appears in a different conversation | Delivery target resolution or configuration error | Stop using it in groups; move to direct messages to isolate |
| Replies, but "doesn't know me" | Possibly connected to a different Agent | Verify with a known fact and check which Agent the connection points to |
| Groups silent, direct messages fine | In-group trigger rules or permissions | Review group response rules and required permissions |
| Long replies truncated or misformatted | Platform delivery limits | Adjust output length and formatting for that platform |

Row three deserves attention: **"doesn't know me" means something different here than it does after a model switch.** After switching models it is usually a style difference; on a newly connected channel it more likely means this channel is not pointing at the Agent you assumed. The diagnostic is the same — ask about one fact you are certain it should know.

---

## 8. LightVela's approach: channels as pluggable entry points

Hermes separates channels from the Agent at the mechanism level, but connecting each platform still means handling credentials, callbacks, and runtime yourself. LightVela's direction is to make that layer a productised, pluggable entry point:

- **Channels are settings** — connect or disconnect them under one Agent, with no need to create a separate Agent per platform.
- **Assets are shared by default** — one personality, memory, skill set, and automation set; a new channel reuses them immediately, with nothing to migrate.
- **Connection state is visible** — the console shows whether a channel is connected, making it easy to distinguish "never connected successfully" from "connected but not replying."
- **Regional differences are explicit** — the global and China regions each list their own supported channels, preventing cross-region mistakes.
- **Problems are traceable** — recent logs in Diagnostics help separate authorisation issues from delivery issues from task issues.

---

## Key points

- Channels are entry points; the Agent is the subject. Many channels share one Agent rather than one bot per platform.
- The gateway does three things: **normalise** platform differences, **route** to the same Agent, and **deliver** back to the original conversation.
- Identity, memory, skills, and automations live outside the channel layer, so cross-channel continuity is an architectural consequence, not an added sync feature.
- Unified does not mean unbounded: authorisation, regional support, group context, and delivery limits differ per channel.
- After connecting a channel, verify two things: that replies land in the expected conversation, and that it genuinely shares the same memory.

