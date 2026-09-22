---
id: task-skill-autocomplete-gap-audit-20260921
type: task
scope: Read-only audit of remaining Skill autocomplete and execution parity gaps.
triggers: ["remaining Skill parity gaps", "Skill execution audit", "autocomplete refresh audit"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts, opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals
User asks for remaining gaps after Composer Skill implementation. Read-only analysis; no fixes, inference or remote writes.

## context_receipt / evidence
- Root/OpenCraft rules; preceding Skill parity Task Pack and Chat UI contract; no router match. Bounded trace across Composer -> compiler -> Local/Hermes adapter, catalog cache and ref/codex/ref/paseo autocomplete.
- Highest priority: Local DSH promptContent only handles text/localImage/image. turn/start, turn/steer and queue paths call it before session.prompt. An isolated execution of the current function with synthetic text+skill inputs produced only text and lost the Skill path. Prior smoke proved compiler UserInput, not engine consumption.
- Open-list refresh: runtime invalidates skills query keys on skills/changed, but Composer calls imperative fetchQuery and retains results in its own state without query observation/catalog change subscription. Isolated QueryClient probe: invalidation made no second fetch (one call total) and the held rendered array remained old.
- Directory completeness: remote Hermes bridge skills/list is still data:[]; separate Profile Skills management does not expose equivalent canonical path metadata.
- Browse completeness: Composer requests limit 50, search slices by limit and there is no more/pagination affordance. Synthetic 60-entry response yielded 50 browse entries; typing a filter may still find later entries.
- Ranking fidelity: current prefix/substring/subsequence scorer is not Codex's path-aware multi-pattern scorer. Search fields align but algorithm parity is not established.
- Product-scope differences: Codex dollar menu also includes usable Apps and filters particular bundled marketplace/build-flavor combinations. These should not be fabricated or copied as OpenCraft product rules without matching capabilities.
- Presentation: metadata includes icons but rows always use Sparkles; added scope/status messages are still literal English despite the newer i18n layer.

## handoff
- Report the explicit Skill-loss bug first, then open-list refresh and provider directory gaps. Recommend native input-consumption tests before more UI polish.
- No runtime code changed. Earlier autocomplete completion remains an interaction/compiler result, not end-to-end engine parity.
- Subsequent approved implementation: 2026-09-21-skill-execution-closure.md records Local native Skill consumption, remote Profile path discovery, reactive catalogs, full browsing, matching and presentation fixes and their verification boundaries.
