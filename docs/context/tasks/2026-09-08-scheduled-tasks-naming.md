# Task Pack: Scheduled Tasks naming

## Goal

Unify the user-facing LightVela feature name from “自动任务 / Automations” to “定时任务 / Scheduled Tasks” across the product UI, backend-originated user messages, product documentation, changelog content, and supported locales.

## Non-goals

- Rename internal automation/cron APIs, routes, identifiers, files, or storage formats.
- Replace generic prose where “automation” describes a concept rather than the named product feature.
- Add a new documentation surface that does not already exist.
- Commit, push, create an MR, or publish the change.

## User request

> 按照这个方案，你在产品的界面上面，后端吐出来的提示文案，然后产品的文档，然后还有更新日志，全部都统一改一下，多语言都改一下。

## Context receipt

- `AGENTS.md`
- `frontend/AGENTS.md`
- `docs/context/project/services/frontend.md`
- `docs/context/domains/site-environment-routing.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`
- `.agents/skills/product-skills/SKILL.md`
- `.agents/skills/product-skills/lv-docs/SKILL.md`
- `.agents/skills/product-skills/lightvela-changelog-update/SKILL.md`
- `/Users/pablozhong/.codex/skills/karpathy-guidelines/SKILL.md`

## Evidence and scope

- Product UI and user-facing runtime copy were updated in the Agent settings panel, Scheduled Task dialogs, scenario launchers, model-switch synchronization notices, homepage fragments, SEO/LLM text, and CTL error messages.
- The supported locale terminology is now: `定时任务`, `定時任務`, `Scheduled Tasks`, `Tugas Terjadwal`, `Tareas programadas`, `スケジュールタスク`, and `예약 작업`.
- Product documentation was updated across the root, `global`, `en`, `id`, `es`, `ja`, and `ko` trees; sidebar registration and Fumadocs synchronization still use the compatible `configuration/automation` slug.
- Changelog source, alt text, localized dictionaries, and regression tests use the new product name.
- Current OpenSpec product/marketing specs and formal engineering boundary documents were updated. Historical implementation plans and third-party product names such as “Grok Automations” remain unchanged for traceability and accuracy.
- Internal API names, TypeScript identifiers, telemetry keys, file names, asset paths, and `/agents/automations` routes remain unchanged.

## Validation plan

- `pnpm vitest run ...`: 12 files and 461 tests passed for Scheduled Tasks UI, changelog, homepage, docs ordering, cron client, and toast copy.
- `pnpm check`: passed; i18n extraction/validation, generated Traditional Chinese consistency, docs timestamps/sync, Fumadocs MDX, and the TypeScript baseline all passed with 0 new diagnostics.
- `go test ./pkg/errcode`: passed.
- `CGO_ENABLED=0 go test ./pkg/instance -run 'Test(ListAutomationSchedules|AutomationBackfill|CreateAutomationSchedule)'`: passed. The full package attempt was not usable locally because unrelated integration tests require rootless Docker; the default CGO run also hit a local Go 1.26/macOS Security framework linker mismatch.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`: passed with 0 broken first-party links and 0 warnings.
- `validate_change_impact.py` over the complete working-tree change list: passed; the CTL responsibility surface is paired with an update to `docs/engineering/domains/agent-gateway-runtime.md`.
- Final terminology, route/asset integrity, and `git diff --check` scans passed.

## Status

Implementation and local validation complete. No commit, push, MR, or release performed.
