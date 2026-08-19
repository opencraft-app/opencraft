

## Summary

**Hermes Agent remembers you not because of a bigger context window, but because of a long-term memory system with four cooperating layers: `USER.md` (1,375 characters / about 500 tokens) covers "who you are", `MEMORY.md` (2,200 characters / about 800 tokens) covers "what we have done together", a SQLite + FTS5 session archive means any sentence can be retrieved precisely weeks later, and Skills cover "how I should handle this kind of task". Writes are organized deliberately by the agent at four moments — Compression, Checkpoint, Nudge, and explicit user instruction — while recall combines three legs: structured default loading, exact FTS5 matching, and LLM semantic summarization. That is what turns "remembering you" from a concept into engineering.**

---

## The moment most AI assistants disappoint you

It is not when they get an answer wrong. It is when you have to say:

> **"Didn't you just tell me this last time?"**

Context windows have climbed from 8k to 200k and 1M, but remembering you was never a matter of stuffing in more tokens: 200k of context inside one session evaporates the moment that session ends. To make an agent remember you long term, three questions have to be answered:

- What deserves to be written into long-term memory? (Where is the write gate?)
- In what shape should memory be stored so it can still be found weeks later?
- When it is time to find something, does the agent rely on vector similarity, or on something else?

Hermes answers all three with a full long-term memory system. The sections below break it into five layers.

---

## 1. First, define what "remembering" means

In human terms, "remembering you" contains at least three things:

1. **Knowing who you are** — name, role, preferences, usual toolchain.
2. **Knowing what we have done together** — projects discussed, conclusions given, pitfalls hit.
3. **Knowing how to deal with you** — do you want short or detailed answers? Conclusion first, or reasoning first?

A model with nothing but a large context window can do all three **within a single conversation**, but the moment the session ends, points 1 and 3 reset.

**Hermes' approach**: push those three things into separate persistence layers, each maintained the way it should be — point 1 goes to `USER.md`, point 2 goes to `MEMORY.md`, and point 3 is maintained jointly by the preference fields in `USER.md` and Honcho's user modeling.

---

## 2. Writing: the agent organizes deliberately instead of jotting everything down

Hermes' long-term memory is not "one entry per sentence". The agent organizes and persists memory at **four explicit moments**:

| Trigger | Purpose |
|---|---|
| **Compression** | When context approaches its limit, first extract what is worth keeping long term from the current session, then compress the context |
| **Checkpoint** | At milestones such as finishing a subtask or switching topics, record deliberately |
| **Nudges** | The system periodically pokes the agent: "anything here worth writing to long-term memory?" This prevents information from quietly disappearing inside long sessions |
| **Explicit user instruction** | When a user says "remember that I use Y on project X", it is recognized as a high-priority memory write |

The key point: **the agent itself decides whether something enters long-term memory**, rather than persisting everything. That filter is the first gate on memory quality — and the most fundamental difference from chat history that stores every sentence.

A concrete cost calculation: without that filter, a user with 50 interactions a day would pour roughly **18 million tokens** of raw conversation into long-term memory in a year. Hermes' approach compresses that to **under 1%** while retaining nearly all of the key facts.

---

## 3. Storage: four layers, each with its own job

Hermes splits long-term memory into four kinds, each stored in a different place with an **explicit capacity ceiling**:

| Layer | Carrier | Typical capacity | Load timing | Responsibility |
|---|---|---|---|---|
| User profile | `USER.md` | ~1,375 chars / ~500 tokens | Every session | Who you are, role, preferences, usual stack, communication style |
| Factual memory | `MEMORY.md` + `memories/` | ~2,200 chars / ~800 tokens | Every session | Events, decisions, conclusions, facts to reuse across sessions |
| Session archive | SQLite + FTS5 full-text index | No ceiling (months of history) | Loaded when a query matches | Any original sentence can be retrieved precisely weeks later |
| Procedural memory | `skills/` directory (`SKILL.md`) | KB scale per file | High-priority load on scenario match | "What should I do in this situation" (covered by a dedicated article in this category) |

Beyond those, Hermes also keeps a `SOUL.md` — the agent's own personality description. It belongs to the agent's self-model rather than user memory, but together with user memory it forms the context foundation.

### Why does every layer have a hard ceiling?

Some people ask: if context windows are this large, why does `USER.md` only get 500 tokens?

Three reasons:

