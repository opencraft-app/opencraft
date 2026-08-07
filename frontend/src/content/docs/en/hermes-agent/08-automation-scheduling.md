## Summary

**Hermes Agent reaches out on time because an automation stores when to run, what to do, and where to deliver the result.**
When a schedule is due, the scheduler starts an independent run and sends the outcome according to the job configuration.

---

## Proactive does not mean watching a chat window forever

"Send me a news summary every morning" sounds like one sentence.
It contains at least three contracts: when to run, what to do, and where the result goes.
An automation turns that one conversation into repeatable work.

## 1. A scheduled task is an explicit execution contract

An automation can include a name, prompt, schedule, delivery target, and sometimes a pinned model.
It can run once, at an interval, or on a Cron schedule.

| Field | Question it answers |
| --- | --- |
| Schedule | When does it run? |
| Prompt | What should the agent do? |
| Deliver | Where should the result go? |
| Model | Which reasoning engine runs it? |

## 2. What happens when it is due

At the scheduled time, the scheduler triggers a task run.
It does not mechanically replay an old chat.
It starts independent agent work and uses the job configuration to determine delivery.
Write the prompt with a clear goal, boundary, and output format.

## 3. Three habits for reliable automations

Validate the task manually first.
Then set the schedule and delivery channel.
Finally, inspect recent run records instead of assuming that a created job has succeeded.
After a model switch, decide whether unfinished automations should be synchronized too.

## Conclusion

Automations turn an agent from something that waits for a question into something that completes agreed work at an agreed time.

Next: [Will switching models make the agent forget you?](./09-model-switching-memory.md).
