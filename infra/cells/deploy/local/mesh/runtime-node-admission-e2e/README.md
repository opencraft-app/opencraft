# Runtime Node admission k3s E2E

This destructive test creates its own temporary k3d cluster and exercises the
production runtime admission and capacity reconcilers against a real k3s API
server. The TKE `MachineSet` and `Machine` APIs are represented only by
structural CRDs. No fake Kubernetes client participates in the test.

The test proves controller restart recovery from the Node annotation, exact
probe Pod UID adoption, replacement Node UID fencing, and a three-node
`ImagePullBackOff` event that remains fleet-wide `Blocked` without requesting a
repair surge. Probe completion is injected through the Pod status subresource;
runtime executable validation remains the release workflow's separate image
preflight responsibility.

Run it with:

```bash
./run.sh
```
