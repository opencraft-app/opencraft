---
id: 2026-09-16-hermes-instance-upgrade
type: task
scope: Upgrade one explicitly selected LightVela Hermes instance to a backend that exposes Hosted Rooms.
triggers: ["single instance Hermes upgrade", "Hosted Rooms"]
owner: skipzhang
authority: task
status: active
reviewed_at: 2026-09-16
review_due: 2026-10-16
revision: 1.0.0
precedence: task
derived: false
---

## goal

Upgrade only instance `ins-a5083ca11a864760a1f3527a4689ad7f`, then prove its Hermes gateway exposes a running Hosted Rooms driver.

## non_goals

- No CVM image build, pool refresh, regional rollout, GitOps change, or modification of another instance.
- No direct database write, manual Profile creation/deletion, or OpenCraft bridge implementation in this task.
- No persistence of the supplied bearer/session credential.

## requirement_ids / requirement_refs / requirement_excerpt

- User authorization, 2026-09-16: first upgrade Hermes; scope narrowed to this one instance only.

## interface_refs / data_structure_refs

- Instance debug exec: `POST /v1/instances/{instance_id}/debug/exec`.
- Upgrade owner: `acli backend upgrade-start --blueprint-id <latest non-Nanjing Hermes Agent blueprint> --wait=true --force=true` as `agentuser`.
- Runtime acceptance: Hermes version/source revision plus JSON-RPC `groups.capabilities` with `driver: true` and required methods.

## history_context

- `current_design_refs`: `images/README.md`, `.agents/skills/hermes-cvm-image/SKILL.md`.
- `relevant_evolution`: repository image trigger last rebuilt Hermes 0.21.0; reference Hermes is 0.21.3 at `3c3ab69` and contains Hosted Rooms.
- `superseded_refs`: none.

## acceptance

- `acli` is available to `agentuser`.
- Pre-upgrade Hermes version/capability are recorded without secrets.
- Upgrade command returns a terminal successful result for this instance.
- Post-upgrade Hermes version/revision changes as expected.
- `groups.capabilities` exists, returns `driver: true`, and lists `groups.list/create/state/log/send/stop`.
- No other instance, image, pool, pipeline, or GitOps state is changed.

## affected_paths

- Remote instance `ins-a5083ca11a864760a1f3527a4689ad7f` only.
- Local task evidence under this directory only.

## required_context

- `release-gitops` Pack.
- `hermes-cvm-image` Skill.
- `planning-with-files` Skill.

## context_receipt

| File | Reading reason | Use |
|---|---|---|
| `AGENTS.md@worktree` | Remote mutation and secret boundary | Scope and evidence discipline |
| `docs/context/domains/release-gitops.md@2.0.0` | Separate source, artifact and live state | Do not claim image/region rollout |
| `.agents/skills/hermes-cvm-image/SKILL.md@worktree` | Supported upgrade path | Use backend blueprint upgrade as agentuser |
| `images/README.md@worktree` | Dynamic blueprint and identity contract | Force/wait and no sudo-acli |

## evidence

- `acli backend version`: 0.21.0 before and after the timed-out attempt.
- `groups.capabilities`: protocol v2, driver true, all required local group methods present.
- `/api/profiles`: one Profile, `default`.
- OpenCraft `canCreateGroup`: requires group topology and at least two available directory entries.

## risks

- Upgrade may restart the Hermes backend and briefly interrupt active conversations.
- An old `acli` can fail before backend upgrade; bootstrap it first under a per-instance lock.
- A code-present gateway can still report `driver: false` if its Hosted Room worker or durable storage is unavailable.
- Credential must remain process-memory only and never appear in files or final output.

## validation

- Read-only version/revision/capability probe before and after.
- Exact remote command result and post-upgrade gateway capability probe.
- No local Git or production rollout action.

## decisions

- User explicitly chose ad hoc upgrade of one instance; do not use the multi-region image pipeline.
- Upgrade via the supported backend blueprint transaction rather than editing the instance installation in place.

## scan_scope

- `images/`, `.ci/hermes-image.yml`, `ref/hermes-agent`, and the selected instance only.

## scan_output

- `findings.md` and `progress.md` in this directory.

## handoff

- Upgrade attempt did not complete and is not needed to explain the grey action. Awaiting product choice: create/enable a second Bot, or separately upgrade to 0.21.3 for unrelated fixes.
