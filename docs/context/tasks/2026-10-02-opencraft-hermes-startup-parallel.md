## goal
Reduce OpenCraft Hermes Host readiness latency by overlapping independent startup reads, and make the first conversation-list request observable end to end.

## non_goals
- No production deployment, backend protocol change, optimistic capability advertisement, or persistent conversation-list cache.

## requirement_ids / requirement_refs / requirement_excerpt
- User request (2026-10-02): parallelize the Hermes bridge startup bottlenecks, include conversation-list loading, and create an MR.

## interface_refs / data_structure_refs
- `HermesBotAppServerHandler.prepareCapability` owns Bot catalog and group capability negotiation.
- `HermesAppServerAdapter.listThreads` owns `session.list` and cursor projection.
- AppServer `initialize` must report only capabilities confirmed by the current connection.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/plugin-architecture.md`.
- `relevant_evolution`: the current bridge resolves instance Bot bindings, native profiles, then hosted-room capability serially.
- `superseded_refs`: none.

## acceptance
- Independent startup reads overlap; failures preserve the existing capability and error semantics.
- First `thread/list` latency is logged without user data; no stale list is introduced.
- Focused tests, typecheck, and boundary checks pass; MR contains only this change.

## affected_paths
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/`
- `opencraft/plugins/lightvela-hermes/src/transport/`
- `opencraft/tests/`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Root `AGENTS.md`, OpenCraft `AGENTS.md`, OpenCraft maintenance skill, platform and plugin architecture.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@origin/master` | Repository safety and verification | Scope and MR boundary |
| `opencraft/AGENTS.md@origin/master` | Service ownership | Host/readiness contract |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@origin/master` | Architecture maintenance | Avoid optimistic capabilities |
| `opencraft/docs/platform-architecture.md@origin/master` | Host readiness | Keep resource restoration separate |
| `opencraft/docs/plugin-architecture.md@origin/master` | Plugin ownership | Keep changes in Hermes bridge |
| `docs/engineering/domains/agent-gateway-runtime.md@origin/master` | Cross-service runtime contract | Record capability-read ordering and fresh list boundary |

## evidence
- Context route matched no Pack; bounded exact searches located the startup calls.
- Baseline source: `resolveActiveBot` refreshes Bot list; `prepareCapability` serializes bindings, profiles, groups; `thread/list` follows Host readiness.
- Focused Hermes plugin tests: 97 passed. Bot management tests: 32 passed. Hermes plugin `tsc --noEmit`, platform boundaries, typography, documentation validation, and staged change-impact check passed.

## risks
- Parallel reads can reveal an error before sibling reads finish. Await both and preserve the prior error priority; tests cover it.
- Prefetching session lists could serve stale data, so this change will not add an unversioned list cache.

## validation
- Focused Hermes tests; OpenCraft typecheck and boundaries; documentation/change-impact checks.

## decisions
- Parallelize only independent capability reads. Keep `thread/list` a fresh read and add stage timing; speculative caching requires a separate invalidation design.

## scan_scope
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/`, `opencraft/tests/hermes-profile-bots.test.ts`.

## scan_output
- Exact `prepareCapability`, `refreshCatalog`, and `listThreads` definitions found.

## handoff
- Ready for MR review; no runtime benchmark yet because the current browser has no accessible authenticated Hermes tab. The MR must not claim a measured reduction of the reported eight seconds.
