# Gift credit priority and display correction

## goal
Prioritize gifted credits in NewAPI deduction and consistently include gifted credits in LightVela overview, sidebar, and account quota display; release both production sites and production NewAPI sets.

## non_goals
- Change Pass validity, referral reward amount, or issue additional rewards.
- Change purchased credit-pack validity, billing authorization, or subscription schema.

## requirement_refs / requirement_excerpt
- User approval on 2026-09-30: fix gifted-credit-first consumption and the affected quota displays, then release.

## interface_refs / data_structure_refs
- Pass.credit_total/credit_available and free_credit_total/free_credit_available are distinct aggregates.
- Credit packages may include the same free-credit entitlement; never count it twice.
- NewAPI PreConsumeUserSubscription retains locking, request idempotency, full-quota and tail-grace funding selection, refunds, and pacing.

## history_context
- current_design_refs: docs/engineering/domains/agent-gateway-runtime.md; docs/engineering/domains/subscription-entitlements.md.
- Existing NewAPI consumption sorts by end_time/id; free-credit entitlements have long gateway expiry and therefore lose to package subscriptions.

## acceptance
- A later-expiring free-credit subscription is selected before a package subscription when it can fund the request; exhausted/expired free credits fall back safely.
- Overview remaining, provider total/used, sidebar total/used, account progress and detail include gifted credits once.
- Preserve active Pass authorization and true paid packs.
- Focused frontend and Go tests, frontend check/build, source revision/image verification and real production acceptance evidence.

## affected_paths
- new-api/model/subscription.go and corresponding tests.
- frontend/src/domain/credit-pack.ts, frontend/src/lib, frontend/src/contexts/agent-context.tsx, account-page.tsx, agent-hero-stats.ts and focused tests.

## context_receipt
- Read root/frontend/new-api/velagw/subscription/credit/.ci AGENTS.md; release-gitops and subscription-entitlements domain packs; release engineering source; frontend adjacency card and i18n/test neighbors.

## evidence
- Current validation: 186 focused frontend tests passed; frontend check/build passed with no new TypeScript diagnostics; NewAPI full model/service tests and vet passed. Regression red observed for free-first and missing gift totals.
- Executable NewAPI sources in current master match deployed sgprod release source 77acb3f09a91; intervening NewAPI changes are only AGENTS/OWNERS/docs/catalog metadata.
- Initial duplicate-display fix: 75 focused frontend tests and check/build passed; global suite has pre-existing localStorage/CSS loader failures and OOM.
- Production host identity revalidated: VM-92-56-tencentos; required protected kubeconfigs exist.

## risks / decisions
- Single-request funding remains atomic; priority applies to eligible subscription candidates without altering settlement semantics.
- Roll back source-bound frontend artifact and managed NewAPI set image, never rewrite user balances.

## validation
- Targeted Go model/service tests; frontend focused tests/check/build; documentation impact validation.

## handoff
- Implementing and preparing approved release; no new production mutation yet.
