# Chat Tab Availability Tooltip

## goal
Replace the native disabled-chat title tooltip with the existing sidebar action tooltip and requested product copy.

## non_goals
- Do not enable chat for named Profiles or change backend permissions.
- No deployment.

## requirement_refs / requirement_excerpt
- User requested: 对话功能目前仅支持主 Bot.

## interface_refs / data_structure_refs
- AgentSettingsPage chat tab; isActiveBotDefault; lv-agent-action-tooltip.

## history_context
- Existing chat guard uses native disabled plus a title attribute.
- Reuse restart/delete tooltip styles, not a new tooltip library.

## context_receipt
| File | Use |
|---|---|
| frontend/AGENTS.md | Frontend validation rules |
| frontend/src/styles.css | Existing tooltip and segmented layout |
| frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts | Main-Bot guard assertions |

## acceptance
- Named Bot chat remains disabled; native title removed; associated tooltip contains requested copy.
- Wrapper responds to hover/focus without changing segmented control proportions.

## validation
- Focused component/source tests: 34 passed. Diff check passed. Local page HTTP 200.
- Frontend check passed: i18n valid and zero new TypeScript diagnostics.

## checkpoint
- stage: implemented locally.
- verified: disabled semantics, accessible description, shared tooltip class, localized copy.
- unverified: real browser screenshot.
- next_action: user authorized adding the verified follow-ups to MR !3848; no merge or deployment.
