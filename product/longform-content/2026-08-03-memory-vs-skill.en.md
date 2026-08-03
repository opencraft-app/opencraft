# Memory vs Skill: Declarative Memory and Procedural Memory

> **What is LightVela?** LightVela is a cloud-hosted personal AI agent platform for running an always-on agent with memory, skills, automations, and messaging channels. [Visit LightVela](https://lightvela.ai/?from=social_techpedia)

"Remembering 'this project runs on port 5174' and remembering 'summarize first, then list changes when writing a PR description' — aren't those the same thing?"

**No.** The first is **declarative memory** (a fact you can state), the second is **procedural memory** (a method you can perform but may not be able to explain). Hermes Agent splits them into Memory and Skill for a direct reason: **because the human brain splits them too.**

## Cognitive science settled this long ago

Psychology has long distinguished two kinds of long-term memory:

| Type | Definition | Example | How it is invoked |
| --- | --- | --- | --- |
| Declarative | Facts you can state | "I live in Beijing", "React 18 introduced concurrent rendering" | By being **stated** |
| Procedural | Skills you can perform but may not be able to explain | Riding a bike, touch typing, writing a well-structured PR description | By being **executed** |

One experimental finding makes the point vividly: patients with hippocampal damage have severely impaired declarative memory, yet can still learn procedural tasks such as mirror writing. **These are two independent pathways, not two expressions of one pathway.**

Hermes ports that distinction straight into its design: Memory is the agent's declarative memory, Skill is its procedural memory.

## Memory: what the agent can state

Memory holds facts, events, conclusions, and preferences:

- "They are working on the global site for agent-demo."
- "Last week the hero section was changed to an animated gradient."
- "The project runs on Next.js, with the frontend dev server on port 5174."

It **exists as short sentences and entries** (citable directly into a prompt), is **recalled on demand** (pulled in by retrieval when a related topic comes up), and is **volatile** (new entries appended, old ones replaced or removed).

**Memory is the agent's notebook** — one lying open on the desk, filled with specific facts.

## Skill: what the agent can do

A Skill holds the standard procedure for a class of task, with trigger conditions declared up front:

```yaml
---
name: pr-description-format
trigger:
  when: "user asks to write a PR description"
---

# Standard procedure for writing a PR description

1. Summarize the goal of the change in one sentence
2. List the changes (grouped by module)
3. Blast radius
4. Testing status
5. Related issue / rollback plan
```

It **exists as "when to trigger + how to do it"**, is **loaded automatically as a high-priority prompt on scenario match**, and is **relatively stable** (once captured it usually stays put).

**Skill is the agent's muscle memory** — no recall needed, the motion just happens.

## Why not merge them? Three hard constraints

### Constraint 1: different triggers

Memory is "recalled when asked"; Skill is "loaded when the situation matches" (with explicit trigger conditions). Merged, the agent would lose track of whether it is citing a fact or following a procedure.

### Constraint 2: different forms

Memory is short sentences, facts, entries. Skill is procedure, template, constraint, usually with "step 1 / 2 / 3" ordering. Packed together, the agent cannot tell "is this background, or something I should be executing right now?"

### Constraint 3: different rates of change

Memory changes daily (a session may append one or two entries). A Skill can sit unchanged for months (an SOP for PR descriptions needs no edits for half a year).

Putting them together lets high-frequency factual entries wash away a stable procedure — **like binding a constitution and a desk calendar into the same notebook.**

## A real scenario: using both together

Suppose you tell the agent:

> "From now on our team writes PR descriptions in this format: one-sentence summary, list of changes, blast radius, testing status. Also, remember that this project is called agent-demo and the frontend runs on port 5174."

A well-trained agent splits that as follows:

- **First half** → captured as a new **Skill**, triggered by "user asks to write a PR description".
- **Second half** → written as one **Memory** entry: `- [2026-07-30] agent-demo: frontend dev server on port 5174`.

Next time you say "write me a PR description", the agent will **match the scenario and load the Skill** (it knows the format) and **match Memory by query** (it knows the project is agent-demo on 5174), producing a description that follows the team standard and fits the specific project.

**Remembering facts plus remembering methods is what makes the result better than the sum of its parts.**

## From technical feature to user asset

Bring this layering into a product context and a shape with real potential appears:

- **Memory is the shared archive between you and the agent.**
- **Skill is the working methodology you bring to the agent.**

Your writing patterns, review procedures, and translation standards can all become Skills; every factual memory the agent holds about you can be viewed, corrected, and deleted transparently. In team settings, both can be captured at team scope — a new joiner inherits the team's shared memory and shared methods automatically, instead of relying on word of mouth.

[LightVela](https://lightvela.ai/docs/overview?from=social_techpedia) is built on exactly this thinking: the [Skill system](https://lightvela.ai/docs/configuration/skill?from=social_techpedia) lets you collect, edit, and share your own workflows the way you collect prompts, and [memory management](https://lightvela.ai/docs/configuration/memory?from=social_techpedia) makes everything the agent remembers about you transparent.

In other words, training an agent on LightVela means **accumulating two assets at once**: the Memory about you, and your collection of Skills. **Those two assets are what belong to you long term — they matter more than the model itself.**

To try it, start with the [quickstart](https://lightvela.ai/docs/quickstart?from=social_techpedia); to get the concepts first, read [core concepts](https://lightvela.ai/docs/core-concepts?from=social_techpedia).

## Join LightVela's Community for More Updates!

**Visit us at [LightVela](https://lightvela.ai/?from=social_techpedia)**

**Discord** — scan the QR code to join our Discord community and connect with builders for the latest updates.

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** — scan the QR code to join our WhatsApp group, try LightVela, and chat with us directly.

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
