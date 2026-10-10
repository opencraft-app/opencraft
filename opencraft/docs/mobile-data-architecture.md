# Mobile data coordination

This is the data contract for the LightVela iOS shell and the embedded Bot runtime. The account display cache, native profile query coordinator and account update event are implemented; a durable outbox and broader Bot invalidation contract remain future work.

## Ownership

| Layer | Owns |
|---|---|
| Native account session | Region, authenticated session, credential lifecycle and sign-out |
| Shared SDK | Resource identity, API request and response contracts, cache policy, invalidation events and mutation classification |
| Native data coordinator | Native account queries, persisted display cache and AppState/network integration |
| Embedded frontend runtime | Bot queries and DOM presentation inside its own JavaScript context |
| Server | Authoritative account, Bot, entitlement, billing and verification state |

The native shell and WKWebView do not share one JavaScript heap. They can share contracts and send narrow invalidation events, but they cannot share an in-memory `QueryClient` or pretend that a global request queue already exists. The embedded frontend keeps its existing repository/provider logic; the native host must not copy Bot business operations.

## Read path

1. Resolve the locally stored credential, region and previously validated account association before reading account-specific cached data. Address a cache entry by environment, region, stable account identity or a session-scoped fingerprint, resource and parameters. Never use a region-only key. While server validation is pending or unavailable, cached identity may be displayed as a stale, display-only snapshot; privileged actions still require a valid server session. Do not persist the session token in the query cache or write it to diagnostics.
2. Read the local display snapshot immediately. Render it as *previously known* data while requesting the latest server state in the background. A successful response updates the local snapshot and UI atomically. The server remains authoritative.
3. Deduplicate identical in-flight reads by resource key. Cancel or ignore stale responses when account, region, request generation or active destination changes. Refresh stale visible data on app foreground and network recovery; avoid blind polling of hidden screens.
4. Distinguish `no-cache/loading`, `cached/refreshing`, `fresh`, `cached/offline-or-error`, `no-cache/error` and `session-expired`. An error with a valid cache keeps the cached display and offers retry; a 401 clears the session scope and cached identity. Do not convert a network failure into an empty successful result.

Cache and refresh states are internal rendering and diagnostic facts. The account identity card shows the person's name and avatar without a cache-status badge. When a failed refresh needs user action, show a short retry prompt; record fixed, privacy-safe cache/refresh events in the developer log instead of exposing storage terminology in the interface. Keep server-verified identity and account actions gated by the current session state.

The iOS account page persists only the display name and avatar reference under a region and session-token fingerprint. On a cold entry it keeps the final account-card geometry with static placeholders while requesting `/auth/profile`, instead of rendering a shorter loading page. The shell computes the session scope before mounting the account view, so a same-session in-memory full profile can be read synchronously on its first frame, without waiting for an effect; verification is marked as checking and safety actions stay disabled until the current server response arrives. Subsequent refreshes retain the last complete page and treat `isFetching` and transient errors as separate state, so a failed request cannot erase the visible profile. `expo-image` supplies the disk-backed avatar image cache, changes its key only after an avatar upload, and falls back to an initial if loading fails. Sign-out and 401 clear the profile query cache and matching display snapshot. An offline launch can show only the saved identity and reconnect/sign-out actions while session validation is unavailable.

| Resource | Initial persistence policy | Refresh trigger | Authority rule |
|---|---|---|---|
| Account display name/avatar | Account- and region-scoped local snapshot; bounded lifetime | Account entry, successful edit, foreground when stale | Display only; never grants access |
| Account email/phone/verification | Memory for the active session | Account entry and successful edit | Do not show cached verification as current |
| Bot catalog and configuration | Memory first; persist only after a specific offline requirement | Bot entry, create/delete, foreground when stale | Server status controls available actions |
| Billing, payment, real-name flow | No durable response cache | Open the flow | Current server response controls actions |
| Chat draft | Local durable draft store | User edits | Sending requires a separate server receipt |

Freshness values are policy, not identity: start with a short in-memory freshness window for visible reads and a bounded multi-day lifetime for display-only identity, then tune from measured traffic and product needs. Version or invalidate the persisted schema when the projection changes. Expo SQLite is already installed and offers an Expo Go-compatible key-value store for small snapshots; SecureStore remains for credentials.

## Request coordination

### Bot navigation continuity

The native and Expo Web hosts use one `mobile-bot-navigation-state` presentation model. Selecting a Bot changes the destination without clearing its navigation tree. Runtime-local, bounded (32 Bot) display snapshots restore the target's own groups and sessions immediately. Until the embedded controller publishes the selected Bot again, cached commands stay disabled. A cold destination keeps the previous group geometry as a noninteractive placeholder and reserves session rows without showing another Bot's session names. Target groups replace those placeholders on receipt; this does not invent permissions or prefetch/mount a second Bot runtime.

