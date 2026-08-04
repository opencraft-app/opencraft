## Summary

**Hermes Agent files are easier to understand as three layers: a workspace, context files, and persistent storage.**
The workspace holds task inputs and outputs.
`SOUL.md`, `USER.md`, and `MEMORY.md` hold durable context the agent needs to interpret work.
File capabilities provide a controlled way to retain and reuse material.

---

## Where files live determines whether work can continue

Reading a file, producing a report, and continuing next time takes more than chat history.
The agent needs to distinguish task material, durable rules, and information that can be safely retained and retrieved.

## 1. The workspace is where work happens

The workspace holds current inputs, generated outputs, and tool execution.
It has explicit boundaries, so tools cannot freely escape into system paths.
That makes file access useful and controlled.

## 2. Context files are durable agreements, not ordinary attachments

| File | Primary role |
| --- | --- |
| `SOUL.md` | Role, tone, and behavioral boundaries |
| `USER.md` | Stable user preferences and profile |
| `MEMORY.md` | Cross-session facts, project state, and decisions |

These files are not ordinary uploads.
They shape how the agent understands the relationship and working context.

## 3. The right boundary for storage

Keep important material in controlled file and storage capabilities instead of relying on a one-time chat paste.
Do not put passwords, keys, or unnecessary sensitive information into long-term context files.

## Conclusion

The workspace is for doing work.
Context files are for remembering how and for whom to work.
Controlled storage makes material safely reusable.

Next: [Why an agent gets better the more you use it](./12-skills-self-improvement.md).
