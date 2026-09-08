## Summary

**A Hermes Agent's personality is not a fixed block of character copy. It emerges from three pieces working together: `SOUL.md` sets out who it is and how it works — stable behavioural rules; `USER.md` records how you want to be treated — the defaults of the relationship; `MEMORY.md` and `memories/` hold what the two of you have already established — evidence of shared history. Keeping their roles distinct is what allows an Agent to be stable and individual at the same time: persona alone makes it identical for everyone, memory alone makes its behaviour drift unpredictably. They should not substitute for one another — a persona does not store specific facts, `USER.md` does not store one-off moods, and `MEMORY.md` does not carry behavioural rules. All three stay in place when you switch models, so personality stability does not depend on any particular model.**

---

## Why the same character should behave differently with different people

Imagine two users who both configured their Agent as "a patient research assistant."

The first is a product manager who prefers the conclusion before the reasoning and mostly discusses release pacing and priorities. The second is a student who needs the full derivation and mostly discusses concepts and assignments.

If both Agents said exactly the same things, then "patient research assistant" never actually landed — it stayed a label instead of becoming a concrete way of working together.

Conversely, if personalisation meant letting behaviour drift freely with every conversation, the Agent would lose predictability: rigorous today, careless tomorrow. You could not rely on it.

**Personality has to satisfy two conflicting requirements at once: be stable, and be person-specific.** Hermes resolves this by splitting the two requirements across layers, each carried by a different file.

---

## 1. Three pieces, three responsibilities

Start with the overall picture.

| Piece | Where it lives | The question it answers | Change frequency |
|---|---|---|---|
| **Persona** | `SOUL.md` | Who am I? What principles do I work by? | Very low; edits are deliberate decisions |
| **User preferences** | `USER.md` | How do you want to be treated? | Low; adjusts with long-term habits |
| **Long-term memory** | `MEMORY.md`, `memories/` | What have we already established? | High; entries may be added most sessions |

That **difference in change frequency** is one of the core reasons for keeping them apart. Putting a rulebook that stays still for months into the same file as a fact list that grows daily means the stable part gets washed out by the volatile one. This is the same reasoning behind keeping `USER.md` and `MEMORY.md` separate — see "Why Hermes Agent Splits Memory in Two: The Roles of USER.md and MEMORY.md."

---

## 2. Persona: stable behavioural rules

`SOUL.md` is the Agent's rulebook, and it typically covers:

- **Role** — what it plays: research assistant, writing partner, community duty assistant.
- **Tone and expression** — formal or relaxed, whether to use analogies, whether humour is welcome.
- **Priority ordering** — which wins when accuracy conflicts with speed, or brevity with completeness.
- **Behavioural limits** — what it will not do, what it will not expand on, which actions require confirmation first.

Three practical points when writing a persona.

**First, write principles, not facts.** "I work for a product manager on the agent-demo project" does not belong in `SOUL.md` — that is a fact, and it belongs in `USER.md` or memory. A persona should state durable principles such as "for product questions, give the conclusion before the reasoning."

**Second, make limits concrete enough to judge.** "Stay professional" cannot be evaluated for compliance. "Do not offer medical, legal, or investment decisions; provide public information and suggest consulting a professional" can. Abstract rules produce wildly different adherence across models.

**Third, state priority explicitly for conflicts.** Rules inevitably conflict — brevity and completeness are one such pair. Without an explicit ordering, the Agent has to guess each time, and its behaviour becomes inconsistent.

---

## 3. User preferences: the defaults of the relationship

`USER.md` carries **stable information about you**, so the Agent does not have to ask again each time. Good candidates:

- **Language and expression** — which language, whether to keep terminology in its original form, whether examples help.
- **Communication pacing** — conclusion first, or the full reasoning path.
- **Usual tools and environment** — the stack, platforms, and working style you use daily.
- **Explicit things to avoid** — directions you do not want probed, phrasing you do not want used.

There is a simple test for whether something belongs in `USER.md`: **will it still be true in three months?** "I prefer concise answers" probably will, so it fits. "I am in a hurry today" will not — that is one-off context and should stay out.

This test matters. Writing a one-off mood into `USER.md` makes the Agent treat a temporary state as permanent. If you once said "keep it short" while rushing and that hardens into a long-term preference, it will withhold detail later when you genuinely need it.

---

## 4. Long-term memory: evidence of shared history

`MEMORY.md` and `memories/` store **facts that already happened and are worth keeping**: project state, decisions made, reusable conclusions, why a parameter is set the way it is.

Its relationship to the other two:

- The persona determines **behavioural principles**.
- `USER.md` determines **default interaction style**.
- Memory determines **the background you both share**.