An empty loading session response retains that Bot's existing rows with actions disabled; a successful empty result removes them. Late projections may update only their own Bot snapshot, never confirm the current destination. Runtime, account and locale replacement retire the display scope; successful catalog changes prune removed Bots, and a successful empty catalog clears it. The cache is memory only and is not a domain controller or authorization source. Keep Tabs and group/item keys stable across selection; selection must not replace the whole list with a loading page. Snapshot freshness and request readiness remain separate from displayed data.

The iOS shell now has a native `QueryClient` for profile reads and registers React Native `AppState` and Expo Network events with `focusManager` and `onlineManager`. Profile requests use a session-scoped key for in-flight deduplication and cap retries at two transient failures; 401 and ordinary validation errors do not retry. The visible account page refreshes on entry, successful edit, foreground return and network recovery. An explicit concurrency scheduler remains conditional on measured contention: TanStack Query does not itself define one durable, app-wide queue across native and WKWebView.

| Work lane | Scheduling rule | Persistence |
|---|---|---|
| Foreground read | Active screen or explicit retry runs first; deduplicate by resource key and cancel stale generation | Query cache by resource policy |
| Background refresh | Coalesce repeated invalidations; run when app is active and network is reachable, with bounded concurrency if needed | The result may update a display snapshot |
| User mutation/upload | Show its own pending state; serialize only commands that share a server resource and require ordering | No automatic persistence or replay |
| Durable outbox | Opt-in commands with server idempotency and conflict rules; drain with expiry and backoff | Persisted command envelope, only after backend contract exists |

This is a scheduling model rather than one FIFO for every HTTP request. A foreground tap should not wait behind a stale background refresh, and a failed read should not block a payment or profile edit.

## Write path

Classify each command before adding any queue:

| Class | Examples | Behavior |
|---|---|---|
| Online transaction | Payment, real-name verification, account security changes, Bot deletion, sign-out | Require an immediate server result; show pending and failure in the action's own UI |
| Confirmed profile edit | Nickname and avatar upload | Submit online; after server success update/invalidate identity cache and notify the other runtime |
| Local draft | Unsent chat text or form draft | Save locally; do not claim the server accepted it |
| Deferred telemetry | Nonessential diagnostics, only if product policy permits | Optional bounded queue with expiry and backoff |

A durable write outbox is a later feature, not a default behavior for every mutation. It needs a backend idempotency key, ordering scope, conflict/version contract, retry classification, expiry, cancellation and a visible pending state. TanStack Query can persist paused mutations, but a default mutation function must be registered to resume them after process restart; a persisted query cache alone is not a reliable outbox. iOS background work runs when the system permits and cannot promise immediate delivery. Payment, verification and destructive actions must not silently replay.

## Cross-runtime and lifecycle rules

- Share SDK contracts and `account:updated`, `bot:changed`, `session:ended`, and `region:changed` invalidation intents across the native/WebView bridge. The first implemented intent is the shared `opencraft:account-updated` event: after a successful native profile edit, the embedded site refreshes its session profile. Messages carry resource identity and revision, never token or private response bodies.
- On successful edit, update the native display snapshot and invalidate the relevant frontend view; on sign-out or account/region switch, clear native query state and the matching persisted identity scope before showing another user's data.
- Keep the existing developer log fixed-code and bounded. Record request class, retry count and outcome as safe numeric/fixed fields; no URL, profile content, token or exception text.
- A WebView reload may rebuild its own data coordinator. Native session validation and cache partitioning remain outside that WebView lifecycle.

## Rollout and verification

1. Account display and image cache, session partitioning and the offline display-only gate are implemented. Verify cold launch, warm launch, offline launch, successful name/avatar edit, 401, sign-out and second-account login on device; automated typecheck and contract tests do not replace this check.
2. Native profile reads use a query coordinator with deduplication, retry classification and foreground/network refresh. Referral reads still use the existing page-specific fetch path and can be migrated if request contention is observed.
3. Native account edits now emit a narrow account refresh event to the embedded site. Extend this to Bot changes only where a concrete stale view is identified; verify the embedded DOM host and native account view agree after edits without duplicating API mutations.
4. Consider durable outbox and background scheduling only for commands with explicit server idempotency/conflict contracts and product-approved offline behavior.

## Sources

- [Android offline-first data layer and read/write strategies](https://developer.android.com/topic/architecture/data-layer/offline-first)
- [TanStack Query React Native focus and online integration](https://tanstack.com/query/latest/docs/framework/react/react-native)
- [TanStack Query defaults: stale data and background refetch](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults), [placeholder data](https://tanstack.com/query/latest/docs/framework/react/guides/placeholder-query-data), [TkDodo's practical React Query notes](https://tkdodo.eu/blog/practical-react-query), and [placeholder versus initial data](https://tkdodo.eu/blog/placeholder-and-initial-data-in-react-query)
- [TanStack Query persisted cache](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient) and [offline mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations)
- [Expo SQLite key-value store](https://docs.expo.dev/versions/latest/sdk/sqlite/), [Expo Image cache](https://docs.expo.dev/versions/latest/sdk/image/) and [Expo background task scheduling](https://docs.expo.dev/versions/latest/sdk/background-task/)
