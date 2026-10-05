## goal
Give an OpenCraft conversation a durable, Host-owned Goal with an accurate compact Web control surface.

## non_goals
- No production rollout, commit, or replacement of the running preview.
- No browser-owned autonomous runner or fabricated DSH write capability.

## requirement_refs
- User request in this conversation, 2026-10-02: implement Goal elegantly with correct invariants and ownership.

## interface_refs
- `opencraft/packages/appserver-protocol/src/generated/v2/ThreadGoal*.ts`
- `thread/goal/get`, `thread/goal/set`, `thread/goal/clear`, and goal notifications.
- Server owns objective/status/usage; renderer owns only local disclosure and edit draft.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md`.
- `relevant_evolution`: BB persists Goal as event projection; recovered Codex UI reads on resume and has status-specific controls.

## acceptance
- Goal state survives view unmount/reconnect and follows the selected Thread.
- Unsupported Hosts do not offer fake write controls.
- Pending commands retain geometry; failed/late results cannot overwrite a newer Thread or command.
- Focused tests, affected typechecks, boundaries, and a real Web component check.

## affected_paths
- `opencraft/packages/appserver-protocol/`, `opencraft/packages/workbench-runtime/`, `opencraft/apps/opencraft-daemon/`, `opencraft/apps/local-agent-host/`, `opencraft/apps/workbench-web/`, `opencraft/tests/`.

## required_context
- Root and OpenCraft `AGENTS.md`; OpenCraft platform/chat architecture; maintenance skill.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | Repo boundaries | Task pack and gates |
| `opencraft/AGENTS.md` | Service ownership | Protocol/Host/UI separation |
| `opencraft/docs/platform-architecture.md` | Runtime design | Goal resource owner |
| `opencraft/docs/chat-ui-architecture.md` | Conversation/UI design | Goal projection and control boundary |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Interaction work | Validation and lifecycle |
| `docs/context/domains/identity-access.md` | Router must-read | Not in Goal scope |
| `docs/context/project/services/frontend.md` | Router must-read | Not in Goal scope |

## evidence
- Isolated native Codex 0.157.0 protocol probe confirmed `thread/goal/get` and
  `thread/goal/set`; setting an active Goal emitted an update and started a Turn.
- Codex Host exposes the capability, persists Goal in the native Thread, keeps
  an active-Goal index, and schedules continuation behind queued input.
- DSH Host exposes only its supported read path. Runtime Goal reads are fenced
  across notification and reconnect; writes require a confirming read.
- Focused tests: 29/29 passing across Goal resource and Codex Engine adapter.
- Web and Codex daemon typechecks, Web production build, and platform boundaries
  pass. Production/browser visual verification remains pending.
- The first live preview exposed an undefined `--color-accent` token: the Goal
  pill and primary modal button had white text on a transparent background.
  The revised Web surface consumes paired primary-button background/text tokens,
  anchors its expanded panel above the pill, and adds mobile dialog padding.
  Revised headless package smoke passed (build `20261002013722-8155eebec676`).
- Headless Chromium is unavailable on this TencentOS host because its downloaded
  binary lacks `libgbm.so.1` and `libasound.so.2`; real phone visual acceptance
  still requires the revised preview to be presented and checked.

## risks
- Generated protocol types may outpace the installed Codex binary; capability must be truthful and errors visible.
- Current checkout has unrelated dirty changes; preserve them.

## validation
- Focused protocol/runtime/component tests, affected typechecks, `check:boundaries`.

## decisions
- Goal is a Server/Thread state; Host advertises supported operations. Web never schedules autonomous turns.

## handoff
- In progress; live preview unchanged. Complete browser check and broader
  validation before considering preview replacement.
