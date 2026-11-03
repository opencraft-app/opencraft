# Sandbox contract owner

Read the repository [execution sandbox contract](../../docs/execution-sandbox.md) before changing this package or adding a consumer.

- Own the backend-neutral contract, admission budget and environment lifecycle. The API is `createSandboxPool()` / `createSandbox()`, hosted by an existing execution owner.
- Request 4 vCPUs / 8 GiB by default. Validate the provider's effective resources before exposing an environment; reject mismatches. Provider capacity is an admission budget, including for remote providers.
- Keep process IDs opaque, cwd in the selected environment, and terminal support capability-based. Do not import Node, systemd, cgroup, PTY or vendor SDK types into this contract.
- Model an environment independently of a command or Thread. Command exit does not release its reserved environment budget; multiple commands may share an environment.
- Return capacity only after confirmed environment destruction. Queue cancellation must start no creation; late creation must be reclaimed. Unknown creation and failed cleanup retain capacity and their reconciliation identity, without blind retries.
- A new provider, including E2B, must implement resource enforcement, filesystem/cwd mapping and lifecycle before consumers advertise support. Preserve engine permissions and Actor/lease authority.
- Match verification to the change: contract tests cover admission, cancellation, unknown creation, failed cleanup, effective-resource mismatch and terminal capabilities; runtime claims require a real provider check. See the existing tests under `tests/execution/`.
