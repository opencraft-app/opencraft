## Summary

**You can replace Hermes Agent's "brain", but that replaces the model layer, not the agent itself.**
The model understands and generates.
The agent layer owns goals, tools, memory, persona, channels, and scheduling.
Changing models normally does not delete `SOUL.md`, `USER.md`, or `MEMORY.md`, although it can change how the agent reasons, uses tools, and communicates.

---

## What actually changes when you switch models?

The model is the agent's immediate reasoning engine.
It determines how a request is interpreted, planned, and answered.
But a long-running agent also needs durable identity, memory, capabilities, delivery channels, and scheduled work.

## 1. The model layer decides how this turn is handled

The model affects reasoning quality, speed, language, and tool-use judgment.
It is not the user profile, task scheduler, or durable knowledge store.

| A model switch can affect | A model switch does not directly delete |
| --- | --- |
| Reasoning quality and speed | User preferences and long-term memory |
| Tool use and writing style | Persona rules |
| How new sessions respond | Connected channels and files |

## 2. The agent layer makes reasoning persistent

The agent layer places a model inside a system that can keep working.
It manages identity and persona, Memory and Skills, messaging channels, and automations.
Those independent layers let the working context survive a model change.

## 3. Automations deserve a separate check

Normal chat uses the current model configuration.
Scheduled jobs can record a concrete model when they are created.
When LightVela switches models, it can offer to synchronize unfinished automations so a future run does not unexpectedly stay on the old model.

## Conclusion

Switching models is not an agent "mind wipe".
It changes the reasoning engine while preserving the durable assets that make the agent yours.

Next: [How one agent appears across multiple messaging apps](./07-message-gateway.md).
