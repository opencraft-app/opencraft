# actor-fleet-controller OrbStack qualification receipt

状态：**本地 Kubernetes 控制面通过；北京 TKE 未执行**
日期：2026-08-16
Context：`orbstack`
Kubernetes：`v1.35.6+orb1 linux/arm64`

## Artifact

- Image：`actor-fleet-controller:e2e`
- Image ID：`sha256:6d1072b865c1601c233d3b8a2505c3a6d445e90dd5fa79eabcf54c2dfac618cc`
- Architecture：`linux/arm64`
- Size：31,522,361 bytes
- CRD SHA-256：`5805ae1a7a78a7f9c60ed787178468e49680b22ee00f79031a19fc7a484d4566`
- Dockerfile SHA-256：`2381a1aede3a327da7a62f1160515e2736ddbd7d1acd48f6b49a66a1b24ab101`

该镜像是本机资格镜像，不是可部署北京 TKE 的 registry digest。生产/TKE 试验必须另行构建
`linux/amd64`，推送授权 TCR，并记录 registry 返回的 manifest digest。

## Test isolation

- Namespace：`e2e-actor-fleet-controller-system`
- Controller replicas：2
- Watch scope：仅上述 namespace
- Pool：`e2e-beijing`
- Profile/Class：`e2e-rivet-fdb-cos-beijing-v1` / `e2e-rivet-fdb-cos-v1`
- 未调用腾讯云 API；未读写 FDB、CBS 或 COS；所有 Cell/Report 都是控制面 synthetic evidence。

## Gates

| Gate | Observation | Result |
|---|---|---|
| CRD server validation | 6 个 CRD 在真实 API server 创建；CEL transition rules 接受 | Passed |
| Empty Set convergence | `minCells=2` 的空 Pool 收敛为 2 个 `RivetCellClaim` | Passed |
| Fail closed without evidence | 两 Cell 在 Report 缺失时均为 `Qualifying`, `readyForPlacement=false`, `ReportFresh=Missing` | Passed |
| UID/generation-bound readiness | 两份同名 Report 绑定当前 Cell UID/generation 后，Cell 成为 `Ready/true` | Passed |
| Pool admission | `readyCells=2`, `admissionOpen=true`, aggregate placement `30` | Passed |
| Candidate ordering | 10-placement Cell 排在 20-placement Cell 前 | Passed |
| 50% placement close | Cell A `AdmissionClosed` 后从 admission candidates 移除；Cell B 仍可作为候选 | Passed |
| Scale-out epoch idempotence | Cell B epoch 1 令 Claim 总数 `3 -> 4`；刷新同一 epoch 仍为 `4`；epoch 2 才变为 `5` | Passed |
| Provider failure guard | 将一个 capacity Claim 标记 `Failed` 后 `failedClaims=1`, `ClaimsHealthy=ProviderFailure`，Claim 总数保持 `5`，未自动重试 | Passed |
| Report expiry | 未刷新的 Report 超过 2 分钟后 Cell/Pool 自动 fail closed | Passed |
| Leader failover | 删除 holder Pod 后，另一副本取得同一 Lease；Deployment 恢复 `2/2` | Passed |
| Proof-gated deletion | 删除 Cell A 时 finalizer 保持，`retirementProofVerified=false` | Passed |
| Complete retirement proof | 补齐 current generation、全零计数/backlog、cold/backup exact reachability、old-generation rejection、retention、artifact inventory 和 digest 后 finalizer 移除 | Passed |
| No destructive RBAC | controller service account 对 `delete RivetCell` 和 `delete RivetCellClaim` 均为 `no` | Passed |

Leader handoff：

```text
old: e2e-actor-fleet-controller-67f77d9c5f-48gnz_3382a989-2f5d-4827-ad6e-10eadda17975
new: e2e-actor-fleet-controller-67f77d9c5f-g25lz_0363f7f8-a3d8-4509-8b84-48d4efd90d79
```

Deletion block before proof：

```text
deletionTimestamp=2026-08-16T11:22:49Z
finalizer=[fleet.actor.dev/retirement-protection]
retirementProofVerified=false
```

## Static verification

The following gates passed after the live run:

```text
go test -race ./internal/fleetcontroller ./cmd/actor-fleet-controller
go vet ./internal/fleetcontroller ./cmd/actor-fleet-controller
./deploy/tencent/fleet/verify-manifests.sh
./deploy/tencent/fleet/verify-controller.sh
actor_fleet_controller_invariants=passed
```

## What this does not prove

- Report values came from synthetic manifests, not a real Cell Agent.
- No real FDB CAS reservation, placement service, CVM/CBS/COS provisioner or TCR image was involved.
- The run does not qualify Beijing TKE, TKE network reachability, TCR pull, real capacity signals or cloud
  provider Claim fulfillment.
- A trusted Report publisher is still required to measure and hash evidence. The controller validates
  binding/freshness/completeness; it does not independently execute FDB/COS qualification probes.

## Beijing TKE blocker

The target remains `actor` / `cls-0zvm1btp` in `ap-beijing`. At qualification time:

- both local tccli profiles returned `secretId is invalid`;
- local kubeconfig contained no TKE context;
- the only remote CVM available through SSH was in `ap-guangzhou` and had no CAM role;
- the in-app Tencent Cloud session redirected to the login page.

Therefore no cloud mutation was attempted. This receipt must not be relabeled as a TKE result. Resume only
after a short-lived tccli credential or restricted kubeconfig is supplied and a TCR qualification repository
is available.
