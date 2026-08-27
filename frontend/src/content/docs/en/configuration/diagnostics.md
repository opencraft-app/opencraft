# Diagnostics

## Summary

**The diagnostics center is where you troubleshoot a misbehaving Hermes Agent. In one place you can view and export recent logs, reset the model configuration, or reinstall the agent while keeping your data. When the agent stops replying, replies strangely, or a channel connection fails, check here first: read the logs to determine whether it is a failed model call, a dropped channel, or a skill error, then take the matching action. Reinstalling preserves your data, so accumulated memory is not lost.**

---

Diagnostics helps you investigate an Agent that is not behaving as expected. From one place, you can review recent Hermes Agent logs, export them for sharing, reset model configuration, or reinstall the Agent while keeping its data.

## This page covers

- Viewing and exporting recent logs
- Resetting a broken model configuration
- Reinstalling an Agent while keeping its data
- Knowing when to use recovery options and when to ask for help

> **Use Diagnostics deliberately:** Start with logs and the smallest safe action. Resetting configuration or reinstalling an Agent is best reserved for a persistent issue.

## Before you start

1. Open the Agent that is having trouble.
2. Note what happened, when it started, and whether it affects Chat, a connected channel, or one specific task.
3. If a model is failing, review the current setup in [Configure Models](./model.md) before resetting anything.

## Open Diagnostics

1. Open **Agents** and choose the affected Agent.
2. Open the **Diagnostics** section.
3. Select a time range for recent logs: 1, 3, 6, 12, or 24 hours.
4. Select **Refresh** to load the logs.

![Diagnostics in the LightVela console](../images/diagnostics-overview-en.png)

Start with the shortest useful period. A narrower log window makes it easier to connect an error with the action that triggered it.

## Review and export logs

Use the log output to confirm whether the Agent was running and to identify the time of a failure. You can export the current log range as a file when you need to keep a record or share it with your support contact.

When reporting a problem, include:

- the approximate time it occurred;
- what you asked the Agent to do;
- the selected log range; and
- the relevant error message, without including secrets or API keys.

## Repair a model configuration

If the Agent cannot use its configured model and the issue remains after checking the provider, model selection, and credentials, select **Reset model configuration** in Diagnostics.

This restores the Hermes Agent model configuration so you can set it up again. After it finishes:

1. Return to [Configure Models](./model.md).
2. Add or select the model you want to use.
3. Send a short test message in [Chat](./agent-chat.md).

> **Caution:** Reset the model configuration only when you are ready to configure a working model again. It is not the first response to a temporary provider or network issue.

## Reinstall an Agent while keeping data

For an issue that continues after reviewing logs and model settings, Diagnostics offers **Reinstall Agent (keep data)**. This starts the Hermes Agent reinstall process while preserving its data.

1. Read the action description in Diagnostics.
2. Start the reinstall and keep the page open while the status changes.
3. When it completes, reload the Agent console.
4. Test a simple task in Chat, then check Cloud Storage and your usual setup.

![The Agent reinstall confirmation dialog](../images/diagnostics-reinstall-en.webp)

An Agent can be briefly unavailable during maintenance. Avoid starting another repair action while the reinstall is still in progress.

## Backup and recovery, when available

Some accounts show a **Backup & Recovery** panel in Diagnostics. If it is available to you, follow the instructions shown in your console to create a backup or restore a compatible Hermes backup package. Do not assume this option is available for every Agent or account.

Before restoring, keep a copy of any files you cannot replace. [Cloud Storage](./files.md) is a good place to review the Agent's current files first.

## Verify the fix

The issue is likely resolved when:

- recent logs load without a repeated failure;
- the Agent can respond to a simple test in Chat; and
- the model and files you expect are available again.

If the same error returns, export the relevant logs and record the time of the next occurrence before escalating it.

## FAQ

### Which log range should I choose?

Choose the shortest range that includes the problem. Use a longer range only when the issue started earlier or happens intermittently.

### Will reinstalling erase my Agent's data?

The Diagnostics action is labelled **Reinstall Agent (keep data)** and is designed to preserve data. Still, avoid interrupting the maintenance process and verify the Agent after it completes.

### Should I reset the model configuration for every model error?

No. First check [Configure Models](./model.md) for the selected model and credentials, then confirm the provider is available. Reset only when the configuration itself needs to be rebuilt.

## Next steps

- Return to [Chat](./agent-chat.md) to test the repaired Agent.
- Review [Configure Models](./model.md) or [Model Switching](./multiple-models.md) for model-related issues.
- Check [Cloud Storage](./files.md) if a task depends on files that are missing or inaccessible.
