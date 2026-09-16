# Sidebar account menu boundary

The sidebar account surface is independent of the public header's avatar behavior. The public `UserAvatarMenu` entry selects the appropriate child before any sidebar-only billing hooks mount.

## Ownership

- The sidebar controller owns session identity, account/context reads, locale-aware links, eligibility and navigation actions.
- The menu view owns presentation and Radix focus/open state. It receives explicit display data and callbacks; it must not import account-page, Repository/Session/OpenClaw contexts or credentials.
- `lib/use-account-pass-summary` owns a cancellable read-only fallback and exposes the chosen pass, derived credits, load state and explicit fallback clearing. The caller supplies `listMyPasses`; this hook does not refresh the shared Agent context or change subscriptions.
- `lib/account-pass-summary` owns the shared pass selection helpers, credit arithmetic, name precedence and existing outer renewal gate. `usePassUpgrade` remains the authority for upgrade eligibility; the order endpoint still rechecks it.
- The account page retains its original sections, renewal/delete flows and refresh ownership. The sidebar adds only a navigation shortcut to the existing purchase flow.
- `lib/window-command-chain` only registers and removes this feature's contiguous `window.show`/`window.hide` wrappers. Header, sidebar and upgrade rollout retain their own effects and return-value policy. Removing a consumer skips its callback even when unmount order differs from installation order; a later external command owner is never overwritten. This helper does not own rollout visibility or upgrade eligibility.

## Invariants

1. Validate current user ownership before choosing modifying → active → first nondeleted fallback. Account/pass changes invalidate old visible state during render and prevent late responses from publishing stale credits. Fallback results, requests and clear callbacks share a non-reusable generation, so A → B → A cannot let the first A action clear the later A result or request.
2. Credit total/available come from that chosen pass. Used is `max(0, total - available)`; percentage follows the account's rounded/capped formula. Loading, failure and absence are distinct from a legitimately loaded zero balance.
   A legacy current Session subscription may still provide the plan name without a Pass. Preserve that name, but label its unavailable quota as unknown and withhold the upgrade shortcut; do not infer credits from the subscription code or the old OpenClaw user-plan object.
3. The upgrade shortcut retains the original region/billing/nonmodifying/renewal and upgrade-options conditions. It navigates to the original localized subscribe URL with encoded `upgrade_pass_id`; it does not create an order.
4. Portal content must remain reachable outside the fixed sidebar's clipped box. Upward is preferred; collision/available-height handling may reposition or scroll the popup at short viewport heights.
5. Opening focuses the user heading, not a destructive action. Keyboard Escape closes a nested language surface before the account surface, returning focus to each corresponding trigger. The language popup prefers above at narrow widths and the side at wider widths, while retaining collision and available-height limits. Existing language reload, hidden workbench and logout contracts are preserved.
6. On the domestic site, both sidebar and header avatar menus expose “建议反馈” by default using `PRODUCT_FEEDBACK_URL`; this item does not depend on `window.show()`. It remains an external link with `noopener noreferrer` and closes its menu when activated. The Agent sidebar no longer renders a separate feedback link. The international site still omits this questionnaire entry; feedback visibility does not change billing or hidden workbench eligibility.

Validation evidence belongs to the current sidebar increment in `frontend/openspec/plan.md` and its Task Pack. UI fixtures use synthetic account values and do not demonstrate a live billing transaction.

## Local acceptance state

The default local mock may have no Pass. In that state the account page and sidebar must not invent a balance or upgrade eligibility. The explicit mock-only `passState=sidebar-demo` preset provides a synthetic owned active Pass and matching upgrade option for inspecting both existing views; the plan name identifies it as a demo. Use the same query on `/agents/automations/` and `/account/` when comparing values. Removing the query restores the normal mock data, and upgrade order methods remain unavailable. This preset does not enable any live billing capability or change the production controller's gates.
