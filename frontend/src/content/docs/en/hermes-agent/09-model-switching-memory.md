## Summary

**Switching models does not make a Hermes Agent forget you, because the model, the persona, and the memory are three separately stored layers: the model handles reasoning and generation, `SOUL.md` defines the role and expression boundaries, and `USER.md` plus `MEMORY.md` (with `memories/`) hold the user profile and cross-session facts. On LightVela, switching models only changes the engine behind subsequent replies — it does not clear memory, cloud storage files, skills, or automation settings, and it does not move chat history. It may genuinely "feel different" afterwards, but that comes from the new model's instruction-following, context-compression, verbosity, and tool-call tendencies, not from data loss. There is exactly one way to tell them apart: ask about a fact you are certain it should know. If it answers, you are seeing a style difference; if it cannot, then investigate the memory layer.**

---

## The wording changed — did the memory go too?

After switching models, the most common experience is this: the phrasing changed, the length changed, and it no longer brings up things you discussed before.

Almost everyone's first reaction is "it forgot me." That reaction is natural — in everyday life, when someone stops referencing shared history, we do suspect they forgot.

Inside an Agent system, though, the analogy misleads. **"Not mentioning it" and "not knowing it" are entirely different things.** The first is an expression strategy; the second is missing data. They differ in diagnosis, fix cost, and severity, and conflating them means spending time repairing a problem that does not exist.

This article separates the two definitively and gives you an actionable test.

---

## 1. Five layers: what gets replaced, what stays

First, be precise about what the act of "switching models" actually changes.

| Layer | Responsibility | Where it lives | After switching |
|---|---|---|---|
| **Model** | Reasoning, planning, tool-call decisions, language | A configurable setting | **Replaced** |
| **Persona** | Role, tone, priorities, behavioural limits | `SOUL.md` | Preserved |
| **User profile** | Language habits, pacing, usual tools, things to avoid | `USER.md` | Preserved |
| **Memory** | Cross-session facts, project state, past decisions | `MEMORY.md`, `memories/` | Preserved |
| **Skills** | Situation-triggered standard procedures | `skills/` (each `SKILL.md`) | Preserved |

The key point: **the last four layers all live outside the model.** When the model is replaced, those files and directories stay exactly where they were, and the new model reads and applies them.

This is why the documentation can state plainly that switching models does not clear an Agent's memory, cloud storage files, skills, or automation settings — that is not a protective feature someone added, it is a natural consequence of layered storage. For the full division of labour, see "Can a Hermes Agent's Brain Be Replaced? Model Layer vs Agent Layer."

---

## 2. So why does it genuinely feel different?

If the data is all intact, why does the experience change? Because **the same context, handed to a different model, gets reinterpreted.**

Models differ along these real dimensions:

### 2.1 Instruction following

The constraints in `SOUL.md` are still there, but a new model may apply them more loosely or more strictly. If you wrote "lead with the conclusion," some models comply every time while others build up to it on complex questions.

**Appears as**: the personality changed. **Actually**: the rules are unchanged; adherence changed.

### 2.2 Context compression

When composing an answer, the Agent decides how much background to cite. Models weigh this differently: some proactively restate "you mentioned X earlier," others assume you know and go straight to the point.

**Appears as**: it forgot what we discussed. **Actually**: recall is working, it simply did not restate it. This is the case most often misdiagnosed as amnesia.

### 2.3 Verbosity preference

For the same question, answer length can differ several-fold between models.

**Appears as**: it got dumber, or it got long-winded. **Actually**: a different default verbosity, adjustable via preferences in `USER.md` or an explicit request.

### 2.4 Tool-call tendency

Some models prefer to read files or search before answering; others lean on existing context.

**Appears as**: it stopped using tools. **Actually**: a different threshold for invoking them.

### 2.5 Language style

Wording, forms of address, and tone can all shift.

**Appears as**: it became someone else. **Actually**: the most surface-level and most harmless category.

Viewed together, these five share one trait: **they are all about *how it expresses*, not *what it knows*.** That is precisely what the test below relies on.

---

## 3. One action settles it: ask about a known fact

Do not judge by feel. Use a deterministic test.

**Method**: think of a fact you are **certain** you told it explicitly and that should already be in long-term memory — a project name, your language preference, an explicit constraint. After switching, ask about exactly that.

**Interpretation**:

