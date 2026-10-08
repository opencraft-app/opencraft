---
id: opencraft-mobile-data-model-2026-09-30
type: task
scope: Model and implement the first iOS account caching and native request coordination slice across the embedded Bot runtime boundary.
triggers: ["mobile account cache", "request queue", "offline-first"]
owner: wisp/mono2-maintainers
authority: task
source_of_truth:
  - opencraft/docs/mobile-data-architecture.md
status: active
reviewed_at: 2026-10-01
review_due: 2026-11-30
revision: 1.2.0
precedence: task
derived: true
---

# OpenCraft mobile data model

## goal

Define one mobile data policy for fast account display, asynchronous refresh and safe request coordination across native iOS and the embedded frontend runtime; implement the native account display slice.

## non_goals

- Implement a cross-WebView memory queue or silently queue payment, verification, deletion or sign-out.
- Claim offline delivery or iOS background scheduling guarantees.
- Change production APIs in this client-side slice.

## requirement_ids / requirement_refs / requirement_excerpt

- Conversation, 2026-09-30: “账号头像和用户名是不是可以缓存，然后异步刷新？”; “整体建模”; “像一个真正的app那样设计请求队列”; “你网上搜搜工程实践”.
- Conversation follow-up, 2026-09-30: iPhone recording shows a complete account page switching to a short loading page, then back; research production app loading patterns, remove the flash, and add agent guidance.
- Conversation follow-up, 2026-10-01: remove the account identity label “上次资料”; keep cache and refresh details out of primary UI, record safe developer diagnostics if needed, and make this an AGENTS.md principle.
- External PRD/TAPD identifier: unknown.

## interface_refs / data_structure_refs

- `opencraft/apps/workbench-expo/src/components/mobile-account-overview.ios.tsx`: account profile query and display-only cached identity.
- `opencraft/apps/workbench-expo/src/runtime/mobile-account-display-cache.native.ts`: session-scoped persistent display cache.
- `opencraft/apps/workbench-expo/src/runtime/mobile-account-query.native.ts`: native profile query lifecycle and retry policy.
- `opencraft/apps/workbench-expo/src/runtime/lightvela-account.native.ts`: session and region lifecycle.
- `opencraft/apps/workbench-expo/src/runtime/runtime-context.tsx`: existing Android workbench TanStack Query client.
- `frontend/src/mobile-dom/entry.tsx`: embedded Bot runtime and native bridge.
- `opencraft/packages/mobile-account-sdk/src/index.ts`: shared profile projection and account operations.

## history_context