Recall is on demand: Hermes builds a SQLite + FTS5 full-text index over entries and pulls matching ones into context when you raise a related topic, rather than pushing all history in. Writing is not unbounded appending either — it is maintained through atomic `add` / `replace` / `remove` operations and can be reviewed via `/memory pending`. For the full curation logic, see "Why More Memory Is Not Better: How Hermes Agent Selects, Curates, and Updates Long-Term Memory."

**Memory should not substitute for the persona.** A common mistake is writing a behavioural rule as a memory entry, such as "remember: always give the conclusion first." That creates two problems: the entry may not be recalled if the query does not match it, and it can be washed out by later entries. Behavioural rules belong in `SOUL.md`, which is always resident.

---

## 5. How the three combine to produce one answer

A concrete scenario tying the layers together.

**Setup**:

- `SOUL.md`: research assistant; conclusion before reasoning; flag uncertainty explicitly; do not expand on medical or investment advice.
- `USER.md`: prefers English; keep technical terms in their original form; keep answers scannable.
- `MEMORY.md`: currently working on the global site for the agent-demo project; last week decided to change the homepage to an animated gradient; the project runs on Next.js.

**Your question**: "For the current homepage approach, what are the risks of adding a video background?"

**What each layer contributes**:

1. **Memory** supplies background: the Agent knows which page "the homepage" refers to and that it was just changed to an animated gradient, so it can treat a video background as a change on top of that rather than a blank-slate decision.
2. **Persona** determines structure: conclusion first ("the main risks are above-the-fold performance and mobile data usage"), then the reasoning, with uncertainty explicitly flagged.
3. **`USER.md`** determines expression: answer in English, keep terms such as `LCP` and `autoplay` as-is, and keep the length scannable.

Remove any one layer and the result degrades visibly: without memory the answer stays generic; without the persona the structure wanders and uncertainty goes unflagged; without preferences the language and length do not fit how you read.

---

## 6. Common symptoms and where each belongs

In practice the most frequent question is "where should this piece of information go?" The table below answers it.

| Symptom | More likely cause | What to change |
|---|---|---|
| Same generic approach to every topic | Memory lacks your specific background | Add memory entries |
| Inconsistent behaviour, rigorous then careless | Persona rules too abstract, or no conflict priority | Edit `SOUL.md` so rules are judgeable |
| You restate preferences every time | Preferences were never written to `USER.md` | Add them to `USER.md` |
| Treats a temporary state as permanent | One-off context got written into `USER.md` | Remove that entry; state it in-conversation instead |
| A rule applies sometimes but not always | The rule was stored as a memory entry | Move it from memory into `SOUL.md` |
| Tone shifted noticeably after a model switch | The new model applies rules with different strictness | Make key constraints more specific; leave memory alone |

The last row deserves emphasis: **a tone shift after switching models is not a lost personality.** `SOUL.md` is still where it was; adherence changed. For how to tell the difference, see "Will Switching Models Make an Agent Forget? Decoupling Model, Persona, and Memory."

---

## 7. LightVela's approach: personality and preferences as manageable assets

Hermes separates these three layers clearly, but it still targets people editing Markdown directly. LightVela runs a cloud-hosted model and does not expose user-facing filesystem operations, so these layers are maintained differently than in a self-hosted setup:

- **Persona is configured through the Persona feature** — the Persona section on an Agent's settings page offers two entry points, drawing a persona at random or answering a short quiz. Review a persona card's role, tone, and behaviour notes, then choose Inject Persona to apply it. It generates and injects the Soul without requiring you to touch the cloud filesystem, though it is not a general-purpose editor for arbitrary cloud files.
- **Memory is viewable in the console** — the memory page shows what the Agent has retained, with separate tabs for Memory and User Profile, matching the split between facts and stable preferences.
- **Additions and removals happen through conversation** — you do not need to deliberately "fill in" memory. During normal conversation Hermes decides what is worth retaining; when you want it to remember or forget something, just say so in chat.
- **Capacity is adjustable** — the console lets you raise or lower the memory capacity limit, preventing long-term context from growing without bound.
- **Stable across models** — switching models does not clear memory, skills, or scheduled tasks, so personality stability does not depend on a specific model.
- **Consistent across channels** — one Agent shares the same memory and persona across every connected channel; switching phones or channels does not lose it, and nothing needs duplicating per platform.

---

## Key points

- Personality emerges from three pieces: `SOUL.md` (behavioural rules), `USER.md` (default interaction style), `MEMORY.md` / `memories/` (shared background).
- The core reason to separate them is **different change frequency**: rules stay still for months, memory grows almost daily.
- Personas state principles rather than facts, keep limits concrete enough to judge, and declare priority for conflicting rules.
- Test for `USER.md` membership: **will it still be true in three months?**
- Do not store behavioural rules as memory entries, or they will intermittently fail through recall misses or being washed out.
- A tone shift after switching models reflects different adherence, not lost personality or memory.

