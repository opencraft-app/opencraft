---
id: task-skill-trigger-review-20260921
type: task
scope: Read-only diagnosis of bare-dollar Skill autocomplete, compared with Codex and Paseo.
triggers: ["dollar skill trigger", "Skill autocomplete", "Paseo composer comparison"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/packages/codex-composer/src/codex-composer.tsx, opencraft/packages/composer-appserver/src/skill-catalog.ts]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
User reports dollar does not summon Skill autocomplete and requests comparison with ref/codex and ref/paseo.

## non_goals
- No implementation, user draft edits, model requests, dependency installation or reference execution.

## context_receipt / evidence
- Root/OpenCraft rules and chat-ui-architecture boundaries. Router returned no pack; bounded exact searches of codex-composer, composer-appserver, runtime catalog and reference autocomplete paths.
- OpenCraft querySuggestion recognizes bare dollar with the same regex as Codex. However UI filters and search effect reject empty catalogQueryText; list visibility also suppresses bare-dollar Skill UI. Runtime catalog search returns before any skills/list for empty text; searchAppServerSkills returns an empty list for empty query.
- chat-appserver-skill-catalog.test.ts explicitly expects whitespace query to produce no suggestions. Its three tests pass; this encodes the existing policy, not the requested interaction.
- Codex createComposerRichTextEditor enables skill mentions by default and maps dollar to skill-mention. composer-autocomplete-overlay mounts skillAppMentionList with an empty query. That list loads Host/root-scoped skills, filters enabled/model-compatible entries, combines usable apps and passes through filterByFuzzyScore; the latter returns all supplied items for empty query. Loading/no-results UI exists.
- Paseo inspected autocomplete path uses slash commands, not dollar. findActiveSlashCommand permits empty query; inline slash offers only provider commands marked skill; filterAndRankCommandAutocompleteEntries returns all supplied entries for empty query. Loading waits for the command catalog; server/draft/agent context gates availability.

## decisions / handoff
- Root cause for bare-dollar behavior is query-gating at several layers, not failure to recognize the dollar key.
- Proposed change (not implemented): treat empty Skill query as browse-enabled-skills; keep file-search query gating separate; show loading/unavailable/empty/matching states; preserve path identity, Host/root scope, keyboard insertion and cancellation fences. Update tests that currently mandate empty results.
- Non-empty queries with no data may also be hidden by the current list visibility condition; actual Host availability would need separate diagnosis if the user reports dollar-plus-name failing too.
