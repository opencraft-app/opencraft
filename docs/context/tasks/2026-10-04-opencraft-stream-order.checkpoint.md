## stage
Implementation, focused verification, mapped documentation and whitespace checks complete; source-only handoff remains.

## verified
- The previous partial-index global sort and unguarded delayed snapshots reproduce ordering/content regressions in deterministic tests.
- The combined 148/148 suite passed (90 Session/Navigation/Chat Runtime/Workbench plus 58 virtualizer tests), including held-response transport interleavings, cached navigation baselines and foreign Thread fencing.
- Real Conversation smoke passed desktop and touch-sized Chromium, eight interleavings each, stable order/live DOM identity and preserved text through completion; no page errors.
- The smoke discovered and verified a separate mounted-window count bug; the virtualizer now preserves surviving row identities across intermediate history insertion.
- Session, Workbench Runtime, Web and virtualizer typechecks, typography generation check, platform boundaries and documentation validation passed.
- Explicit-path documentation impact check passed and found the mapped agent-gateway-runtime design update. Staged check also passed with an empty staged set; no files staged.

## unverified
- No physical phone, Electron or running-preview validation. Current preview is unchanged.

## discard
- Do not globally sort task history by timestamps, Item IDs or Dot's comparator. Dot and ordinary task renderers/scrollers remain separate.
- Chromium dependency failures were resolved with portable temporary libraries; no system package installation. The subsequent DOM remount failure was real, separately reproduced and fixed.

## restore
- See 2026-10-04-opencraft-stream-order.md for scope and ownership decisions. Preserve unrelated dirty worktree edits.
- Actual Node executable: /data/node-v26.7.0-linux-x64/bin/node. Browser smoke is scripts/smoke-conversation-history-order.ts.

## next_action
- Hand off source-only changes and verification limits. Do not restart or deploy without a new user request.
