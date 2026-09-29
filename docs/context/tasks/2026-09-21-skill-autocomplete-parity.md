---
id: task-skill-autocomplete-parity-20260921
type: task
scope: Codex-style dollar Skill discovery and insertion in the existing OpenCraft Composer.
triggers: ["Skill autocomplete parity", "bare dollar Skill picker", "Codex Skill insertion"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/docs/chat-ui-architecture.md, opencraft/packages/codex-composer/src/codex-composer.tsx]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
User approved full implementation after the dollar trigger diagnosis and Codex/Paseo comparison.

## non_goals
- No fabricated Apps catalog, new Skill marketplace, runtime installation, login, paid inference or changing at-mention file search policy.
- Preserve current Host/path authority, existing theme/layout and unrelated worktree changes. No Git or production operations.

## context_receipt / reference evidence
- Root/OpenCraft AGENTS, maintenance checklist, chat-ui-architecture; baseline-ui and fixing-accessibility for existing editor/list primitives.
- Router no match; bounded lookup of Composer, catalog adapter, skill search and corresponding tests.
- ref/codex browser-autocomplete-trigger-regex, skillAppMentionList/filterByFuzzyScore, create-composer-suggestion-plugin, create-dismissed-match-state and use-list-keyboard-navigation.
- ref/paseo inline slash filtering and empty-query candidate behavior. Adopt Codex dollar semantics, not Paseo's slash trigger.

## acceptance / decisions
- Bare dollar opens enabled, path-deduplicated Host/root-scoped Skills; typed query searches name/display/path; empty query preserves source order and limit.
- Loading, unavailable/error and no results stay visible; Enter/Tab selects without sending; arrows wrap; Escape/blur dismiss without draft loss. IME commit cannot select or submit.
- Async suggestions are owned by catalog/target/query/controller; stale results cannot flash or insert after replacement. Skill identity survives insertion, codec and protocol compilation.
- Browser/Electron real Composer smoke with synthetic Host catalog: held requests, races, empty/error, keyboard/mouse, focus, insertion and scope replacement. No inference.

## handoff
- Implemented empty-query browse across UI/runtime/search, canonical path insertion, wrapped keyboard selection/Tab, dismissal and query-owner fencing. Updated old query-gated test. Four affected typechecks and all 408 chat tests passed.
- Browser smoke first proved browse/keyboard/protocol insertion, then failed because the fixture's outside button sat underneath the popup. Moved that fixture button outside the popup. Subsequent 8-second navigation budgets were too short for the cold Vite fixture; separated navigation and interaction budgets and await DOMContentLoaded. No product workaround for these fixture failures.
- Completed real Composer verification in Chromium and isolated Electron using synthetic Host metadata. Latest Electron evidence: /var/folders/pc/47xyrxbs1296b6sjfc2sfd6r0000gn/T/opencraft-skill-autocomplete-eNAIFN/report.json. Light screenshot visually reviewed; dark screenshot also generated.
- Verified bare dollar, source order/enabled filtering, path search, inline insertion, wrapped arrows/macOS Ctrl-P/N, Enter/Tab/mouse insertion, canonical compiled UserInput, no accidental submission, Escape/blur suppression, bracket boundaries, selected-text/code-block suppression, whitespace no-match dismissal, delayed results, Host replacement, empty/error/retry/unavailable states and synthetic IME Enter.
- New i18n changes in the shared working tree required the fixture to mount IntlRuntimeProvider. A stale/mixed Vite optimizer React instance caused a harness hook error; use a unique in-workspace cache and eagerly optimize/dedupe React/react-intl. No production dependency changes made for this harness issue. Held requests now wait for the replacement Host's actual request before resolving, and clearing input waits for the old list to close.
- Skill discovery errors are checked inside the runtime query function before successful caching, so Retry cannot be trapped by a cached erroneous empty response.
- Fresh four affected typechecks, all 408 chat tests, boundaries, Web build, diff check and explicit/staged docs-impact checks passed. Existing build-size/dynamic-import warnings remain non-blocking.
- Actual source trace: Local Host skills/list calls the capability metadata link; remote Hermes dashboard bridge still returns data:[] and Profile Skills management lacks equivalent canonical-path metadata. That separate backend capability was not fabricated or deployed. Reference Codex Apps catalog was not added.
- No installed App replacement, package, commit/push or inference request performed. The earlier signed ZenCode App does not contain this newer change.
- Follow-up audit found an unverified downstream gap: Local DSH promptContent drops native skill inputs. See 2026-09-21-skill-autocomplete-gap-audit.md. The completed smoke only proves editor -> compiler identity preservation, not engine consumption.
