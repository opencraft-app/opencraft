# Expose Bot Create Entry

## Goal

Restore the existing-instance Bot creation entry on the domestic `/agents` console so the user can continue testing the merged multi-Bot flow.

## Scope

- Show a sidebar button labeled `新建 Bot` below the active Bot profile when the existing `canCreateBot` gate allows creation.
- Reuse the merged `handleCreateNew` flow and creation dialog without changing creation semantics, limits, API calls, or global-site behavior.
- Update the focused sidebar source regression and verify the domestic page at port 5174.

## Success Criteria

- An eligible domestic account with an active Bot sees `新建 Bot` on `/agents`.
- Clicking it opens the existing `创建 Bot` dialog.
- Existing feature and plan limits still suppress the entry when creation is unavailable.
- Focused tests and `pnpm check` pass, and browser verification shows no layout overlap.

## Non-goals

- No Bot lifecycle, Profile persistence, channel, subscription, or AgentChat changes.
- No MR, merge, deployment, or production operation in this change.
