---
id: opencraft-ios-webview-recovery-2026-09-30
type: task
scope: Make the iOS My agents WebView failure visible and diagnosable.
triggers: ["OpenCraft iOS My agents blank", "Expo Go site diagnostics"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - opencraft/apps/workbench-expo/src/app/index.tsx
  - opencraft/apps/workbench-expo/src/runtime/lightvela-site-webview.ts
status: active
reviewed_at: 2026-09-30
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: true
---

# iOS My agents WebView recovery

## goal

Diagnose the reported blank My agents page on iPhone and give the user a retry path when page loading fails.

## non_goals

- Change the website's agent content or authentication protocol.
- Treat an unobserved device error as a proven backend or site failure.

## requirement_ids / requirement_refs / requirement_excerpt

- User report on 2026-09-30: “现在 my bots 页面还是空白”. No external ticket ID.

## interface_refs / data_structure_refs

- `WebView` main-frame load, HTTP error and first-party `postMessage` events in `src/app/index.tsx`.
- First-party site bootstrap in `src/runtime/lightvela-site-webview.ts`; only fixed event names and numeric health measurements reach the local developer log.
- `/agents`, `/account`, `/account/billing` tab projection; unknown and transient URLs must not clear the selected tab.

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`, `opencraft/apps/workbench-expo/README.md`.
- `relevant_evolution`: the WebView stays mounted beneath the native account page so Manage account shows the site. The user then reported My agents blank on the same Expo Go preview.
- `superseded_refs`: none.

## acceptance

- WebView load and empty DOM states enter a bounded local diagnostic log without URLs, tokens or page text.
- Main-frame failure or persistently empty page displays a plain retry action instead of an unexplained blank screen.
- iOS typecheck, bundle, focused WebView tests and external manifest/full-bundle verification pass.
- A real iPhone retry is still needed to identify and confirm the underlying failure.

## affected_paths

- `opencraft/apps/workbench-expo/src/app/index.tsx`, `src/runtime/lightvela-site-webview.ts`, `src/runtime/mobile-developer-log-core.ts`, `src/runtime/mobile-language.ts`, `opencraft/tests/lightvela-site-webview.test.ts`, Expo README and the agent runtime design.

## required_context

- Root and OpenCraft `AGENTS.md`; OpenCraft maintenance skill; current Expo WebView implementation and website route shell.
- Context router returned no matching pack for iOS WebView diagnostics; bounded search of the Expo shell and `/agents` route located these owners.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Git and task constraints | Keep work staged and uncommitted |
| `opencraft/AGENTS.md` | Native preview and testing | Validate actual Expo path |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Maintenance workflow | Diagnose by runtime evidence |
| `frontend/next-site/agents-page-client.tsx` | Website route owner | Confirm `/agents` is a real client route |
| `frontend/next-site/app-route-shell.tsx` | Auth/loading boundary | Avoid attributing blank state to an unobserved backend error |

## evidence

- `/agents` returned HTTP 200 HTML anonymously from the public international site; this does not prove authenticated iPhone rendering.
- Expo typecheck and iOS bundle passed after the WebView diagnostics and fallback change. Focused WebView tests passed before the new origin/privacy test was added; rerun pending.
- External Expo Go manifest and full bundle downloaded successfully; on-device retry pending.

## risks

- A blank page may be caused by site JavaScript, WebView navigation, network conditions or stale cache. The current device log is needed before claiming a root cause.
- The delayed DOM check may report a slow page as empty; Reload stays available and a later successful navigation clears the state.

## validation

- `npm run typecheck --workspace @opencraft/workbench-expo`
- `tsx --test tests/lightvela-site-webview.test.ts tests/mobile-developer-log.test.ts`
- `npm run bundle:ios --workspace @opencraft/workbench-expo`
- Cloudflare preview skill's external manifest and full-bundle check
- `git diff --cached --check` and change-impact check

## decisions

- Keep diagnostics local and numeric, with their viewer gated behind Developer mode. Owner: implementation team.
- Preserve the selected tab across unknown transient URLs and expose a retry card for load failure or empty DOM. Owner: implementation team.

## scan_scope

- `opencraft/apps/workbench-expo/src/`, `opencraft/tests/`, `frontend/next-site/`.

## scan_output

- Bounded `rg` found Expo WebView shell, site bootstrap and website route shell; no broad repository dump retained.

## handoff

- Branch `codex/mobilefirst-account-components-20260930` remains uncommitted. The Expo Go preview is live; device diagnostics and root cause remain to be observed.
