---
id: opencraft-maintenance-skill-20260913
type: task
scope: Project-local OpenCraft maintenance skill and discovery entry
owner: mingyuxiao
authority: primary
source_of_truth: [opencraft/.agents/skills/opencraft-maintenance/SKILL.md]
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.1.0
precedence: task
derived: false
---
## goal
Create an actionable OpenCraft maintenance Skill from verified project decisions and repeated ownership/acceptance failures, with a project entry and progressive verification reference.
## non_goals
- No runtime changes, global skill installation, memory updates, repository-wide context redesign, commits or deployment.
- No copies of full architecture documents, secrets, machine-specific preview ports/profiles or reference-product scripts.
## requirement_ids / requirement_refs / requirement_excerpt
- Current user: “沉淀一个维护总纲Skill 到 opencraft”.
## interface_refs / data_structure_refs
- SKILL.md name/description; agents/openai.yaml; opencraft/AGENTS.md discovery link.
## history_context
- current_design_refs: opencraft/docs/platform-architecture.md; opencraft/docs/local-agent-custom-providers.md; opencraft/docs/build-matrix.md.
- relevant_evolution: live resize correction supersedes contraction clipping; auth, environment and model ownership verified in current source. User rejected presenting functional additions as completed UX changes.
- superseded_refs: prior max(committed,frame) drag policy; historical machine-specific preview details.
## acceptance
- Skill is inside OpenCraft, discoverable from its AGENTS and service docs, and has focused triggers.
- Includes ownership, direct manipulation versus visibility, product boundaries, shared controls and evidence-led handoff without duplicating formal specifications.
- Skill validator, links/command references, metadata and documentation/impact checks pass; six realistic requests manually reviewed.
## affected_paths
- opencraft/.agents/skills/opencraft-maintenance/
- opencraft/AGENTS.md; opencraft/docs/README.md
- docs/engineering/domains/agent-gateway-runtime.md
## required_context
- Initial task router returned no pack; bounded inspection of project AGENTS, docs and existing validation scripts.
## context_receipt
| File | Reason | Use |
|---|---|---|
| opencraft/AGENTS.md | Existing task entry | Add scoped Skill discovery without replacing root rules |
| opencraft/docs/README.md | Human-facing service entry | Add method link |
| opencraft/docs/platform-architecture.md | Current ownership | Preserve source authority and correct resize contract |
| opencraft/docs/local-agent-custom-providers.md | Model ownership | Keep DSH authority and probe limits |
| opencraft/docs/build-matrix.md | Preview contract | Distinguish build, running app and release |
| opencraft/package.json | Executable gates | Verify referenced commands exist |
## evidence
- Used skill-creator instructions and openai.yaml schema. No runtime source or user's existing edits reverted.
- Follow-up user approval added six explicit maintenance values before operational rules, a decision-order paragraph and three conflict examples. Verification reference now includes three corresponding tradeoff scenarios.
## risks
- A maintenance summary becoming a second architecture truth; mitigate with scoped routing and linked current docs.
- Historical mistakes becoming universal rules; keep tested invariants and distinguish current product choices from framework requirements.
## validation
- `skill-creator/scripts/quick_validate.py` reports `Skill is valid!`.
- Read/link checks verified the relative Skill reference and 19 project file paths; all 10 named npm scripts exist in the current package manifest.
- UI metadata description length35 and default prompt skill invocation validated. Skill remains implicitly invocable by default; no global installation performed.
- Documentation validator has `errors: []` (`/tmp/opencraft-maintenance-skill-docs.json`); impact checks passed (no staged files, no matched behavior rule for this documentation-only set); whitespace check passed.
- Manual walkthrough of the six requests in verification.md: analysis remains non-implementation, drag requires held evidence, Cordis respects lifetime, auth preserves flow/session distinction, UX claims distinguish existing capability, build does not authorize release. This is not an independent model-effect experiment.
- No runtime gate or new app build needed: this change only creates instructions, references and discovery links.
## decisions
- One concise entrypoint and one conditional verification reference, plus UI metadata. No new executable helper without a repeated need.
- Project path is .agents/skills/opencraft-maintenance inside OpenCraft, not a global install or a copy into root skills.
## scan_scope
- OpenCraft maintenance docs, source anchors and scripts named by the verification table.
## scan_output
- No external scan.
## handoff
- Complete. Entry: opencraft/.agents/skills/opencraft-maintenance/SKILL.md, one conditional verification reference, UI metadata. Routed from opencraft/AGENTS.md and service docs. Follow-up adds values and conflict resolution without changing runtime or invocation policy.
- No runtime changes, global skill install, memory edits, commit/push or deployment.
## stage
- Created, linked and validated.
## verified
- Skill structure/metadata, project paths/commands and document links.
## unverified
- A running desktop client's skill-picker refresh is outside this file change; project AGENTS provides an explicit readable entry regardless.
## discard
- Historical preview paths/ports and the superseded contraction clipping invariant were not persisted as current guidance.
## restore
- Formal architecture docs remain facts; Skill owns maintenance method and scenario-based validation routing only.
## next_action
- Use the project maintenance entry in subsequent OpenCraft work and refine only from demonstrated failures or explicit product changes.
