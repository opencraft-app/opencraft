## Summary

**A Hermes Agent can reach you on schedule not because it sits waiting in a chat window, but because a scheduled task saves three things — when to run, what to do, and where to send the result — as a configuration that can be scheduled repeatedly. When the time arrives, the scheduler starts an independent run: it does not replay an old conversation, it redoes the work from the task instructions and then delivers the output according to your notification settings. On LightVela a scheduled task consists of: name, schedule (fixed weekdays, fixed interval, or one-time — choose one), task instructions, active time window, and notification channels. One correction to a widespread claim: there is no "pin this task to a specific model" field, so the advice to re-sync scheduled task models after switching models does not apply. The part that determines reliability is the task instructions — because nobody is present to clarify at run time, the prompt must carry its own goal, boundaries, and output format.**

---

## "Proactive" does not mean permanently watching you

"Give me a news summary every morning" sounds like an ordinary instruction, but it differs fundamentally from "give me a news summary now."

The second is a conversation: you are present, so you can follow up, correct, and add context at any point. The first is **work that must execute while you are absent**: nobody confirms it understood correctly, nobody stops it when the output misses the mark, and nobody tells it where to send results so you will actually see them.

So the hard part of "proactive" is not the timed trigger — that is the easy piece. The hard part is this: **rewriting a conversation that depended on your presence into a work order that succeeds without it.** This article covers what that work order contains and how to write one that holds up.

---

## 1. What a scheduled task actually contains

Creating a scheduled task on LightVela involves these fields.

| Field | The question it answers | Notes |
|---|---|---|
| **Name** | What is this task called? | Used to identify it in the list; name it after the action, not "Task 1" |
| **Schedule** | When does it run? | Fixed weekdays, fixed interval, or one-time — choose one |
| **Task instructions** | What should be accomplished? | The prompt the Agent works from at run time |
| **Active time window** | During which hours is it valid? | Restricts when the task may run; leaving it empty means around the clock |
| **Notification channels** | Where does the result go? | Optional toggles selecting which channels receive execution notices |

**One point worth stating plainly: there is no "model" field.** A scheduled task is not pinned to a specific model, so the commonly repeated advice that you must review and re-sync each scheduled task's model after switching models does not apply to this product shape. What is worth reviewing after a model switch is output **quality**, not a field that does not exist. For the layering behind this, see "Can a Hermes Agent's Brain Be Replaced? Model Layer vs Agent Layer."

Also note that the schedule is a choice among fixed weekdays, fixed interval, and one-time — not an arbitrary cron expression. Knowing this upfront saves you from designing a cron-shaped schedule and then discovering there is nowhere to enter it.

---

## 2. Choosing among the three schedule types

The three modes serve three different needs, and picking the wrong one produces behaviour that does not match your expectation.

**Fixed weekdays** suits work tied to human rhythms or work cycles — summarising last week's progress on Monday morning, a Sunday reminder to water the plants. Its defining trait is that it is **anchored to a specific time**, which fits "I want to see this at that moment."

**Fixed interval** suits work where the timing does not matter, only the frequency — checking an information source every few hours. Its defining trait is that it **counts from the previous run**, which fits "I want it to keep this cadence."

**One-time** suits single events, such as a reminder on a specific date. It ends after running, with nothing to switch off afterwards.

A simple test when choosing: **does your requirement mention a clock time?** If yes, use fixed weekdays. If only a frequency, use fixed interval. If it happens once, use one-time.

---

## 3. What the active time window is for

This field is easy to skip, but it solves a real annoyance: **you want the task to keep a cadence, but not to disturb you during certain hours.**

The classic case is an interval task. Setting "every two hours" with no active window means it runs around the clock, including overnight. With an active window, it only runs during the hours you specify.

Leaving it empty means continuous operation. So if a task ran at a time it should not have, check this field first.

---

## 4. What actually happens when the time arrives

This is where misunderstanding is most common. Many people assume a scheduled task means "re-sending your original sentence to the Agent," and that assumption leads to prompts that lean too heavily on context.

What actually happens: when the scheduler reaches the target time, it **triggers an independent Agent run**. That run completes the work from the task instructions rather than replaying the conversation in which the task was created.

This has an important consequence: **the task instructions must carry their own context.** Background you held in your head while creating the task, or details you discussed earlier with the Agent, will not necessarily be applied at run time unless they were written into the instructions or already captured in long-term memory.

Compare two versions:

- **Context-dependent**: "Put together a summary like you just did." — At run time, "just did" no longer exists.
- **Self-contained**: "Summarise unread email from the past 24 hours, grouped by sender, at most three items per group, keeping only messages that need my reply; output a bulleted list with each item on one line."

