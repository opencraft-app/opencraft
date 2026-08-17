## Summary

**An Agent gets better with use not because it mysteriously upgrades itself in the background, but because two kinds of things are retained in a structured way: stable facts become Memory, and reusable methods are captured as Skills, then reloaded when the situation matches. Memory lets it know what happened — recalled when a query matches. Skills let it know what to do next time — loaded when a situation matches. Their triggers, forms, and rates of change all differ, which is why they cannot be merged. Hermes provides `/learn` so the Agent can distil a proven procedure from the current session into a `SKILL.md`, with `/skills pending` for review, so self-improvement never becomes unbounded self-modification. A sound Skill must state four things: when to use it, which steps to follow, what success looks like, and which boundaries must not be crossed. What matters is not how much you capture, but that it stays reviewable, reusable, and updatable when the product changes.**

---

## Experience that cannot be reused is just a conversation

Think back to a session that went unusually well. You and your Agent debugged a problem together, or produced a genuinely good set of release notes. Along the way you corrected it three or four times: narrow the scope, keep the format consistent, never skip that one check. The result was solid.

A week later, the same kind of task arrives. If those corrections live only in last week's chat log, you will notice yourself saying the same things again — **the tuning never became an asset, only a one-time expense.**

That is the real question behind "gets better with use." It is not about the Agent becoming mysteriously smarter. It is about **what has already been proven being retained in a structured form.** What you keep, how you keep it, and where it lives decide whether accumulation is real or whether every session starts over.

---

## 1. Two kinds of accumulation, not to be conflated

An Agent accumulates two fundamentally different things.

| Accumulation | What it stores | How it is used | Rate of change |
|---|---|---|---|
| **Memory** | Facts, preferences, conclusions, history | Recalled when relevant to the current question | High; entries may be added most sessions |
| **Skill** | Situations, steps, boundaries, checks | Loaded and executed when a situation matches | Low; may sit unchanged for months |

A matched pair of examples:

- "This user prefers the conclusion first" → **Memory**. It is a fact about you.
- "Before writing release notes, verify the version number and that every link resolves" → **Skill**. It is a procedure to run whenever that kind of task appears.

They cannot be merged, for at least three reasons: **different triggers** (query match vs situation match), **different forms** (short entries vs ordered steps), and **different rates of change** (daily vs monthly). Mixing a stable procedure into a high-churn fact list washes the stable part out. For the full argument, see "Memory Is Not a Skill: How Hermes Agent Separates Factual and Procedural Memory."

This distinction has an immediate practical payoff: **when you catch yourself correcting the same kind of behaviour repeatedly, what you need is a Skill, not another fact in memory.**

---

## 2. What a Skill looks like

In Hermes a Skill is typically a `SKILL.md` with YAML frontmatter declaring its trigger and supporting details. Roughly:

```yaml
---
name: release-note-format
trigger:
  when: "user asks to write release notes"
---

# Standard procedure for release notes

1. Confirm the version number and release date
2. Group entries as Added / Fixed / Changed
3. Verify every external link resolves
4. Check for internal project names or ports; replace with placeholders
5. Confirm length fits the publishing channel's limits
```

The `trigger` is what matters: it means you do not invoke the Skill manually. When a matching situation is recognised, the Skill is loaded automatically as a high-priority instruction guiding that run.

Hermes adds two layers of organisation:

- **Skill Bundle** — package related Skills to enable, disable, or share as a group. A "release pipeline" bundle might contain pre-release checks, changelog format, and rollback steps.
- **`fallback_for_toolsets`** — a Skill can declare itself the fallback when a given toolset call fails, so failure paths also have a defined procedure.

Together these turn Skills from isolated SOPs into a composable working methodology.

---

## 3. `/learn`: turning one successful run into a method

Capturing a Skill does not require leaving the conversation to write files. Hermes provides `/learn`, which lets the Agent distil a procedure worth keeping from the current session into a new `SKILL.md`.

The value of this design is that **capture happens while memory is freshest**. Right after a successful collaboration, both you and the Agent know which steps mattered and which correction was essential. Write it up a week later and the details are already gone.

But automatic distillation creates a problem that must be addressed: **if an Agent can add behavioural rules to itself at will, its behaviour becomes unpredictable.** Hermes handles this with a review step — inspect pending Skills via `/skills pending` and decide whether to adopt them. This mirrors `/memory pending` on the memory side.

**Self-improvement is not unbounded self-modification.** The reliable path is that a new method first becomes a **reviewable rule**, taking effect only after confirmation. That is what makes capability growth explainable, reusable, and correctable.

---

## 4. Four things a sound Skill must state

This is what separates a useful Skill from a harmful one. Omit any of the four and the Skill will misfire in practice.

