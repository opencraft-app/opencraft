# Management Workers API Argo adoption — 2026-09-11

The Beijing management cluster C adopted its already qualified Workers API
through the bootstrap flow in this directory. C remains the management/API
plane; it is not a third runtime Cell.

## Final evidence

- desired Git revision: `db4f68c6181ed132c96b3ff3f07f741c0fc757ac`;
- Application: `actor-management-workers-api`, 11/11 resources Synced and
  Healthy, zero conditions, no resource finalizer;
- private endpoint: `http://10.160.0.17:6688`;
- Deployment UID preserved:
  `cdbaf04e-29dd-4475-82ab-50e0a94b0b75`;
- private CLB Service UID preserved:
  `e19ccd40-b71a-4ee4-9a11-7380d7ffdcea`;
- external token Secret UID preserved:
  `f902d2b5-2b6e-4c9d-9c2a-6b4fbe03b9d2`;
- A remained pinned to `17aedf69b94845bc88cd11b04db308e5901330ba`;
- B remained pinned to `d2c4afd4052817c51666b1c3c31c47da087fe19b`;
- both Cell Applications ended Synced/Healthy;
- `/readyz` and the existing public `/v1/workers/<name>` lookup passed through
  the private CLB after adoption;
- drift injection on `Deployment.spec.revisionHistoryLimit` was automatically
  repaired to `3` without a Pod-template rollout.

The immutable convergence receipt has SHA-256
`d754e270596f876a0ce7136ff4e1d558410664284f06cc974de4f7f125ec58da` and
was uploaded and read back byte-identically from:

```text
actor-qualification-evidence-prod-bj-c01-nv1-1388575217/
  receipts/v1/sha256/d754e270596f876a0ce7136ff4e1d558410664284f06cc974de4f7f125ec58da/
  management-workers-api-argocd-convergence-3fd0c497c.json
```

## Bootstrap findings closed by the gate

1. The bootstrap host's unqualified `python3` is too old for this source. The
   operation explicitly selects the already qualified `python3.11`.
2. Argo may report an Application Synced/Healthy while every desired resource
   has an `ExcludedResourceWarning`. Success now requires 11 tracked resources,
   each individually Synced, and zero Application conditions.
3. A global `clusters: ["*"]` discovery inclusion made A/B Apps Unknown. The
   Workers kinds are scoped to C's service alias and its bootstrap-derived
   Kubernetes Service IP; both Cell sources and health are verified afterward.
4. Argo documents that discovery-policy changes can retain old controller
   cache entries. Bootstrap restarts the application-controller only when the
   canonical inclusion set changes, then hard-refreshes C/A/B.
5. The A/B route ConfigMaps and two credential Secrets are precise external
   ownership roots. They are ignored by exact name, never by wildcard, and
   Secrets are absent from both discovery and AppProject write permissions.
6. Git publication is CAS and ACK-loss safe. A replay after a successful push
   can recover its receipt only if the reviewed base is an ancestor and the
   current target tree is byte-identical.
