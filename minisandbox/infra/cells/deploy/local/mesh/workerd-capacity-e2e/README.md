# workerd capacity E2E

This is a destructive, bounded qualification for one otherwise idle runtime Cell. It verifies the
complete capacity contract rather than only Pegboard's reducer:

1. temporarily run two workerd Host Pods;
2. require both Hosts to advertise the same hard actor capacity;
3. require power-of-K placement to reach a full Host by the first spillover Actor;
4. require the next Actor to remain pending with `no_envoys` while neither Host exceeds capacity;
5. delete one Actor, send real gateway demand to the same pending Actor, and require that exact
   Actor to acquire the released capacity promptly;
6. delete a Host Pod and require every live Actor to recover with exactly one registry owner;
7. delete all qualification Actors and restore the Engine config and StatefulSet replica count.

The harness patches the Engine's hash allocator to `samples=8` and `slot_jitter=0`, records the
complete placement trajectory, and requires both Hosts to reach their exact ceiling without
oversubscription. Power-of-K is probabilistic: independent ring pivots can deduplicate to one Envoy,
so a deployed run must not pretend that Actor `capacity + 1` deterministically produces
`[capacity, 1]`. The pure scoring reducer's bin-pack behavior is covered exhaustively by Rust tests;
this gate proves the physical capacity, rejection, reuse, and recovery invariants. Production keeps
its normal sampling and jitter. During this bounded test the ordinary allocation retry is stretched
to 10 seconds while same-Actor reuse must finish within 8 seconds. The pending Actor must therefore
recover through gateway `Wake`; the assertion cannot pass accidentally on the normal background
retry tick. The bound is short enough that Host-loss recovery remains practical in this combined
gate.
The test does not install a Pod or node autoscaler and does not claim to qualify node scale-down.

The local real-runtime profile starts one Host. The harness temporarily scales it to two; local k3d
deliberately allows those Pods to share its single compute node, so this test qualifies Actor
placement and Host failure recovery, not cloud node realization. The production manifest separately
enforces one workerd Pod per compute node with required anti-affinity. The harness disables idle
sleep while it holds the capacity set resident and restores the exact original Host environment;
automatic sleep/wake is covered by the separate mass-Agent and auto-sleep gates.

Run after rebuilding and installing the real runtime image containing the capacity-aware Envoy:

```sh
infra/cells/deploy/local/mesh/build-real-runtime-image.sh
infra/cells/deploy/local/mesh/install-real-runtime.sh
python3 infra/cells/deploy/local/mesh/workerd-capacity-e2e/run.py \
  --kubeconfig "${MESH_STATE_DIR:-$HOME/.local/state/rivet-local-mesh}/runtime-a.kubeconfig" \
  --cell local-runtime-a
```

The default receipt is written outside the repository under
`${AGENTS_DIR:-$HOME/.agents}/benchmarks/local-mesh/workerd-capacity-e2e/`.
