# Automations

## Summary

Automations let Hermes Agent proactively run work on a fixed time, interval, or one-time schedule, then send the result to the selected notification channels. You can start from a template, or customize the name, run rules, task instructions, effective window, and notification settings, then continue managing the task status from the task list.

When creating or editing an automation, you can also link it to an upstream task. Later runs use the upstream task's most recent completed output as additional context. This is useful for splitting workflows such as “collect information first, then summarize it” into multiple steps.

Automations let Hermes Agent run specified work on a preset schedule or trigger condition, so you do not have to repeat the same operations manually. Typical scenarios include scheduled reminders, daily report generation, news tracking, and content publishing.

Each task supports flexible scheduling and run rules, so your AI assistant can keep working proactively.

## What This Page Covers

- Adding an automation
- Linking an upstream task
- Using task templates
- Managing automations

## Adding an Automation

- **Name**: Name the automation plan.
- **Schedule**: Set the task cadence. Choose one of fixed weekdays, fixed interval, or one-time run.
- **Task instructions**: Write the prompt the agent uses to carry out the automation.
- **Upstream task**: Optional. Once linked, this task uses the upstream task's most recent completed output as context at run time.
- **Effective window**: Limit the time range in which the task can run. Leave it empty to keep it active around the clock.
- **Notification**: Optional toggles for selecting the channels that receive task execution notifications.

## Linking an Upstream Task

An upstream task is useful when one piece of work should be split into a stable multi-step flow:

1. The first task collects or generates base material.
2. The second task links to the first task and continues organizing, filtering, or rewriting based on its most recent completed output.
3. Later tasks can keep linking to the previous step to form a clear processing chain.

Common examples:

- Collect candidate information every morning, then let a downstream task generate a concise daily report.
- Summarize weekly project progress first, then let a downstream task create a team-facing version.
- Summarize to-do items first, then let a downstream task reorder them by priority and generate reminder copy.

Linking an upstream task does not copy or merge two task configurations. The current task still runs according to its own schedule, task instructions, effective window, and notification settings; it simply receives the upstream task's most recent completed output as additional context. Hermes `context_from` supports referencing one or more task IDs. If the product page currently exposes a single upstream-task selector, configure only what the page allows. Chained tasks do not wait for upstream tasks that are still running in the same scheduler tick, so the upstream and downstream schedules should be staggered.

The task instructions still need to explain how to use the upstream output. For example: “Based on the candidate news from the upstream task, keep only five items related to AI Agent products and write a Chinese summary.” Avoid writing only “continue processing,” because that makes it hard for the downstream task to know what to process.

## Task Templates

If you are not sure what automation to configure, click “Templates” to choose a ready-made automation plan.

## Managing Automations

After an automation is created, you can view enabled tasks on the “Automations” page.

From this page, you can inspect automation details, edit the task, pause it, or delete it as needed.

For linked tasks, check whether any downstream task still depends on the upstream task's most recent completed output before deleting the upstream task.

## Validation

After creating or editing an automation, do not stop at “saved successfully.” Confirm the following:

1. The task appears in the automation list, and its status matches expectations.
2. The schedule, effective window, and notification settings are correct.
3. If an upstream task is linked, the upstream task already has a most recent completed output.
4. After one real run, inspect the recent run record.
5. Check whether the output actually used the upstream task result instead of guessing the missing background.

## Common Failure Handling

| Symptom | Possible Cause | Suggested Handling |
|---|---|---|
| The downstream task did not use the upstream result | No upstream task was linked, the upstream task has no completed output yet, or both tasks ran in the same scheduler tick | Select the upstream task again, run the upstream task successfully once, and schedule the downstream task after it |
| The output misses the point | The task instructions rely too much on vague references such as “just now” or “the content above” | Write the goal, scope, output format, and how to use the upstream output clearly |
| The chained workflow becomes messy over time | One task handles too many steps, or the upstream and downstream responsibilities are unclear | Split the workflow so each task owns one clear step |
