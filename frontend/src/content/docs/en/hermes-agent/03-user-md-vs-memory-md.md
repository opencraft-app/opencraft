

## Summary

**`USER.md` and `MEMORY.md` are the two personal notebooks behind Hermes Agent's long-term memory, and three hard constraints explain why they cannot be merged. First, capacity is independent (`USER.md` is about 1,375 characters / 500 tokens; `MEMORY.md` is about 2,200 characters / 800 tokens), so neither squeezes the other. Second, loading semantics differ: both load on every session, but their roles are completely different — one stably describes "who you are", the other frequently records "what we have done". Third, update semantics differ: preference fields in `USER.md` mostly overwrite old values, while `MEMORY.md` mostly appends and consolidates on demand. Merging them into a single `NOTES.md` would break all three constraints at once — a textbook case of "looks simpler, works worse".**

---

## A fair question to start with

Across Hermes' layered memory, `USER.md` and `MEMORY.md` add up to only **~3,575 characters / ~1,300 tokens** — remarkably restrained in an era of six-figure context windows.

So most people's first reaction is three questions:

- Why not merge them into a single `NOTES.md`?
- Why not scale up to tens of kilobytes?
- Why do the two files even have different ceilings (2,200 vs 1,375)?

All three point to the same answer: **`USER.md` and `MEMORY.md` are two different kinds of memory, and packing them together makes both worse.** Below, that design principle is unpacked in three layers.

---

## 1. `USER.md`: a stable, structured user profile

`USER.md` is a **stable description of you**:

- Identity: name, role, location.
- Preferences: communication style, usual tech stack.
- Constraints: schedule, language, topics to avoid.
- Working style: conclusion first, or process first.
- Long-term goals: what you are working toward.

Its **key characteristics**:

- **Stable**: updated once every few days or weeks.
- **Structured**: sectioned, itemized, field-based.
- **Always loaded**: injected into the system prompt at the start of every session.
- **Hard ceiling**: ~1,375 characters / ~500 tokens.

Think of `USER.md` as **the sticky note on the agent's monitor bezel** — not much on it, but always in view and always useful.

---

## 2. `MEMORY.md`: a growing, on-demand factual archive

`MEMORY.md` stores **what you and the agent have done together**:

- Project state: the agent-demo frontend runs on port 5174.
- Decisions: last week the hero section was changed to an animated gradient.
- Specific events: agreed with team A that X ships in Q4.
- Specific knowledge: this API authenticates through an internal SDK rather than the public endpoint.

Its **key characteristics**:

- **Dynamic**: nearly every substantive session writes one or two entries.
- **Itemized**: appended entry by entry for easy recall.
- **Always loaded plus on-demand FTS5 matching**: common entries load every session, historical entries are pulled in by FTS5 matches.
- **Typically 8–15 entries**: a target of 8–15 entries totalling ~2,200 characters / ~800 tokens.

Think of `MEMORY.md` as **the journal on your desk** — more than a sticky note, but still written sparingly so it stays fast to skim.

---

## 3. "Why not merge them into one NOTES.md?" — three hard constraints

Someone will always ask: they are both Markdown loaded on every session, so why not merge them?

Here are the three hard constraints, each independently strong enough to sink the idea.

### Constraint 1: independent capacity, no mutual squeezing

`USER.md` gets 500 tokens, `MEMORY.md` gets 800. After merging, a single 1,300-token `NOTES.md` immediately runs into a problem: **when memory is nearly full, does the agent delete a line about "who the user is" in order to record one more event?**

Obviously it **should not** — but once merged, that decision has to be made, and made **on every write**. Kept separate, the two pools evolve independently: when `MEMORY.md` fills up it only squeezes itself and never contaminates the profile.

### Constraint 2: different loading semantics

Both files really are **loaded on every session**, but their roles in the system prompt are completely different:

- The `USER.md` section answers "**who you are dealing with**", setting the agent's tone, level of detail, and stack assumptions.
- The `MEMORY.md` section answers "**what you have done together**", giving the agent factual handles.

