# Issue: Agent Console canonical path

## Background

`/dashboard/settings` is still the canonical entry for the LightVela Agent console. The page now carries much more than settings: channel connection, model management, skills, persona, automations, memory, achievements, cloud files, and AgentChat. Keeping the main entry under `settings` makes navigation look verbose and semantically narrow.

## Goal

Make `/agents` the canonical Agent console path and give each first-level console section its own URL.

## Scope

- Add `/agents` and section URLs:
  - `/agents/channels`
  - `/agents/models`
  - `/agents/skills`
  - `/agents/persona`
  - `/agents/automations`
  - `/agents/memory`
  - `/agents/achievements`
  - `/agents/files`
  - `/agents/chat`
- Keep legacy paths as compatibility redirects:
  - `/dashboard` -> `/agents`
  - `/dashboard/settings` -> `/agents`
  - `/openclaw/settings` -> `/agents`
  - `/console/settings` -> `/agents`
- Preserve query strings such as `?creating=<botId>` when redirecting from legacy paths.
- Drive the active console section from the URL so refresh, copy link, and direct navigation work.
- Update internal links and OpenSpec docs to use `/agents` as the primary entry.

## Non-goals

- Do not introduce `/agents/:agentId/...` in this iteration. The existing in-page Agent switcher remains the selected-Agent mechanism.
- Do not split `openclaw-settings-page.tsx` into submodules.
- Do not redesign the visual layout beyond the URL and navigation behavior needed for this IA change.

## Acceptance Criteria

- Visiting `/agents` opens the Agent console and defaults to the channels section.
- Visiting `/agents/models` opens the same console with the model section selected.
- Clicking each left navigation item updates the browser URL to the matching `/agents/<section>` path.
- Legacy `/dashboard/settings?creating=xxx` redirects to `/agents?creating=xxx`.
- Existing entry points such as "进入控制台" and "管理我的智能体伙伴" point to `/agents`.
- Unknown section paths fall back to `/agents` instead of showing a broken empty state.