The second runs reliably with nobody present, because the goal, scope, filter criteria, and output format are all inside it.

---

## 5. How to write task instructions that hold up

Given the mechanism above, reliable task instructions usually contain four parts.

**First, an explicit target action.** State what to *do*, not what to "keep an eye on." You cannot judge whether "keeping an eye on" completed; you can judge whether "summarise and list" completed.

**Second, explicit scope boundaries.** A time range (past 24 hours), a volume cap (at most three per group), a filter (only those needing my reply). Without boundaries, the same task can produce wildly different output on different days.

**Third, an explicit output format.** List or prose, grouped or flat, how long each item may be. Since you are not present, you cannot say "too long, shorten it" in the moment.

**Fourth, explicit exception handling.** If nothing matches, should it send "nothing to handle today" or stay silent? Without this, you cannot distinguish "the task did not run" from "the task ran and found nothing."

The fourth point is the one most often omitted, and it directly affects your ability to judge whether a task is healthy.

---

## 6. A recommended rollout order

Do not treat "create the task" as a single step. This order surfaces most problems early.

1. **Verify manually in chat first.** Send the prompt you intend to use directly to the Agent and check the output. This tunes the prompt without scheduling in the way.
2. **Revise the prompt based on that result.** Output too long, scope too broad, format unstable — fix all of it here.
3. **Create the task and set the schedule.** Use the test in section 2 to pick a mode.
4. **Confirm notification channels point somewhere you actually read.** Results delivered where you never look are equivalent to no results.
5. **Set an active time window if needed.** Especially for interval tasks, to avoid overnight interruptions.
6. **Wait for one real run, then review the run record.** This is the critical step — **do not treat "task created" as done.** A successful save means the configuration stored, not that the output is right.
7. **Refine the prompt once more based on that first real run.** Real execution can differ from manual testing, and this second revision usually delivers the biggest stability gain.

The product supports viewing task details, editing, pausing, and deleting from the task list, so step 7 is cheap. If a task is temporarily unnecessary, prefer pausing over deleting so the configuration remains available for reuse.

---

## 7. Common symptoms and where to look

| Symptom | More likely cause | Suggested action |
|---|---|---|
| Nothing happens at the scheduled time | Task paused, or current time falls outside the active window | Check task status and active time window |
| It ran but no result arrived | Notification channels unset, or delivering somewhere you do not read | Check notification configuration |
| Output length and format vary wildly | Instructions lack scope boundaries and output format | Add the four elements from section 5 |
| Output differs greatly from the manual test | Instructions relied on conversation context from creation time | Rewrite as self-contained instructions |
| Cannot tell "did not run" from "found nothing" | Instructions lack exception handling | Add "send a note even when there is nothing" |
| Disturbed overnight | Interval task has no active time window | Set an active time window |

A general principle when troubleshooting: **first separate "did not run" from "ran but produced the wrong thing."** The former points to task status, active window, and notification settings; the latter points to the instructions themselves. These have completely different resolution paths, and investigating them together wastes time.

---

## 8. LightVela's approach: proactive work that is configurable and reviewable

Hermes supports scheduled work at the mechanism level, but keeping the runtime and scheduling reliable is left to the operator. LightVela's direction is to make this a configurable, reviewable product capability:

- **Templates lower the starting cost** — when you are unsure what to automate, start from a ready-made template and adjust it.
- **Task lifecycle is manageable** — view details, edit, pause, or delete after creation, with no need to rebuild a task to change one condition.
- **Delivery is selectable** — notification channels are optional toggles, so results land where you actually read them.
- **Decoupled from other capabilities** — scheduled tasks, models, skills, and cloud storage are configured independently, and switching models does not alter scheduled task settings.
- **Failures are traceable** — combine execution anomalies with recent logs in Diagnostics to locate the cause.

---

## Key points

- A scheduled task is fundamentally a saved, repeatable configuration of when to run, what to do, and where to deliver.
- The fields are: name, schedule (fixed weekdays / fixed interval / one-time), task instructions, active time window, notification channels.
- **There is no "model" field**, so "re-sync scheduled task models after switching" is inaccurate; schedules are also not arbitrary cron expressions.
- The trigger starts an **independent run**, not a replay of an old conversation, so instructions must be self-contained.
- Reliable instructions contain four parts: target action, scope boundaries, output format, exception handling.
- The decisive rollout step is the last one: **wait for a real run and review the record**, rather than stopping at "task created."
