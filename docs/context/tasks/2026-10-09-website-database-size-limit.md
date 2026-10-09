# Remove the fixed website database-size ceiling

## goal
Remove the extra hardcoded 16 MiB website SQL database-size check, as requested by the user.

## non_goals
No changes to underlying workerd/minisandbox storage, production deployments, query/request/result limits, or credentials. No added tests.

## requirement_refs
User: “这个不应该被限制吧，这个数太低了”.

## interface_refs
`site-runtime/internal/runtime/minisandbox_worker.mjs`: sqlCapability uses the platform SQL binding. Retain transactionSync rollback, databaseSize reporting, read-only enforcement and bounded query/binding/result checks.

## history_context
Commit 8b02b4f235 introduced MAX_DATABASE_BYTES=16777216 as an extra wrapper restriction. This feature lives on codex/website-minisandbox-integration-20261002 and is not present on master. The review branch starts at the remote integration branch, excluding unrelated local infrastructure commits and repairs.

## acceptance
A SQL operation is not rejected solely because databaseSize exceeds 16 MiB. Underlying errors and per-request protections still propagate.

## affected_paths
Runtime worker wrapper, website-builder Skill and formal runtime domain documentation.

## required_context / context_receipt
Read root/site-runtime AGENTS.md, subscription-entitlements and agent-gateway-runtime domain packs, formal runtime domain docs, and skill-creator instructions. Inspect wrapper constants and sqlCapability transaction checks.

## evidence / validation
Existing site-runtime race tests, go vet and go build passed. Node module syntax and Skill metadata checks passed. A temporary comparison probe confirmed the old wrapper rejects a 32 MiB database while the new wrapper accepts it, preserving read-only, result-limit and rollback guards. This probe is not live storage acceptance. Production and already deployed site packages remain unchanged.

## risks
Removing this product-layer restriction does not make storage unlimited. Storage capacity, resource limits and platform errors remain. Code changes do not alter already deployed site packages automatically.

## decisions
Remove the constant and databaseSize rejection only; retain databaseSize introspection and per-call limits.

## scan_scope / scan_output
Bounded source search in site-runtime, Skill and runtime documentation; no credential or runtime artifact copied.

## handoff
Reviewable isolated source change; production and existing deployed packages remain unchanged.
