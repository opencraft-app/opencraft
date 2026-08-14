## Summary

**A Hermes Agent's "brain" can be replaced, but what gets replaced is only the model layer, not the whole Agent. The model layer decides how to think this time — parsing the request, planning steps, choosing which tool to call, and phrasing the answer. The Agent layer keeps that thinking going over time: identity (`SOUL.md`), user profile (`USER.md`), cross-session facts (`MEMORY.md` and `memories/`), captured methods (`skills/`), messaging channels, automations, and the working directory all live outside the model. That is why switching models does not delete them. On LightVela, one Agent uses exactly one active model at a time, and switching models does not clear memory, cloud storage files, skills, or automation settings — it only changes the engine behind future replies. If an Agent feels like a stranger after a switch, the cause is almost always different instruction-following, context-compression, and phrasing behaviour in the new model, not lost memory.**

---

## Why this question keeps coming up

"Can I move my Agent to a stronger model?" is one of the most common questions people ask about Agent products. The follow-up arrives immediately: "Will it still remember me?"

Asking both together reveals a widespread misconception — that the model and the Agent are the same thing. In that mental model, an Agent is just a chat interface wrapped around an LLM, so replacing the model means replacing the whole assistant, and starting over feels inevitable.

If that were actually true, no Agent could ever hold long-term value. The project context you explained last week, the tone you tuned carefully, the workflow you captured — all of it would reset with every technical upgrade. That is not a product anyone can rely on.

Hermes Agent is built on the opposite premise: **the model is a replaceable component, and the Agent is the thing that persists.** This article unpacks what that actually means in practice.

---

## 1. Separate three things first: model, runtime, long-term assets

Before discussing model switching, it helps to recognise that an Agent contains at least three layers with very different lifecycles.

| Layer | What it is | Lifecycle | On model switch |
|---|---|---|---|
| **Model layer** | The LLM providing reasoning and generation | Configurable, replaceable at any time | Replaced |
| **Agent runtime** | The process running tools, channel I/O, and scheduling | Long-running | Unchanged |
| **Long-term assets** | `SOUL.md`, `USER.md`, `MEMORY.md`, `memories/`, `skills/`, working-directory files | Accumulated over time | Unchanged |

Most people only see the first layer and the chat window, missing the runtime in the middle and the asset layer underneath. Yet those two lower layers are exactly what makes an Agent recognisably "the same one" over months of use.

A useful analogy: the model is how a person thinks right now, the runtime is that person's body and hands, and the long-term assets are their identity, memories, and professional habits. Changing how someone thinks does not make them a different person, because identity and memory did not change with it.

---

## 2. The model layer: responsible for "how to think this time"

Within a single exchange, the model layer does more than produce text. It decides at least four things:

1. **Interpretation** — turning your message into a concrete goal, including constraints you implied but did not spell out.
2. **Planning** — judging how many steps the work needs, which comes first, and whether research must precede action.
3. **Tool-call decisions** — deciding whether to read a file, search the web, or run a command, and with which arguments.
4. **Expression** — organising the result into readable language, including how much detail to include and which format to use.

All four belong to *this* inference pass. They shape your immediate experience directly, which is why switching models produces noticeable changes in feel.

Equally important is what the model layer does **not** own:

- The model is not your database. It does not store your preferences, project state, or past conclusions.
- The model is not a scheduler. It has no knowledge that something must run every morning at seven.
- The model is not a channel manager. It does not decide which Telegram conversation a reply returns to.

All of those capabilities live outside the model. That is the technical basis for "switching models is not switching Agents."

---

## 3. The Agent layer: responsible for making thinking continuous

The Agent layer's responsibilities fall into five groups, organised by the problem each one solves.

### 3.1 Identity and behavioural rules: `SOUL.md`

`SOUL.md` defines who this Agent is, what tone it works in, how it prioritises, and what it will not do. It is a stable set of rules, not a mood improvised per conversation.

After a model switch, `SOUL.md` is still exactly where it was. The new model reads and applies the same rules — **it may follow them more loosely or more strictly, but the rules themselves did not change**. That distinction is the key to understanding the "it feels different" section later.

### 3.2 User profile: `USER.md`

`USER.md` holds stable information about you: language habits, preferred communication pace, tools you use regularly, explicit things to avoid. It saves the Agent from asking "do you want the long version or the short one?" every single time.

### 3.3 Cross-session facts: `MEMORY.md` and `memories/`

This layer stores facts and conclusions that already happened and were judged worth keeping: what the project is called, what was decided last week, why a parameter is set the way it is. Hermes builds a SQLite + FTS5 full-text index over these entries and recalls matching ones when you raise a related topic, rather than stuffing full history into context.

Memory is not append-only forever. It is maintained through atomic `add` / `replace` / `remove` operations and can be reviewed via `/memory pending`. For the full design, see "Why More Memory Is Not Better: How Hermes Agent Selects, Curates, and Updates Long-Term Memory."

### 3.4 Captured methods: `skills/`

`skills/` stores standard procedures for "when situation X happens, do this." Each `SKILL.md` typically carries YAML frontmatter declaring its trigger conditions. This is procedural memory, a separate pathway from declarative Memory — see "Memory Is Not a Skill: How Hermes Agent Separates Factual and Procedural Memory."

### 3.5 Connectivity and scheduling: channels, automations, working directory

- **Channels** determine which entry points the Agent receives messages from and where results are delivered.
- **Automations** determine what work it completes when you are not asking anything.
- **The working directory** determines where task inputs and outputs live, and where the boundary sits.

