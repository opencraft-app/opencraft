# Infrastructure

Infrastructure code is separated from runtime implementations and product services.

| Path | Ownership |
| --- | --- |
| [`cells/`](cells/README.md) | Cell placement, lifecycle, capacity, OCM integration, deployment and operations |

Runtime hosts and isolation engines live under [`../runtimes/`](../runtimes/README.md). Generated
state, qualification receipts, cloud credentials, independent upstream worktrees, and build outputs
do not belong in this tree.