- `current_design_refs`: `opencraft/docs/mobile-data-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: iOS account page and Bot DOM runtime are separate presentations and JavaScript contexts; iOS now has its own native profile `QueryClient`, while Android retains its workbench client.
- `superseded_refs`: none.

## acceptance

- A resource policy matrix identifies durable display cache, memory-only data, online mutations and local drafts.
- Account/region partitioning, logout and 401 invalidation, stale response rejection and WebView isolation are explicit.
- The account identity card does not label cached data as “上次资料”; refresh failures with a partial cached display use a short retry prompt, while fixed cache/refresh events are available only through developer diagnostics.
- Rollout stages and meaningful device/network test cases are listed. The first native account slice passes Expo typecheck, focused tests and an iOS bundle build.

## affected_paths

- `opencraft/docs/mobile-data-architecture.md`
- `opencraft/AGENTS.md`
- `docs/context/tasks/2026-09-30-opencraft-mobile-data-model.md`
- `opencraft/apps/workbench-expo/src/components/mobile-account-overview.ios.tsx`
- `opencraft/apps/workbench-expo/src/components/lightvela-account-gate.ios.tsx`
- `opencraft/apps/workbench-expo/src/runtime/lightvela-account.native.ts`
- `opencraft/apps/workbench-expo/src/runtime/mobile-account-display-cache.native.ts`
- `opencraft/apps/workbench-expo/src/runtime/mobile-account-query.native.ts`
- `opencraft/apps/workbench-expo/src/runtime/mobile-developer-log-core.ts`
- `opencraft/packages/mobile-account-sdk/src/display-cache.ts`
- `frontend/src/contexts/session-context.tsx`

## required_context

- Root and OpenCraft `AGENTS.md`. The Context Router returned no matching Pack, so the bounded search started at the account, session, QueryClient and embedded-runtime paths above.

## context_receipt

| File | Reading reason | Decision |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Repo and mobile boundaries | Document target behavior without claiming unbuilt code exists |
| `opencraft/apps/workbench-expo/src/components/mobile-account-overview.ios.tsx` | Current loading behavior | First rollout is display-only identity cache |
| `opencraft/apps/workbench-expo/src/runtime/lightvela-account.native.ts` | Auth and region owner | Cache must be session- and region-scoped |
| `opencraft/apps/workbench-expo/src/runtime/runtime-context.tsx` | Existing QueryClient | Reuse query conventions for native reads, not a single cross-runtime heap |
| `frontend/src/mobile-dom/entry.tsx` | Embedded runtime boundary | Exchange invalidation intents over the bridge |

## evidence

- Router query returned no Pack match; bounded source searches identified the current read paths and installed TanStack Query and Expo SQLite packages.
- Official Android, TanStack Query, Expo and React Native documentation was read on 2026-09-30; direct links are in the formal design.
- Implementation stores only display name and HTTPS avatar URL under a SHA-256 session-token fingerprint plus region. It clears that entry and the in-memory query cache on local sign-out or 401.
- Focused account SDK/session tests, Expo typecheck, iOS bundle export, license check, platform-boundary check and external Expo manifest/full bundle verification passed on 2026-09-30.
- A shared account-updated event now asks the persistent embedded site SessionProvider to refresh after successful native nickname or avatar edits; the focused frontend session test passed.
- Loading-state follow-up: the account view now reuses a session-scoped in-memory full model while refetching, keeps existing content on transient failure, and uses stable card geometry for a true cold load. Verification is shown as checking and sensitive actions are disabled until the current response. Profile edits invalidate the profile query; ordinary refreshes no longer bust the avatar cache key. Research included TanStack Query official defaults/placeholder guides and TkDodo's practical React Query and placeholder-vs-initial-data articles.
- Presentation follow-up: removed the cached-profile label from the account identity card; cache hits and profile refresh outcomes now use fixed, privacy-safe developer events. The partial-display error prompt says the account cannot be refreshed and offers retry without exposing storage terms.
- 2026-10-01 verification: Expo typecheck, iOS bundle export, fixed-field developer log test, documentation validator, staged change-impact check, `git diff --check`, and external Expo iOS manifest check passed. The manifest check did not download the bundle and does not prove iPhone rendering.

## risks

- A cache keyed only by region can show another account's identity. Require account/session partitioning and clearing on sign-out/401.
- A persisted mutation without idempotency and conflict contracts can replay a destructive action. Keep those actions online-only.
- iOS background tasks run at system discretion. Never promise immediate queued delivery.

## validation

- Check links and Markdown structure; run `git diff --check` and staged change-impact validation.
- Focused native type/tests and iOS bundle passed. Cold/warm/offline launch, avatar edit and second-account login remain device checks; do not report them as verified by the bundle.

## decisions

- Share data contracts and invalidation messages across native and WebView; keep separate runtime query clients.
- Start with display-only account cache and asynchronous refresh. Defer durable mutation outbox until server contracts exist.

## scan_scope

- `opencraft/apps/workbench-expo/src/components/`, `opencraft/apps/workbench-expo/src/runtime/`, `opencraft/packages/mobile-account-sdk/`, `frontend/src/mobile-dom/`.

## scan_output

- Bounded exact-search summaries are recorded in the conversation; no raw private payloads were read.

## handoff

- Design, first native account slice and account update event implemented. The Expo Go preview is available for device checks. Referral query coordination, Bot-specific invalidation and any durable outbox remain separate follow-up work.
