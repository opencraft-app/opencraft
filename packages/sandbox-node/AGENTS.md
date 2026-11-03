# Node sandbox adapter owner

Follow the [shared contract owner](../sandbox/AGENTS.md) and [execution sandbox contract](../../docs/execution-sandbox.md). This package adapts providers and transports; it does not choose an execution backend from the operating system.

- Deployment assembly selects an owned private runtime configuration and an installed provider. Reject invalid configuration, unavailable providers or denied admission without falling back to bare host execution. Only the Linux provider may select `local-inherit`; remote payload environments select named entries.
- Keep trusted controller environment and task environment separate. Task PATH, loader variables and credentials must not configure the privileged launcher. Use private envelopes/files; never expose payload environment values in argv or diagnostics.
- Linux resource limits must exist before payload execution. Verify effective kernel CPU, memory and task limits, including ancestor domains. Defaults are 4096 tasks including threads per environment, 16384 per pool and 65536 FD per process; FD is not an aggregate environment cap.
- A configured parent slice must have finite CPU, memory and task limits. Shared host ceilings, retained-generation bounds, SSH/Core priorities and headroom are deployment responsibilities. A controller-local pool is not global admission accounting.
- Preserve stdin EOF, output, PTY input/resize and foreground signal behavior. Owner shutdown and cancellation await complete descendant cleanup; do not release capacity on uncertain cleanup or take over another owner's unit.
- Keep Codex Native permissions and the official executor, DSH SDK timeout/PTY semantics, Pi worker lifetime and Git physical-origin/lease validation intact when changing transports. Root identity compatibility is explicit resource containment, not a claim of adversarial isolation.
- For enforcement changes, use the existing opt-in Linux smoke and relevant real engine probes. Inspect cgroup/rlimit values, fork inheritance and cleanup rather than testing resource exhaustion on shared services. Never target existing business units with a synthetic smoke.
