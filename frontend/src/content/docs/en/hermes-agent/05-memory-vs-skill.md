

## Summary

**Memory and Skill are both long-term memory, but they are fundamentally different. Memory is declarative memory: it stores facts, events, conclusions, and preferences as short entries, and is recalled when a query matches (`MEMORY.md` + `memories/`). Skill is procedural memory: it stores the SOP for "what to do when situation X occurs" as a trigger-bearing YAML plus a procedure, and is loaded with high priority when the scenario matches (the `skills/` directory + `SKILL.md`). Three hard constraints keep them apart: different triggers (query match vs scenario match), different forms (entries vs step-by-step procedures), and different rates of change (Memory changes daily, Skills can sit still for months). An agent that walks on both legs both understands you and knows how to work.**

---

## Why these two concepts keep getting confused

If Hermes Agent has one design that is especially easy to misread, it is the clean separation of **Memory** and **Skill**.

Most people's first reaction is three questions:

- **"Aren't they both long-term memory? Why split them?"**
- **"They're both Markdown, so why not put them together?"**
- **"Remembering 'the agent-demo frontend runs on a local dev port' and remembering 'summarize first, then list changes when writing a PR description' — isn't that the same thing?"**

The short answer: **because the human brain splits them too.**

---

## 1. Cognitive science already made this distinction: declarative vs procedural

Psychology has long distinguished two kinds of long-term memory:

| Type | Definition | Example | How it is invoked |
|---|---|---|---|
| **Declarative** | Facts you can state | "I live in Beijing", "React 18 introduced concurrent rendering" | By being **stated** |
| **Procedural** | Skills you can perform but may not be able to explain | Riding a bike, touch typing, writing a well-structured PR description | By being **executed** |

These two kinds of memory differ in **how they are stored, invoked, and updated**: declarative memory can be verbalized (the verbal channel), while procedural memory is mostly performed (the motor channel). In psychology experiments, patients with hippocampal damage have severely impaired declarative memory yet can still learn procedural tasks such as mirror writing — **two independent pathways, not two expressions of one pathway.**

Hermes Agent ports that distinction straight into its system design:

- **Memory (`memories/`, `MEMORY.md`)**: the agent's declarative memory.
- **Skill (`skills/`)**: the agent's procedural memory.

---

## 2. Memory: what the agent can state

The memory system stores **facts, events, conclusions, and preferences**:

- "Jasmin is working on the global site for agent-demo."
- "Last week the hero section was changed to an animated gradient."
- "The project runs on Next.js, with the frontend dev server on a local dev port."

Its characteristics:

- **Declarative**: exists as short sentences and entries that can be cited directly into a prompt.
- **Recalled on demand**: when a related topic comes up, FTS5 matching pulls in the relevant entries.
- **Volatile**: new entries are appended, old ones are `replace`d or `remove`d.

**Think of Memory as the agent's notebook** — one lying open on the desk, filled with specific facts.

---

## 3. Skill: what the agent can do

A Skill stores the **standard procedure for a class of task**. A typical Hermes Skill is a `SKILL.md` whose YAML frontmatter declares the trigger conditions and the toolsets it backs up:

```yaml
---
name: pr-description-format
trigger:
  when: "user asks to write a PR description"
fallback_for_toolsets: [git, code-review]
---

# Standard procedure for writing a PR description

1. Summarize the goal of the change in one sentence
2. List the changes (grouped by module)
3. Blast radius
4. Testing status
5. Related issue / rollback plan
```

Its characteristics:

- **Procedural**: exists as "when to trigger + how to do it", close to a reusable SOP.
- **Triggered by scenario**: when the agent recognizes a matching situation, the Skill is **loaded automatically as a high-priority prompt** guiding that action.
- **Relatively stable**: once a Skill settles, it usually stays put; what changes is the scenarios and material in Memory that bind to it.

**Think of Skill as the agent's muscle memory** — no recall needed, the motion just happens.

Hermes users can also run `/learn` to have the agent distill "the part of this session worth codifying" into a new `SKILL.md` — much like a mentor passing a method to an apprentice.

---

## 4. "Why not merge them?" — three hard constraints

Someone will ask: they are both Markdown, both long-term memory, so why not put them together?

Because it does not work. The reasons resemble the three constraints that keep `USER.md` and `MEMORY.md` apart, but they are even stronger here.

### Constraint 1: different triggers

- Memory is "**recalled when a query matches**" (FTS5 plus semantic summaries).
- Skill is "**loaded when a scenario matches**", usually with an explicit trigger (`trigger.when: "user asks to write a PR description"`).

Merged, the agent would lose track of whether it is citing a fact or following a procedure.

### Constraint 2: different forms

- Memory is **short sentences, facts, entries** ("[2026-07-30] agent-demo frontend local dev port").
- Skill is **procedure, template, constraint**, usually with YAML frontmatter plus "step 1 / 2 / 3" ordering.

Packed together, the agent cannot tell "is this background, or something I should be executing right now?"

### Constraint 3: different rates of change

- **Memory changes every day** (a single session may append one or two entries).
- **A Skill can sit unchanged for months** (an SOP for PR descriptions needs no edits for half a year).