1. **Every extra 1,000 tokens in the system prompt wastes 18 million tokens a year at 50 calls per day** — serious cost pressure.
2. **Anything loaded on every session has to be carefully selected** — it is part of the system prompt, and bloat squeezes out the actual task context.
3. **A ceiling forces trade-offs** — when capacity is full, nothing is silently dropped; the agent is **forced to consolidate** (see section 5).

That is Hermes' core philosophy: **"remembering" is not "storing", it is "storing after deliberate selection".**

### One component you should not overlook: Honcho

Hermes also brings in a component called **Honcho** that performs **dialectic user modeling** — in plain terms, it continuously extracts reusable statements about the user from conversation and feeds them back into `USER.md` maintenance.

The implicit preferences that structured files handle poorly (for example, "this user gets impatient after 3pm", or "this user is unusually sensitive to filler words") are filled in by this purely LLM-driven inference layer.

---

## 4. Recall: structured, full-text, and semantic — three legs

Recall in traditional RAG setups leans heavily on vector similarity. But vectors alone hit two long-standing problems: **being important does not mean being similar to the query**, and **details get diluted inside a whole passage.**

Hermes' recall strategy looks more like hybrid retrieval:

| Retrieval method | Trigger scenario | Typical latency |
|---|---|---|
| **Structured default loading** | Every conversation start | Nearly zero (it is part of the system prompt) |
| **FTS5 full-text search** | The user asks about a specific fact: "what was that error again?" | ~20ms to match, ~1ms to page |
| **LLM semantic summarization** | Questions that require integrating multiple entries | Seconds, run on a cheap model (such as Gemini Flash) |

Those three working together are what make "remembering you" more than "our vectors are similar" — it becomes **"I actually know what you said".**

A sticky-note analogy helps: `USER.md` is **the note stuck on your monitor bezel** (visible every time you look up), `MEMORY.md` is **the journal on your desk** (also visible, with more inside), SQLite+FTS5 is **the archive box in the cabinet** (rarely opened, but always findable), and Skills are **muscle memory** (your body knows what to do when the moment comes).

---

## 5. Updating: memory is alive, not a ledger

One point often overlooked: **memory must be modifiable and disposable, not just writable.** Hermes has three explicit strategies here:

### Strategy 1: on conflict, update instead of appending in parallel

This avoids a split personality — you cannot have "user prefers Vue / user switched to React / user went back to Vue" sitting side by side. Hermes overwrites the old value for preference fields, while factual entries keep history but update a "current state" field.

### Strategy 2: entries not referenced for a long time get downweighted as low value

`MEMORY.md` has a hard ceiling (2,200 characters). When it is full, the response is:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

That is not an error, it is a **gate signal**: the agent has to make trade-offs and merge or delete stale, low-value entries before it can write again.

### Strategy 3: information the user explicitly denies is deleted immediately

Not "record the opposite", but **physical deletion** — keeping the world model self-consistent.

In other words, Hermes is closer to **editing a living archive** than to appending to a diary.

---

## 6. One thing is still missing for this to work in practice

However good the memory mechanism is, it has one prerequisite: **the agent has to stay alive.**

If you install Hermes on your own laptop, it naps every time you close the lid, and the background self-reflection loop (nudge) stalls. Switching machines or reinstalling the OS means moving `~/.hermes/` by hand, and the FTS5 index has to be rebuilt from scratch each time.

This is where cloud hosting becomes genuinely useful. [**LightVela**](https://lightvela.ai/) is a **cloud-hosted Hermes Agent service**:

- A dedicated cloud instance online 24×7, with `MEMORY.md` / `USER.md` / the SQLite session archive living there permanently;
- The background nudge loop keeps running, so the agent genuinely grows even when you are not using it;
- Data stays only on your dedicated server;
- Phone, laptop, Telegram, Slack, Lark — every channel reaches the same agent that knows you.

Hermes turned "remembering you" into a working engineering design; LightVela makes that design take effect **every single day, right next to you.**

---

## Key takeaways

- Hermes remembers you through **deliberate curation, layered storage, hybrid recall, and continuous updating** — not a bigger window.
- Every layer has an explicit capacity: 500 tokens for `USER.md`, 800 tokens for `MEMORY.md`, no ceiling for SQLite, and scenario-based loading for Skills.
- A good agent memory system **edits an archive** rather than **appending to a diary** — ceilings force trade-offs.
- LightVela's goal is to bring this capability from the command line into a product, so that being remembered is the default experience.