All three are Agent-layer configuration, independent of which model is currently active.

---

## 4. Why decoupling is necessary: four practical reasons

Separating model from Agent is not architectural purism. It produces concrete benefits.

**Reason one: models improve far faster than personal assets accumulate.** A meaningfully stronger model may ship within months, while your shared memory, preferences, and workflows build up slowly. If the two were coupled, every upgrade would cost you that accumulation — and users would simply refuse to upgrade.

**Reason two: different tasks need different models.** Fast drafting and heavy reasoning are not necessarily the same model. Decoupling lets you switch per task instead of maintaining a separate Agent, with a separate memory, for each kind of work.

**Reason three: provider availability is never guaranteed.** When a provider rate-limits, errors, or changes policy, you need to move to another configured model immediately. If memory were tied to the model, that switch would carry an unacceptable cost.

**Reason four: ownership becomes unambiguous.** Because memory and skills live in independent files and directories, they are **your assets** rather than an accessory of one particular model. This is what makes the phrase "training your own Agent" meaningful in the first place.

---

## 5. What actually happens when you switch models on LightVela

The sections above describe mechanism. This one describes real product behaviour.

**One Agent uses exactly one active model at a time.** Switching means selecting which configured model is currently active — it does not create a new Agent. You do not need multiple Agents just to use multiple models.

**Switching does not clear memory, cloud storage files, skills, or automation settings.** A model switch changes only the engine used for subsequent replies. It does not move chat history, rewrite files in cloud storage, or alter skill and automation configuration.

**Preparing for and confirming a switch**, following the documented flow:

1. Confirm the target model is already configured and available to your account. If it is not configured yet, complete model configuration first.
2. Prepare a short test message to verify the new model replies normally.
3. After switching, send that test message in chat and confirm both that the Agent replies and that the console shows the model you selected.
4. If the very first reply after switching is slightly slow, wait briefly and retry once before changing anything else.

**One correction to a common misconception**: an automation's configuration consists of name, schedule (fixed weekdays, fixed interval, or one-time — choose one), task instructions, active time window, and notification channels. **There is no "pin this automation to a specific model" field.** So the advice that you must go through your automations and re-sync their model after switching does not apply. What is worth reviewing after a switch is the quality of task output, not a model field that does not exist.

---

## 6. Why it "feels different" afterwards

This is the step most often misdiagnosed as amnesia. A change in behaviour and a loss of data are different problems, and confusing them sends you down the wrong debugging path.

Models genuinely differ along these dimensions:

| Dimension | How it shows up | Commonly misread as |
|---|---|---|
| Instruction following | Applies `SOUL.md` constraints more loosely or strictly | "Its personality changed" |
| Context compression | Volunteers less background information | "It forgot what we discussed" |
| Verbosity preference | Answers noticeably shorter or longer | "It got dumber / more verbose" |
| Tool-call tendency | Reads files or searches proactively more or less often | "It stopped using tools" |
| Language style | Different wording, address, and tone | "It became someone else" |

The test is straightforward: **ask about a fact you are certain it should know.** If you previously told it a specific project name or preference, ask about exactly that after switching. If it answers correctly, the memory layer is intact and you are seeing a style difference. If it genuinely cannot answer, then go check whether the memory files and entries are still there.

A practical rule: **change one factor at a time, and test after each change.** Switching the model, editing the persona, and adding a skill together leaves you unable to tell which layer caused a problem.

---

## 7. When switching models is worth it

Choosing by need is more useful than chasing whichever model is currently called strongest.

| Your need | Recommended approach |
|---|---|
| Faster first drafts | Pick a configured model suited to short, routine work |
| Stronger reasoning or coding help | Pick the model you configured for that kind of work |
| A provider is unavailable or rate-limited | Switch to another configured model and test in chat |
| Comparing output quality | Use the same short test message after each switch, then compare |

If the Agent cannot work after switching, troubleshoot in this order: confirm the target model's credentials and provider settings are complete → confirm the model is available to your account with sufficient quota → test with a model known to work → if it still fails, check recent logs in Diagnostics.

---

## 8. LightVela's approach: models as a choice, assets kept by the user

Hermes decouples model from Agent at the mechanism level, but it still targets people comfortable managing Markdown files and a local environment directly. LightVela's direction is to make that decoupling the default product experience:

- **The model is a switchable setting**, not a one-time decision locked in at setup.
- **Memory, skills, cloud storage, and automations are user assets** that stay stable across model switches, so upgrading never means starting over.
- **Switches are verifiable**: the console shows the active model, and a single test message in chat confirms the switch worked.
- **Failures are traceable**: Diagnostics keeps recent logs, which is how you tell whether a problem lies with the model, the configuration, or the task itself.

The result is that model progress reaches you directly, while what you have already accumulated never becomes the price of that progress.

---

## Key points

- An Agent has at least three layers: a replaceable **model layer**, a long-running **runtime**, and continuously accumulated **long-term assets**.
- The model layer handles interpretation, planning, tool calls, and expression for the current turn. It does not store preferences, run schedules, or manage channels.
- `SOUL.md`, `USER.md`, `MEMORY.md`, `memories/`, `skills/`, and the working directory all live outside the model, so switching models does not take them along.
- On LightVela, one Agent has one active model at a time; switching does not clear memory, cloud storage, skills, or automations.
- Automations have no "pinned model" setting, so the claim that you must re-sync automation models after switching is inaccurate.
- Feeling different after a switch usually comes from instruction-following, context-compression, and phrasing differences — not lost memory. Verify with one known fact.

