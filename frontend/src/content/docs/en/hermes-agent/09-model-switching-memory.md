## Summary

**Switching models does not automatically make Hermes Agent forget you because the model, persona, and memory are separate assets.**
The model decides how to reason.
`SOUL.md` defines role and expression boundaries.
`USER.md` and `MEMORY.md` retain the user profile and cross-session facts.
The separate item to inspect is an automation that has pinned an older model.

---

## If the answer sounds different, did memory disappear?

After a model switch, wording, speed, and tool choices can change noticeably.
That can feel like "it no longer knows me".
Changed behavior and lost persistent data are different things.

## 1. Three layers answer three different questions

| Layer | What it owns | State after a model switch |
| --- | --- | --- |
| Model | Reasoning and generation | Replaced |
| Persona | Role, tone, and boundaries | Preserved |
| Memory | Preferences, facts, shared history | Preserved |

The new model interprets the same context differently, so the experience can change.
It does not clear those independent files merely by being selected.

## 2. Why it can still feel different

Models differ in instruction following, context handling, tool use, and writing habits.
If a new model is briefer or cites less background, it can appear forgetful.
Confirm that Memory and Persona are intact before deciding whether the new model fits the task.

## 3. A post-switch checklist

1. Test a known preference in normal chat.
2. Confirm that the persona still behaves as intended.
3. Review unfinished automations for an old pinned model and decide whether to synchronize them.

## Conclusion

The model is a replaceable reasoning engine.
Persona and memory are the persistent layers that keep the agent recognizably yours.

Next: [Where Hermes Agent's personality comes from](./10-persona-user-memory.md).
