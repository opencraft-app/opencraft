# Local mesh manifests

This directory contains declarative Kubernetes and Helm input. Executable installers,
qualification gates, and renderers remain one level above it so generated state is never confused
with source manifests.

| Directory | Applied to | Purpose |
| --- | --- | --- |
| `controller/` | Hub | Local image overlay for the production fleet controller |
| `placement/` | Hub and spokes | Local OCM placement fixtures, evidence producers, and API doubles |
| `observability/` | Hub and spokes | Pinned Helm values and the private federation Service |
| `data-plane/` | Spokes | Templates for optional real FDB-backed runtime Cells |

The local environment intentionally reuses the production controller, runtime, FDB Operator, and
federation definitions from `deploy/tencent/fleet`. Files here are narrow local overlays or
fixtures, not an alternate production state machine.

Each runtime cluster models the production failure-domain split with one
`rivet.dev/control=true` server and one
`rivet.dev/compute=true:NoSchedule` agent. When the host provides `/dev/kvm`, only that compute
agent additionally advertises `rivet.dev/pvm=true`; the Hub never carries either execution label.
The local renderer maps workerd/V8 to the compute role and maps Engine, NATS, and the runner-config
initializer to the control role. The PVM runtime additionally requires `rivet.dev/pvm=true`.

Rendered manifests and generated federation target values belong under the local mesh state
directory (`${XDG_STATE_HOME:-$HOME/.local/state}/rivet-local-mesh`), never in this tree.
