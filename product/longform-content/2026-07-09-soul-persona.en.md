# Introducing Soul: Give Your Hermes Agent a Persona

[RECOMMEND ADD IMAGE: The persona (Soul) gallery in LightVela, showing a few persona cards such as the confident one, the playful cat, the zen monk, and the cheeky monkey — so readers see right away there's a cast of characters to pick from.]

LightVela is a [cloud-hosted personal AI agent platform](https://lightvela.ai/docs/overview), and most people meet it through Hermes Agent — an always-on AI assistant you can reach across channels like Telegram, WhatsApp, and Discord. Capable as it is, a fresh Hermes Agent has no personality of its own. Ask it a question and it gives you the textbook answer. Tell it about a rough day and it still gives you the textbook answer. The problem isn't ability — it's that the agent has no stable "self" to carry tone, rhythm, and attitude.

That's the gap the new **Soul** feature closes. A Soul is LightVela's persona system: a structured spec that gives each Hermes Agent a consistent character, so the assistant keeps the same way of speaking, working, and feeling across every session. (If you're new to the agent model itself, the [core concepts](https://lightvela.ai/docs/core-concepts) page is a good primer before reading on.)

## What Is a Soul?

A Soul is a complete persona, defined across five dimensions instead of a single sentence:

- **Core temperament** — the base color of the character: confident, gentle, sharp-tongued, zen.
- **Outer style** — how it shows up: its presence, pace, and energy.
- **Language system** — its catchphrases, favorite words, and preferred sentence shapes. This is the layer that decides every line you actually read.
- **Action logic** — how it gets things done: a fast decision-maker, or one that dissects every premise first.
- **Hidden traits** — the real motivations underneath, which keep the character grounded instead of flat.

[RECOMMEND ADD IMAGE: The persona detail panel showing the interpretation prose on top and the five dimensions — Core Temperament, Outer Style, Language System, Action Logic, Hidden Traits — listed below — so readers see how thoroughly one persona is mapped out.]

Here's the difference it makes. The confident persona leans on words like "simple, done, win, must, of course" and speaks in absolute, decisive sentences — and underneath, the more it cares, the more it plays it cool. The monk persona answers with "amitofo, good, good, benefactor" and tends to reply with a riddle or a story rather than a direct verdict. Ask the same question — "should I change jobs?" — and one will push you to decide, the other will ask you to weigh the cause and effect. Same capability, completely different voice.

## Why It Matters

Before Soul, giving an agent a personality was awkward. You'd hand-write a long instruction, paste it into every new chat, rewrite it whenever you wanted a different vibe, and live with shaky results — acting cool in one line, then apologizing in the next.

Soul turns a persona into a proper part of the product, not something smuggled in through prompts. Three things change because of that.

First, a persona is **selectable and swappable**. Want your agent to be a blunt advisor? Equip the sharp one. Want it to liven up a group chat? Switch to the humorist. One at a time, no confusion. (A persona is one layer of how you configure an agent — see the [configuration docs](https://lightvela.ai/docs/configuration) for the rest.)

Second, a persona is **structured**. Rather than a vibes-based one-liner, all five dimensions are defined explicitly, so the behavior stays consistent from the first reply to the hundredth.

Third, a persona **travels with the session**. Once you've picked one, a new session opened with `/new` carries that persona — you never have to re-explain "please act as…".

## How It Works

The flow on your side is short:

1. **Pick a persona.** When you set up your Hermes Agent, choose one from the persona gallery. LightVela keeps a curated catalog, and the richer, community catalog lives in SkillHub — the same place you browse and install [skills](https://lightvela.ai/docs/configuration/skill).
2. **Inject it in one tap.** LightVela saves the persona to your agent, so it becomes part of how the agent behaves — not a temporary instruction that fades.
3. **Open a new session.** Start a fresh chat with `/new`, and it opens with this persona already in character.

[RECOMMEND ADD IMAGE: The persona picker step while creating an agent, next to a /new new-session message where the agent already replies in character — so readers see the full path from pick to lived result.]

There's one design choice worth naming: the persona is baked into the agent rather than re-stated as a prompt each time. That's why it feels stable — the character becomes part of the agent's setup, and every new session just picks up where the personality left off. You can pair a Soul with scheduled [automations](https://lightvela.ai/docs/configuration/automation) too, so even a hands-off, recurring task runs in character.

## What You Can Do With It

- **Give a long-running agent a fixed character.** Want your research assistant to always be calm, precise, and relentless about questioning assumptions? Equip the inquisitor-style Soul, and it's right from the very first reply.
- **Same capability, different personality.** Drafting social posts? The humorist gives you something playful; the blunt one gives you copy stripped to the bone with zero fluff. The ability is identical — the flavor is not.
- **Give a channel bot a memorable identity.** In a persistent group, an agent with a stable persona gets treated as "that one," not as yet another anonymous AI. The unpredictable, cat-like energy of one persona is recognition by default.
- **Try styles quickly.** Swapping personas is cheap, so for one task you can test two or three in parallel, see which output you like best, then lock it in.

## What Comes Next

This is the first version of Soul: a structured, swappable, session-traveling persona layer. The direction it unlocks is clear — personas keep becoming more like a setting of the agent: from the official catalog, from the SkillHub community, and eventually a private Soul you shape yourself.

If you already have a Hermes Agent you use daily, the next move is simple: give it a Soul, then open a fresh session with `/new`, and feel the exact moment it becomes someone else. New to the platform? Start with the [quickstart](https://lightvela.ai/docs/quickstart).

---

## Join LightVela's Community for More Updates!

**Visit us at [LightVela](https://lightvela.ai)**

**Discord** — scan the QR code to join our Discord community and connect with builders for the latest updates.

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** — scan the QR code to join our WhatsApp group, try LightVela, and chat with us directly.

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