**First, when to use it.** Trigger situations must be specific. "When handling documents" is too broad and will load in contexts where it does not belong; "when the user asks for release notes" is specific enough. An over-broad Skill is worse than no Skill, because it interferes with unrelated tasks.

**Second, which steps to follow.** Steps must be ordered and executable. "Pay attention to quality" is not a step; "verify every external link resolves" is. The test: could another person follow this Skill and produce a broadly consistent result?

**Third, what success looks like.** Without a success criterion the Agent cannot self-check and you cannot judge whether a run was acceptable. Make it verifiable, for example "all three groups present, each with at least one entry or an explicit note that the group is empty."

**Fourth, which boundaries must not be crossed.** State prohibitions explicitly, such as "no real internal project names or ports in examples." Boundaries are the most frequently omitted part of a Skill and the most common source of incidents.

Skills with all four share one trait: **they read equally well to humans and to the Agent.** Because you can understand what it does, you can correct it precisely when it goes wrong — which is the precondition for being correctable at all.

---

## 5. Three stages that make accumulation pay off

Capture is not a single action; it is an ordered process. Skipping a stage lowers quality.

**Stage one: prove the procedure in real work first.** Do not write Skills from imagination. A procedure never run against a real task will only cement mistakes when captured. Do it once, and note the corrections along the way.

**Stage two: capture steps that are stable and reusable.** Note both qualifiers — **stable** (it will not change next week) and **reusable** (it applies beyond this one edge case). A one-off procedure is not worth capturing; maintenance will cost more than it returns.

**Stage three: update Skills when the product, tools, or policies change.** This is the stage most often skipped. A Skill written six months ago that references a moved entry point or a since-adjusted limit will keep issuing outdated guidance. **Indefinitely reusing stale experience is more dangerous than having none**, because it carries the credibility of having been "proven."

A practical maintenance habit: when you find yourself repeatedly correcting a Skill's output by hand, it has expired. Update it rather than working around it.

---

## 6. Common pitfalls

| Pitfall | The problem | Do this instead |
|---|---|---|
| Storing behavioural rules as Memory entries | May not be recalled on a query miss, and gets washed out by later entries | Rules to `SOUL.md`, procedures to Skills |
| Writing broad triggers "to cover more" | Loads during unrelated tasks and interferes | Narrow to a specific situation |
| Steps without boundaries | Steps run correctly but may leak internal details or exceed limits | Add explicit prohibitions |
| Capturing many Skills but never pruning | Expired Skills keep issuing wrong guidance | Review periodically; update on change |
| Expecting autonomous improvement with no review | Behaviour becomes unpredictable and hard to diagnose | Adopt via `/skills pending` |
| Capturing one-off procedures | Maintenance costs exceed the benefit | Capture only stable, reusable procedures |

Row four deserves emphasis: **the value of a Skill library is not proportional to its size.** One expired Skill can cost more than ten good ones return, because it loads automatically and looks credible.

---

## 7. LightVela's approach: methods as user assets too

Hermes has made the Memory / Skill split engineering-ready, but it still targets people editing Markdown directly. LightVela runs a cloud-hosted model and does not expose user-facing filesystem operations, so the two kinds of accumulation work like this:

- **Skills come from public marketplaces** — every skill comes from Skills.sh and ClawHub, the skill marketplaces shared by OpenClaw and Hermes, so you do not write them from scratch.
- **Install and remove through conversation** — tell Hermes which skill to install and it handles it; removal works the same way. Verify availability in chat afterwards. Console-panel installation is coming soon.
- **Memory is viewable in the console** — the memory page shows what the Agent has retained and lets you adjust the capacity limit; additions and removals happen through conversation.
- **Stable across models and channels** — switching models does not clear skills or automations, and every connected channel shares the same skills and memory.
- **Failures are traceable** — when a skill misbehaves, view and export recent logs in Diagnostics (selectable 1, 3, 6, 12, or 24-hour ranges) to locate the problem.

In other words, using an Agent on LightVela means accumulating two things: a Memory about you, and a set of installed, verified Skills. **Both serve you longer than any particular model does.**

---

## Key points

- Getting better with use comes from structured accumulation, not mysterious self-upgrading.
- Two kinds must stay distinct: **Memory** stores facts (recalled on query match), **Skills** store methods (loaded on situation match).
- When you keep correcting the same behaviour, capture a Skill rather than adding another fact.
- `/learn` captures methods while details are fresh; `/skills pending` provides review, so **self-improvement is not unbounded self-modification**.
- A sound Skill states four things: **when to use it, the steps, the success criterion, and the boundaries**.
- Capture runs in three stages: prove in real work → capture stable reusable steps → update on change. **An expired Skill is more dangerous than none.**

