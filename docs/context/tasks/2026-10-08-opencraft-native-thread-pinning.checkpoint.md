# Native thread pinning checkpoint

## Current stage
Implementation and scoped verification are complete. User authorized commit/push and normal merge to master. No upstream Hermes change, deployment or preview restart.

## Evidence
- Runtime, Web, daemon and Hermes plugin typechecks passed; boundary checks and Web build passed.
- Focused tests cover native metadata adaptation, serialization, stale reads, reconnect fences, profile scope, default catalog backfill and SSH adapter routing.
- Backend persistence tests use mock native stores, not deployed user sessions.
- Real sidebar/menu smoke passed desktop/touch and light/dark. Initial menu click failure was a missing desktop hover in the fixture; no product CSS changed.
- Regression sets passed 37/37 and 43/43. Added cross-page deduplication and legitimate native NULL summaries.
- Installed Codex 0.160.0 supports reserved section discovery and section-position reads in a fresh isolated home. No inference or existing user data used; native write and real Hermes remote acceptance are not claimed.
- Web build, documentation validation and actual changed-file impact check passed; mapped runtime responsibility is documented in the engineering domain.
- Global context-catalog validation fails on repository-wide existing metadata/size/scan findings; not claimed green. An initial wrong-directory empty generated catalog was moved to ignored runtime storage.

## Verification environment
Three browser setup attempts failed: missing Playwright module, unrelated dependency resolution conflict, then missing libgbm. Application dependencies were not changed. Isolated Playwright is installed under `opencraft/.runtime/thread-pins-ui-tools`; existing browser libraries are available at `/data/tmp/opencraft-browser-libs/usr/lib64`.

## Next
Submit the feature branch through the repository's normal merge request/review flow. Do not bypass review gates. Existing preview remains unchanged. Before real Hermes acceptance use its actual authorized connection; do not replace native state with bridge persistence.
