# Model Switching

## Summary

**Model switching lets you choose which of your configured models the Hermes Agent currently uses. When a task calls for different speed, capability, cost profile, or provider availability, you switch models instead of creating a new agent. This works because persona, memory, skills, and scheduled tasks are all stored outside the model, so changing models only swaps the reasoning engine — nothing is taken away or wiped, and the agent still remembers you. Each agent has exactly one active model at a time.**

---

Model Switching lets you choose which configured model your Hermes Agent uses for its next work. Switch when a task needs a different balance of speed, capability, cost, or provider availability—without creating a new Agent.

## This page covers

- Preparing more than one usable model
- Selecting the active model for an Agent
- Verifying the change in Chat
- Troubleshooting a model that does not appear or cannot respond

> **Good to know:** An Agent uses one active model at a time. Switching the active model does not erase the Agent's memory, Cloud Storage files, skills, or scheduled tasks.

## Before you start

1. Open the Agent you want to update.
2. Make sure the target model has already been configured and is available to your account. If not, follow [Configure Models](./model.md) first.
3. Keep a simple test prompt ready so you can confirm the new model responds as expected.

## Switch the active model

1. Open **Agents** and select the Agent.
2. Open the **Models** section.
3. Choose the configured model you want the Agent to use.
4. Save or apply the change, then wait for the Agent to finish updating its active configuration.

![The model provider selector in the LightVela console](../images/4-1-en.webp)

If you are choosing a model for the first time, use [Configure Models](./model.md) to add a supported provider or custom model before returning here.

## Verify the change

Open [Chat](./agent-chat.md) and send a short, low-risk prompt, for example:

```text
Reply with the name of the current model if it is available, then summarize this sentence in one line: Model switching is ready.
```

Confirm that the Agent responds normally and that the model shown in the Agent console is the one you selected. If the first reply takes a little longer while the Agent updates, wait briefly and retry once before making another change.

## Choose the right time to switch

| Situation | What to consider |
| --- | --- |
| You need a faster first draft | Choose a configured model that fits short, routine tasks. |
| A task needs stronger reasoning or code help | Choose a model you have configured for that kind of work. |
| A provider is unavailable or rate-limited | Switch to another configured model, then test it in Chat. |
| You are comparing output quality | Run the same small prompt after each switch and compare the result. |

Model Switching changes the engine used for future responses. It does not move your conversation history, rewrite files in [Cloud Storage](./files.md), or change your [Skills](./skill.md) and [Scheduled Tasks](./automation.md).

If you want to explore a separate plugin-first agent environment alongside Hermes Agent, see [DeepSeek Harness](./deepseek-harness.md).

## If a switch does not work

1. Return to [Configure Models](./model.md) and confirm the target model, credentials, and provider settings are complete.
2. Confirm that the model is available to your account and has sufficient provider quota or credits.
3. Select a known-working model and test it in Chat.
4. If the Agent still cannot respond, open [Diagnostics](./diagnostics.md) and review recent logs before resetting its model configuration.

> **Tip:** Change one thing at a time. Testing after each switch makes it much easier to tell whether the issue is the model, its configuration, or the task itself.

## FAQ

### Why is the model I want not listed?

Only configured models can be selected. Add or complete the model in [Configure Models](./model.md), then return to the Models section.

### Does switching models clear my Agent's memory?

No. The active model changes, while the Agent's memory and saved setup remain in place. You can review memory separately in [Memory](./memory.md).

### Can I switch back if I do not like the result?

Yes. Select another configured model, apply the change, and test it with the same prompt. Keeping the prompt consistent gives you a more useful comparison.

## Next steps

- Set up additional providers in [Configure Models](./model.md).
- Use [Chat](./agent-chat.md) to compare model responses on a real task.
- Use [Diagnostics](./diagnostics.md) if a configured model repeatedly fails to start.
