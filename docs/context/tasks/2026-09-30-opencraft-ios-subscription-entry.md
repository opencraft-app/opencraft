---
id: opencraft-ios-subscription-entry-2026-09-30
type: task
scope: Present native subscription management entry and retain the existing website renewal flow.
triggers: ["iOS subscription management", "renewal method web handoff"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - opencraft/apps/workbench-expo/src/app/index.tsx
  - opencraft/apps/workbench-expo/src/components/mobile-account-overview.ios.tsx
status: active
reviewed_at: 2026-09-30
review_due: 2026-11-30
revision: 1.1.0
precedence: task
derived: true
---

# iOS subscription management entry

## goal

Let iOS users enter the existing website's renewal-method management through a native “Subscription management” action.

## non_goals

- Reimplement plans, payment methods or checkout in native code.
- Change the website billing page or backend subscription rules.

## requirement_ids / requirement_refs / requirement_excerpt

- User request on 2026-09-30: “续费方式管理引导到web 叫做订阅管理”. No external ticket ID.
- Follow-up: “取消下面的tab，套餐和费用变成个人页面的按钮。”

## interface_refs / data_structure_refs

- The native personal page presents the subscription-management button; the first-party WebView remains mounted behind native views.
- `lightVelaSiteTabUrl(region, "billing")` owns the regional `/account/billing` destination.
- Website owns all renewal and payment operations.

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`, Expo README.
- `relevant_evolution`: Billing previously opened `/account/billing` immediately in the app WebView, exposing the website's renewal and payment card actions as the first screen.
- `superseded_refs`: none.

## acceptance

- The native personal page displays a HeroUI Native subscription-management button in the selected app language; no Billing tab remains.
- The button opens the selected region's existing billing website in the retained WebView; Back returns to the native personal page.
- iOS typecheck, bundle and external Expo Go bundle check pass; a phone interaction is still needed.

## affected_paths

- Expo app route, native personal page, language copy, README and agent runtime design.

## required_context

- Root and OpenCraft `AGENTS.md`, OpenCraft maintenance skill, iOS route and existing website billing route.
- Context router returned no matching pack; bounded search of the Expo tab URL mapping and route shell located the owner.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Change and delivery boundary | Stage, do not commit without authorization |
| `opencraft/AGENTS.md` | iOS UI and preview boundary | HeroUI Native and real preview validation |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Maintenance workflow | Keep site payment ownership intact |
| `opencraft/apps/workbench-expo/src/app/index.tsx` | Navigation owner | Personal page and WebView handoff |
| `opencraft/apps/workbench-expo/src/runtime/lightvela-site-webview.ts` | Regional route contract | Reuse `/account/billing` |

## evidence

- Expo typecheck and iOS bundle passed; external Expo Go manifest/full bundle check passed. The website billing page was visible in the user's screenshot before this change.
- Phone click-through after the native entry change remains pending.
- The standalone native billing entry and bottom Tabs were removed in the follow-up. Expo typecheck, iOS bundle and external full bundle passed again; personal-page button and Back behavior need a phone check.

## risks

- WebView navigation from the entry depends on the site's loaded page; a device check is needed to ensure the handoff and Back action work.

## validation

- `npm run typecheck --workspace @opencraft/workbench-expo`
- `npm run bundle:ios --workspace @opencraft/workbench-expo`
- `tsx --test tests/lightvela-site-webview.test.ts`
- External manifest and bundle verification; staged diff and change-impact checks.

## decisions

- The personal page owns the native “Subscription management” button; the website owns billing and payment. Owner: implementation team.

## scan_scope

- `opencraft/apps/workbench-expo/src/`, `frontend/next-site/`.

## scan_output

- Bounded path search found the existing first-party billing URL mapping; no separate native subscription API is introduced.

## handoff

- Branch remains uncommitted. Preview link is live; device click-through and final label confirmation remain pending.