Merged, the two would **dilute each other** — the agent could no longer quickly tell "is this a communication style I must follow, or a past fact I should cite?"

### Constraint 3: different update semantics

- **Preference fields in `USER.md` mostly overwrite**: when the user says "stop summarizing from now on", the relevant preference line is overwritten directly.
- **`MEMORY.md` mostly appends and consolidates on demand**: events are a time series, so history cannot be erased casually. When capacity is full, the following error response triggers active consolidation:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

After merging, `add / replace / remove` would all have to coexist on the same file, making both the implementation and the user's mental model **worse at the same time**.

---

## 4. A concrete example

Suppose you tell the agent:

> "I'm Jasmin, a frontend engineer, and I like conclusion-first communication. I'm working on the global site for agent-demo (an AI agent app) with Next.js. Last week we changed the hero section to an animated gradient."

A well-trained Hermes Agent splits that as follows:

**Written to `USER.md`**:

```md
## Identity
- Name: Jasmin
- Role: Frontend engineer

## Preferences
- Communication style: conclusion first
- Usual stack: Next.js
```

**Written to `MEMORY.md`**:

```md
- [2026-07-30] agent-demo: hero section on the global site changed to an animated gradient.
- Related project: agent-demo / global site (global region)
```

See the difference?

- "What kind of person you are" goes into the profile; "what we did together" goes into the archive.
- The former only changes when **you** change (new job, new team); the latter grows with **every day of conversation**.
- **Separate files are what allow each to evolve on its own.**

---

## 5. The five-item skip list

Hermes does not push everything into `USER.md`. It keeps a **skip list**:

1. **One-off moods**: "my head hurts today" — not a stable attribute.
2. **Temporary task parameters**: "change this title to X for me" — disposable.
3. **Vague attitudes**: "I think I prefer things a bit more concise" — not reusable enough (either qualify it or skip it).
4. **Anything inferable from live conversation context** — no need to persist.
5. **Sensitive information** (emails, passwords, addresses not explicitly confirmed by the user) — privacy-related content is not written by default.

That skip list is what keeps `USER.md` at "500 tokens and high density".

---

## 6. What this means for products

For an agent product, the split between `USER.md` and `MEMORY.md` is not just an engineering detail. It determines three things:

1. **Whether you can show users "what I think of you"** — that needs a stable, readable, editable profile (the semantics of `USER.md`).
2. **Whether the agent can avoid amnesia long term** — that needs a growing, recallable factual archive (the semantics of `MEMORY.md`).
3. **Whether cost stays bounded** — only layered loading can both "know who you are" and avoid burning an entire context.

---

## 7. LightVela: turning these two ledgers into a product

LightVela's internal agent memory design borrows exactly this layered thinking. Hermes' `USER.md` and `MEMORY.md` are Markdown files written for developers; LightVela turns them into two things an ordinary user can operate directly:

- **A visible profile layer**: users can see which profile facts the agent remembers and which conversation each came from, and correct them in one click. The profile is no longer a black-box `USER.md`.
- **An organizable fact layer**: factual memory is more than a pile of entries — it can be tagged by project, task, or time for easier recall and cleanup. In team scenarios, team memory and personal memory can be managed as separate layers.
- **The shortest path**: if the layered-memory idea appeals to you but you would rather not edit `~/.hermes/USER.md`, maintain FTS5, and back up SQLite yourself, LightVela is the shortest path to that idea as a finished product.

In one line: **Hermes provided the engineering blueprint for layered memory, and LightVela turns it into a product experience anyone can use.**

---

## Key takeaways

- `USER.md`: a stable, structured **user profile** loaded every session (~500 tokens, 8–15 profile fields).
- `MEMORY.md`: a growing, on-demand **factual archive** (~800 tokens, 8–15 event entries).
- Three hard constraints keep them apart: **independent capacity / different loading semantics / different update semantics.**
- Layering is a foundational capability for good agent memory, and the starting point for productizing memory at LightVela.
