# Raise the website database-size ceiling to 256 MiB

## goal
Raise the single-site SQL database-size ceiling from 16 MiB to 256 MiB, following the user’s final request.

## non_goals
No changes to underlying workerd/minisandbox storage, production deployments, query/request/result limits, or credentials. No added tests.

## requirement_refs
User: “设置成256吧” supersedes the preceding request to remove the ceiling.

## interface_refs
`site-runtime/internal/runtime/minisandbox_worker.mjs`: sqlCapability uses the platform SQL binding. Retain transactionSync rollback, databaseSize reporting, read-only enforcement and bounded query/binding/result checks.

## history_context
Commit 8b02b4f235 introduced MAX_DATABASE_BYTES=16777216 as an extra wrapper restriction. This feature lives on codex/website-minisandbox-integration-20261002 and is not present on master. The review branch starts at the remote integration branch, excluding unrelated local infrastructure commits and repairs.

## acceptance
A SQL operation succeeds at a 256 MiB reported database size and rolls back when reported database size exceeds 256 MiB. Underlying errors and per-request protections still propagate.

## affected_paths
Runtime worker wrapper, website-builder Skill and formal runtime domain documentation.

## required_context / context_receipt
Read root/site-runtime AGENTS.md, subscription-entitlements and agent-gateway-runtime domain packs, formal runtime domain docs, and skill-creator instructions. Inspect wrapper constants and sqlCapability transaction checks.

## evidence / validation
Node module syntax and Skill metadata checks passed. A temporary comparison probe confirms a 32 MiB database is rejected by the previous 16 MiB wrapper and accepted by the new wrapper. The new wrapper accepts exactly 256 MiB and rejects 256 MiB plus one byte with rollback. Read-only and result limits remain intact. Existing site-runtime race tests/vet/build are rerun for this final revision. This probe is not live storage acceptance; deployed packages remain unchanged.

## risks
Raising this product-layer ceiling does not override underlying storage limits. Storage capacity, resource limits and platform errors remain. Code changes do not alter already deployed site packages automatically.

## decisions
Set MAX_DATABASE_BYTES to 268435456 (256 MiB); retain transactional database-size enforcement, databaseSize introspection and per-call limits.

## scan_scope / scan_output
Bounded source search in site-runtime, Skill and runtime documentation; no credential or runtime artifact copied.

## handoff
Reviewable isolated source change; production and existing deployed packages remain unchanged.
