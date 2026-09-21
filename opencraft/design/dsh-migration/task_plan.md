# DSH migration plan

1. Inventory HyperNode execution/Turn/Item/tool/history boundaries — complete.
2. Import source implementations and supply local host ports, removing duplicate folds — complete.
3. Integrate one ledger with events/history, cancellation and reconnect recovery — complete.
4. Regression matrix, real DSH synthetic smoke, full gate and desktop build — complete for the local execution-core boundary.

Scope: DSH adapter behavior; retain product-owned models/credentials and local HTTP runtime transport. Do not import SSH/cloud tenancy or change user data. No commits or paid requests.

Errors: initial extraction command had an extra brace (corrected before any output); one patch expected outdated test lines (reread then patched); old assertions assumed interruption commentary, textual timeout heuristics and local todo Items. Updated tests to the actual imported source contracts, explicitly recording the timeout heuristic difference.

UI verification: development CJS interop failed before bootstrap; switched to production preview. Initial two-visible-replies assertion was invalid for a virtualized list; replaced it with runtime membership assertions plus visible reply after send/reload. The production smoke passes, while reload/unload logs a separate existing Host registry disposed lifecycle warning. This frontend warning is not fixed by this migration.
