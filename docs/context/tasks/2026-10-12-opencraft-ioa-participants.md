# IOA session participants

## goal / authority
User approved IOA plugin implementation: a round +N badge on each conversation,
with employee English login names in its click popover. N is distinct verified
authors of actual user messages, including self, not viewers or Turn count.

## context_receipt
Root/local AGENTS and context route identity-access; OpenCraft maintenance Skill,
verification reference, plugin architecture, existing sender store/projection,
Codex adapter/history/queue routing, sidebar item/menu owner, contribution registry
and native thread catalog query. The identity-access pack is an auth-service
false-positive for this Host-local conversation presentation change.

## design
IOA owns participant projection, RPC and badge. Generic Host offers metadata hooks
and native message-ID reads; generic sidebar exposes an extension badge slot.
Derived message presence lives in the same codex-host-queue.sqlite, never a second
file. Initial/reconnect full history reconciliation excludes stale/unused sender
bindings; live user Items and targeted Turn reads update presence. Fork and rollback
reconcile actual retained history. Distinct set changes notify all initialized
readers of this Host, not just the active conversation subscriber.

## acceptance
Dedup A/A/B, in-Turn steer, failed/cancelled queued submissions, accepted input
despite model failure, unknown author, restart, fork/rollback and late history reads.
Real badge/popover: circular +N, sibling button, no selection, mutual exclusion,
keyboard/Escape, live update, mobile/desktop/light/dark. Unsupported Hosts show no
fabricated capability. Names are metadata only and never enter model input.

## status
Implemented. 62 focused tests pass; plugin, daemon, Web and public-port typechecks, i18n and import-boundary checks pass. Real Sidebar smoke covers mobile/desktop, light/dark, live updates and overlay/keyboard ownership. Packaged Web proves round +3 and English-name popover through the real patched Host RPC and IOA controller with synthetic native/TOF fixtures in isolated data. Packaged signed-handshake and real native SSH Desktop readonly checks pass. Current preview cutover pending; master review gate remains in force.

Preview acceptance found a real retained conversation exceeding the initial 10,000-item scan bound. Larger 1,000-item pages with a 1,000-page hard bound restore complete reconciliation; each row now reports its own failure without failing other conversations. A copied Host sender DB and readonly native AppHost bridge reproduce the real catalog in isolation: all 17 visible badges now resolve (+0/+1/+2). Seven participant tests include a failing-history row beside a successful row. Guarded cutover automatically restored the prior healthy preview on the failed initial acceptance.

Guarded current-preview cutover passed on 2026-10-13: build `20261013-ioa-participants-r2`, runtime SHA256 `710f24fa2fba120f775b6666e7092b55ce2fb5a94d03437df3bd3a90ba7ac5af`, existing data directory preserved. Reconnected process verifies actual native history, IOA capability/RPC and exact conversation circle/popover; no submitted turns or mocked participant requests. Delivery receipt: `/data/tmp/opencraft-ioa-participants-preview-20261012/delivery.json`. Source commits `0216b8746`, `9e8747f9b`, documentation `20b18b561` are pushed. Master merge still pending platform validation.