Putting them together lets high-frequency factual entries wash away the stable SOP — like binding a constitution and a desk calendar into the same notebook.

---

## 5. A real scenario: `/learn` and Memory working together

Suppose you tell the agent:

> "From now on our team writes PR descriptions in this format: one-sentence summary, list of changes, blast radius, testing status. Also, remember that this project is called agent-demo and the frontend runs on a local dev port."

A well-trained Hermes Agent handles that as follows:

- **First half** → the `/learn` path, writing a new **Skill**: `pr-description-format.md`, triggered by `user asks to write a PR description`.
- **Second half** → the `add` atomic operation, writing one **Memory** entry: `- [2026-07-30] agent-demo: frontend dev server on a local dev port`.

Next time you say "write me a PR description", the agent will:

1. **Match the scenario and load the Skill**: `pr-description-format.md` enters the high-priority prompt.
2. **Match Memory by query**: it knows the current project is agent-demo, running on a local dev port.
3. **Combine both**: producing a PR description that follows the team standard and fits the specific project.

**Remembering facts plus remembering procedures is what makes the result better than the sum of its parts.**

---

## 6. Skill Bundles and fallback_for_toolsets

Hermes adds two layers of organization on top of Skills:

- **Skill Bundle**: related Skills are packaged as a group. A "release pipeline" bundle might contain `pre-release-checklist`, `changelog-format`, and `deploy-rollback`, enabled, disabled, or shared as a unit.
- **`fallback_for_toolsets`**: a Skill can declare that it backs up a toolset when that toolset fails. For example, when the `git` toolset errors out, a Skill with manual rebase recovery steps fires.

Together these turn Skills from single-point SOPs into **composable working methodology** — an entire way of working that a user brings to the agent, captured as shareable assets.

---

## 7. Not a new idea, but rarely implemented properly

Layering factual and procedural memory has been discussed in AI circles for a long time. Actually engineering it, and making it **visible, editable, and reusable by users**, is where Hermes is relatively far ahead — it maps every layer to concrete directories, fields, and commands:

| Capability | Memory side | Skill side |
|---|---|---|
| Primary directory | `~/.hermes/memories/` | `~/.hermes/skills/` |
| Prompt-layer entry | `MEMORY.md`, `USER.md` | `SKILL.md` loaded on scenario match |
| Capture commands | `add / replace / remove` (agent-driven plus `/memory pending` approval) | `/learn` (agent-driven plus `/skills pending` approval) |
| Organization | Entries plus an FTS5 full-text index | A single SOP plus Bundles and `fallback_for_toolsets` |
| Rate of change | Daily | Months |

Bring that layering into a product context and you get a shape with real potential:

- **Memory is the shared archive between you and the agent.**
- **Skill is the working methodology you bring to the agent.**

Together, those two make the agent a partner that **understands you and knows how to work** — not a chatbot with a decent memory.

---

## 8. LightVela: turning both Memory and Skill into user assets

Hermes already made the Memory / Skill split usable in engineering terms, but it is still **Markdown for developers**. LightVela's approach is to raise that layer from a technical feature to a **user asset**:

- **A personal Skill library**: users can collect, edit, and share their own Skills (workflows) the way they collect prompts, and bind them to trigger scenarios. Your writing patterns, review SOPs, and translation standards can all become Skills.
- **A personal Memory library**: every factual memory the agent holds about you is transparent, viewable, correctable, and deletable — no need to edit `~/.hermes/MEMORY.md`.
- **Team-level reuse**: both Skills and Memory can be captured at team scope, so a new joiner automatically inherits the team's shared memory and shared methods instead of relying on word of mouth.
- **The shortest path**: if the "two legs" model appeals to you but you would rather not deal with Ollama, SSH, systemd, and `~/.hermes/` backups, LightVela is the shortest path to that model as a finished product.

In other words, training an agent on LightVela means **accumulating two assets at once**: the Memory about you, and your collection of Skills. **Those two assets are what belong to you long term — they matter more than the model itself.**

---

## Key takeaways

- Memory ≠ Skill. The first is **declarative memory** (facts that can be stated), the second is **procedural memory** (methods that get performed).
- Three hard constraints keep them separate: **different triggers / different forms / different rates of change.**
- A mature agent has to walk on both legs — remembering facts and remembering methods.
- LightVela turns both into user assets, so "training your own agent" becomes a product experience you can build on rather than a slogan.

---

## Where this leaves us

Across this category, five articles cover the ground:

1. How Hermes Agent differs from OpenClaw (**accumulation vs connection**)
2. How Hermes Agent remembers you (**four structured memory layers**)
3. Why Hermes Agent splits memory in two (**`USER.md` vs `MEMORY.md`**)
4. Why more memory is not better: how Hermes Agent filters, curates, and updates long-term memory (**four iron rules**)
5. Memory is not Skill: how factual and procedural memory differ (**walking on both legs**)

**One line to close**: the moat for the next generation of agents is not model size, but whether an agent genuinely **knows you** (Memory) and **has a method** (Skill) — and whether those two can run reliably over the long term comes down to whether it **stays alive**. That is exactly why LightVela exists.
