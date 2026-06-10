# Spec: Agent Console route IA

## Route Model

`OpenClawSettingsPage` remains the implementation component for the Agent console, but its canonical URL becomes `/agents`.

| Path | Behavior |
|------|----------|
| `/agents` | Render Agent console, default section `channels` |
| `/agents/channels` | Render channel section |
| `/agents/models` | Render model section |
| `/agents/skills` | Render skill section |
| `/agents/persona` | Render persona section on CN; redirect to `/agents` on Global |
| `/agents/automations` | Render automation section |
| `/agents/memory` | Render memory section |
| `/agents/achievements` | Render achievements section |
| `/agents/files` | Render cloud files section |
| `/agents/chat` | Render AgentChat section |

Legacy routes redirect to `/agents` while preserving `location.search`.

## Section Mapping

The page keeps its internal `SettingsSectionId` values where practical, with URL slugs mapped explicitly:

| URL slug | Section id |
|----------|------------|
| `channels` | `channel` |
| `models` | `model` |
| `skills` | `skill` |
| `persona` | `buddy` |
| `automations` | `automations` |
| `memory` | `memory` |
| `achievements` | `achievement` |
| `files` | `files` |
| `chat` | `chat` |

`activeSection` is derived from `useParams()` instead of local-only state. Navigation clicks call `navigate(section.path)`.

## Compatibility

- `/dashboard`, `/dashboard/settings`, `/openclaw/settings`, and `/console/settings` must redirect to `/agents`.
- Old creation query semantics are retained by preserving query strings.
- Existing creation flows should use `/agents` directly after this change.

## Validation

- Router/unit checks for updated primary links.
- TypeScript check via `pnpm check`.
- i18n dictionary check via `pnpm i18n:check` if text keys change.
