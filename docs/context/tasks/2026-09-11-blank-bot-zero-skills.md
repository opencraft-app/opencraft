# Blank Bot Zero Skills

## goal
Make an additional Bot created with `空白创建` start with zero user-installed Skills and display an installed count of zero.

## non_goals
- No change to first Bot initialization.
- No change to clone-current or clone-main skill inheritance.
- No change to the user-visible `空白创建` label or creation entry visibility.
- No commit, push, MR, deployment, image build, or production mutation without separate authorization.

## requirement_refs / requirement_excerpt
- Follow-up to merged MR !3889: when adding a Bot with blank creation, install no Skills and show zero installed Skills after creation.

## interface_refs / data_structure_refs
- `POST /v1/instances/{instance_id}/bots` with `create_mode=blank`.
- `hermes profile create <profile_id> --no-skills` is the runtime contract for a named Profile that opts out of bundled-skill seeding.

## history_context
- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`, `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`.
- `relevant_evolution`: MR !3889 previously aligned blank Profiles to a recorded LightVela base skill set.
- `superseded_refs`: `docs/context/tasks/2026-09-10-blank-bot-base-skills.md` records the superseded base-skill behavior.

## acceptance
- Additional blank Bot creation uses `--no-skills` and contains no clone source.
- Additional blank Bot creation does not run base-skill alignment or depend on an image baseline manifest.
- The Hermes runtime-essential `hermes-agent` Skill remains available internally but is omitted from LightVela installed lists and counts.
- Clone modes do not use `--no-skills` and continue copying source Profile Skills.
- First Bot initialization remains unchanged.

## affected_paths
- `ctl/pkg/instance/bots.go`
- `ctl/pkg/instance/bots_test.go`
- `images/build.sh`
- `images/tests/test-hermes-build-script.sh`
- `images/tests/test-hermes-runtime.sh`
- `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- `frontend/src/lib/hermes-skills-client.ts`
- `frontend/src/lib/__tests__/hermes-skills-client.test.ts`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/lib/hermes-skills-client.ts`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/skills-demo/skill-registries.ts`
- `docs/engineering/domains/agent-gateway-runtime.md`
- `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`

## required_context
- No context router pack matched; bounded exact search recorded the query `追加 Bot 选择空白创建时不安装任何 skill，创建后已安装技能为 0`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `ctl/AGENTS.md@c8463caad` | CTL service rules | preserve runtime and public API boundaries |
| `frontend/AGENTS.md@c8463caad` | frontend service rules | keep installed-state authority in the live data layer |
| `opencraft/AGENTS.md@c8463caad` | generated vendoring rules | regenerate OpenCraft's mono2 mirror mechanically |
| `docs/engineering/domains/agent-gateway-runtime.md@c8463caad` | Profile design truth | update blank Profile skill semantics |
| `docs/context/tasks/2026-09-10-blank-bot-base-skills.md@c8463caad` | superseded task history | remove only the base-skill alignment introduced by !3889 |
| `docs/context/project/adjacency/product-skill-root-command.md@c8463caad` | skill command adjacency | verify the runtime command contract rather than changing Skills page data |
| `/Users/pablozhong/.hermes/hermes-agent/hermes_cli/profiles.py` | installed Hermes authority | confirm `--no-skills` creates an opt-out marker and skips seeding |
| `/Users/pablozhong/.hermes/hermes-agent/tools/skills_sync.py` | installed Hermes authority | confirm the marker prevents later bundled-skill re-seeding |

## evidence
- `hermes profile create` without a clone source seeds bundled Skills by default.
- Hermes `--no-skills` creates `.no-bundled-skills`; the sync path treats that marker as an explicit opt-out.
- Hermes intentionally retains the essential `hermes-agent` runtime manual even under `--no-skills`; removing it would violate the runtime invariant, so LightVela excludes it from user-facing installed results only when the target Profile carries the `.no-bundled-skills` opt-out marker. Existing and cloned Profiles keep their current list behavior.
- The image `base-skills` manifest added by !3889 has no remaining consumer after switching to `--no-skills`.

## risks
- Runtime images older than the Hermes `--no-skills` contract will reject blank Bot creation instead of creating a non-empty Bot; failure remains on the existing rollback path.
- Removing the image baseline manifest must not alter root Profile skill curation.

## validation
- `CGO_ENABLED=0 go test ./pkg/instance -run 'TestBuildHermesProfileCreateCommand|TestHermesProfileConfigUnset' -count=1`: passed.
- `CGO_ENABLED=0 go vet ./pkg/instance ./pkg/errcode`: passed.
- `bash -n images/build.sh images/tests/test-hermes-build-script.sh images/tests/test-hermes-runtime.sh`: passed.
- `bash images/tests/test-hermes-build-script.sh`: passed.
- `pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1 src/lib/__tests__/hermes-skills-client.test.ts src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`: 3 files and 119 tests passed.
- `pnpm check`: passed with zero new TypeScript diagnostics; existing translation warnings remain non-blocking repository baseline warnings.
- `npm --prefix opencraft run check:mono2-agent-console`: verified all 125 synchronized files.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`: passed with no errors or warnings.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`: passed; `agent-gateway-runtime` owner review remains required.
- A temporary installed-Hermes fixture confirmed `hermes profile create --no-skills` writes `.no-bundled-skills`, skips bundled seeding, and retains only the runtime-essential `autonomous-ai-agents/hermes-agent` Skill.

## decisions
- Use the native Hermes `--no-skills` contract instead of creating then deleting skill directories.
- Treat `hermes-agent` as an internal runtime dependency rather than a user-installed Skill in LightVela lists.
- Remove the superseded LightVela base-skill manifest and alignment code.

## scan_scope
- `ctl/pkg/instance`, `images`, current multi-Bot PRD, and installed Hermes Profile/skills synchronization source.

## scan_output
- Exact source references are recorded in evidence; no separate scan artifact.

## handoff
- Implementation and local validation completed on `codex/blank-bot-zero-skills`; delivery state is tracked by Git and the merge request.