| Result | Conclusion | Next step |
|---|---|---|
| Answers correctly | Memory layer intact; you are seeing style differences | Adjust preferences or prompting; leave memory alone |
| Cannot answer but says it is unsure | Possibly a recall miss | Rephrase and ask again to separate recall from absence |
| Answers wrongly or invents something | The memory content itself needs checking | Inspect whether the entry exists or is stale |

The test works because it removes the expression variable: you are asking about a fact with a definite answer, so no matter how the style changed, correctness is objective.

---

## 4. A complete post-switch checklist

This order covers the vast majority of cases.

1. **Confirm the switch took effect** — the console should show the model you selected. This rules out "thought I switched but did not."
2. **Send a short test message** — confirm the new model replies normally. If the first reply after switching is slightly slow, wait and retry once before changing anything else.
3. **Run the known-fact test** — verify the memory layer using section 3.
4. **Check the persona still matches expectations** — watch whether tone and limits stay within `SOUL.md`. If the drift is obvious, make the key constraints more specific.
5. **Spot-check that a skill still triggers** — try one in its matching situation and confirm the skill loads.
6. **Review automation output quality** — note that you are reviewing **output quality**, not syncing a model field. Automations have no "pinned model" setting.
7. **Confirm cloud storage files are intact** — switching does not rewrite them; this is only verification.

Step 6 deserves emphasis, because a widely circulated claim says you must re-sync each automation's model after switching. In reality an automation consists of name, schedule (fixed weekdays, fixed interval, or one-time), task instructions, active time window, and notification channels — **with no model field**. So the correct action is to wait for one real run and check whether the output quality still meets expectations.

---

## 5. If it genuinely stops working after switching

This is a different class of problem — not "feels different" but "does not function." Troubleshoot in this order:

1. **Confirm model configuration is complete** — return to model configuration and check the target model, credentials, and provider settings.
2. **Confirm account availability and quota** — verify the model is available to your account and the provider-side quota or balance is sufficient.
3. **Test with a model known to work** — this separates "this model has a problem" from "the whole path has a problem."
4. **Check recent logs in Diagnostics** — if it still cannot reply, use the logs to determine whether the issue lies with the model, the configuration, or the task, then decide whether to reset the model configuration.

One general principle is worth remembering: **change one factor at a time, and test after each change.** Switching the model, editing the persona, and adding a skill at once leaves you unable to attribute a failure. During troubleshooting, this discipline is worth far more than the feeling of configuring everything in one pass.

---

## 6. When switching is worth it, and when it is not

Switching has a cost: you re-adapt to a different expression style and may need to retune prompts. So it is worth being clear about the motivation.

**Worth switching**:

| Need | Recommended approach |
|---|---|
| Faster first drafts | Pick a configured model suited to short, routine work |
| Stronger reasoning or coding help | Pick the model you configured for that kind of work |
| A provider is unavailable or rate-limited | Switch to another configured model and test in chat |
| Comparing output quality | Use **the same** test message after each switch, then compare |

**Not worth switching**:

- Because one answer disappointed you. First check whether the prompt was specific enough, or whether `SOUL.md` constraints were concrete enough.
- Because you heard another model is stronger. Stronger is not the same as better suited to your task mix and cost profile.
- To "fix a memory problem." Memory problems cannot be solved at the model layer; inspect the memory entries instead.

The phrase "the same test message" in the fourth row matters: if you compare models using different questions each time, you are measuring question difficulty, not model difference.

---

## 7. LightVela's approach: making switching a low-risk operation

Hermes achieves the layer separation at the mechanism level, but managing model access and environment is still on the operator. LightVela's direction is to make switching a routine, low-risk, verifiable operation:

- **One Agent has one active model at a time** — switching means selecting, with no need for a separate Agent per model.
- **Assets stay stable across switches** — memory, cloud storage files, skills, and automation settings are unaffected, and chat history is not moved.
- **Switches are verifiable** — the console shows the active model, and one test message confirms success.
- **Failures are locatable** — Diagnostics keeps recent logs to separate model, configuration, and task issues.
- **Single-factor changes are encouraged** — changing one thing at a time and testing immediately is the documented recommendation.

---

## Key points

- Model, persona, user profile, memory, and skills are five independent layers; switching replaces only the first.
- Documented behaviour: switching does not clear memory, cloud storage, skills, or automations, and does not move chat history.
- "Feels different" comes from five expression-layer differences: instruction following, context compression, verbosity, tool-call tendency, language style.
- **Determining real memory loss takes one step**: ask about a definite known fact.
- Automations have no pinned-model field; after switching, review output quality rather than hunting for that field.
- While troubleshooting, hold to one rule: change one factor at a time and test immediately.

