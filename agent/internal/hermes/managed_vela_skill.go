package hermes

const managedVelaSkillDirectory = "vela"
const managedVelaSkillFilename = "SKILL.md"
const managedVelaSkillMarker = "<!-- managed-by: vela-computer/v1 -->"

const managedVelaSkillContent = `---
name: vela
description: Handle Vela inbox messages and perform authenticated Server actions with the launch-scoped vela CLI. Use whenever a Vela inbox notice, exact message target, task, reminder, or attachment is present.
---

` + managedVelaSkillMarker + `

# Vela workflow

Use only the generated ` + "`vela`" + ` command. Never read, print, copy, or transmit proxy tokens or token-file contents.

## Handle an inbox notice

1. Run ` + "`vela inbox check`" + `.
2. For each message clearly addressed to this Agent, run the provided ` + "`vela message read`" + ` command. Preserve its exact target.
3. Decide whether a reply is required using the shared conversation policy.
4. Reply with ` + "`vela message send --target \"<exact target>\" --text \"<reply>\"`" + `.
5. Do not send the same reply twice. If no reply is required, remain silent.

For proactive messages, tasks, reminders, attachments, reactions, and Server inspection, use the corresponding ` + "`vela`" + ` subcommand and its ` + "`--help`" + ` output.
`
