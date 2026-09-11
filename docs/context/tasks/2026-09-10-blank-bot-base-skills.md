# Blank Bot Base Skills

## goal
Make an additional blank Bot start with the same LightVela base skill set as the first Bot without inheriting later user-installed skills.

## non_goals
- No change to the user-visible `空白创建` label.
- No change to clone-current or clone-main skill inheritance.
- No image build, deployment, or production mutation.

## requirement_refs / requirement_excerpt
- User requirement: keep `空白创建`; additional blank Bots use the LightVela base skills from the first Bot and do not inherit skills installed later.

## interface_refs / data_structure_refs
- `POST /v1/instances/{instance_id}/bots` with `create_mode=blank`.
- Hermes root Profile maps to `main` publicly and `default` natively; named Bot skills remain Profile-local.

## history_context
- current_design_refs: `docs/engineering/domains/agent-gateway-runtime.md`
- relevant_evolution: Hermes fresh Profile creation seeds the full bundled catalog while the LightVela image curates the root Profile.
- superseded_refs: none.

## acceptance
- Image creation records the actual curated LightVela skill paths.
- Additional blank Bot creation removes full-catalog skills and retains only the recorded base set.
- User-installed root skills are not copied.
- Later root Profile deletion of a base skill does not remove the freshly seeded copy from an additional blank Bot.
- Existing images without the recorded manifest infer the base set from installed bundled skills.
- Clone modes continue copying the selected source Profile's skills.

## affected_paths
- `images/build.sh`
- `ctl/pkg/instance/bots.go`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- No context router pack matched; bounded search recorded the query `调查首个 Bot 与追加空白 Bot 的已安装技能数量为何分别为 14 和 54`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `ctl/AGENTS.md` | CTL service rules | preserve runtime and API boundaries |
| `docs/engineering/domains/agent-gateway-runtime.md` | Profile design truth | document blank Bot skill baseline |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | nearest runtime/UI adjacency | confirm no frontend or i18n change is needed |
| `/Users/pablozhong/.hermes/hermes-agent/hermes_cli/profiles.py` | installed Hermes implementation | verify fresh Profile and no-skills semantics |
| `/Users/pablozhong/.hermes/hermes-agent/tools/skills_sync.py` | bundled skill sync behavior | preserve missing manifest entries as intentional omissions |

## evidence
- Current CTL blank creation executes `hermes profile create` without a clone source, which triggers full bundled skill seeding.
- Image construction prunes the root Profile to a LightVela allowlist but previously did not expose that resulting set to named Profile creation.

## risks
- Legacy images have no LightVela baseline manifest; fallback inference must exclude non-bundled user skills.
- A malformed or empty baseline fails Bot creation so a full-catalog Bot is never exposed as successfully blank-created.

## validation
- `CGO_ENABLED=0 go test ./pkg/instance -run 'Test(BuildHermesProfileCreateCommand|AlignBlankProfileSkills)' -count=1`: passed.
- `CGO_ENABLED=0 go vet ./pkg/instance ./pkg/errcode`: passed.
- `bash -n images/build.sh images/tests/test-hermes-build-script.sh images/tests/test-hermes-runtime.sh`: passed.
- `bash images/tests/test-hermes-build-script.sh`: passed.
- Documentation validation and changed-file impact validation: passed; runtime owner review remains required by policy.
- Full `CGO_ENABLED=0 go test ./pkg/instance -count=1`: blocked because this macOS checkout has no rootless Docker for the MySQL testcontainer suite; the targeted changed-path tests pass.

## decisions
- Record actual post-curation paths rather than hard-code the observed count `14`; the count may change with image contents.
- Preserve Hermes' seeded bundled manifest so omitted full-catalog skills remain intentional deletions on later updates.

## scan_scope
- `ctl/pkg/instance`, `images`, and installed Hermes Profile/skills synchronization source.

## scan_output
- Exact source references recorded in evidence; no separate scan artifact.

## handoff
- Implementation and local non-Docker validation completed; not committed, pushed, deployed, image-built, or production-verified.
