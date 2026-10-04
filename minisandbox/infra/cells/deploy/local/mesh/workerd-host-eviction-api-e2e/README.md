# Host eviction 真实 API 门禁

这条隔离门禁使用已存在的本机 `k3d-rivet-mesh-hub`，不重建集群，不修改 A/B
Host、Node、MachineSet 或生产 controller。使用缓存 digest 的 pause 容器和 management
stats double；**不证明真实 Actor 迁移、generation、目的 AZ 容量或云上最终缩容**。

它创建独立 GenerateName namespace、单副本 StatefulSet、PDB 和仅匹配该 namespace
UID label 的 TLS validating webhook。清理只按 exact UID 移除自己的 webhook/namespace，
不强制终止、不绕过 TLS、不读取业务日志和 Secrets。

验证项：

- 实际 PDB 429 保留原 Pod。
- 暂停实际 CREATE eviction admission，取消 metadata CAS 后释放，迟到 eviction 返回 409。
- GET 确认属于原 workload/Pod/epoch/RV 的取消凭据。
- Pod condition RV → metadata CAS → stale DELETE 的**真实存储前置条件**拒绝。
- 取消后的 PDB reservation 由真实 controller 自然过期恢复；不清状态或放宽 PDB。
- 新授权 eviction 后，同名新 UID 不继承旧取消 token；旧 UID eviction/cancel 都被拒绝。

Kubernetes eviction 的内部 Update/Delete 不经过外部 DELETE admission webhook。
因此第四项不是拦截真实 server 内部 condition/delete 窗口；receipt 明确保留
`intraServerConditionDeleteWindowObserved=false`、`claimEligible=false`。
参考 [固定版本官方实现](https://github.com/kubernetes/kubernetes/blob/v1.35.5/pkg/registry/core/pod/storage/eviction.go)。
本地通过仍不能直接打开云上的 repair 开关，TKE 当前版本与实际调度链需另行核验。

先将已有 k3d kubeconfig 保存到 `/data/tmp` 的 `0600` 文件，禁止输出内容。桥接地址用
本机 Docker 网络的实际 gateway，不是猜测地址。所有工作目录、cache 和 receipt 在 `/data`。
`k3d cluster list -o json` 包含 env/join token，禁止直接输出；仅经 `jq` 投影已审核的
cluster/node name 与 running 计数。不要打印 Docker/kubeconfig 或完整环境。

```bash
cd minisandbox/infra/cells
env GOWORK=off GOTOOLCHAIN=local TMPDIR=/data/tmp \
  HOST_DRAIN_EVICTION_E2E_KUBECONFIG=/data/tmp/eviction-api/hub.kubeconfig \
  HOST_DRAIN_EVICTION_E2E_CONTEXT=k3d-rivet-mesh-hub \
  HOST_DRAIN_EVICTION_E2E_BRIDGE_IP=172.18.0.1 \
  HOST_DRAIN_EVICTION_E2E_RECEIPT=/data/tmp/eviction-api/receipt.json \
  go test -tags integration -run '^TestRealKubernetesFencedEviction$' \
    -count=1 -timeout=7m -v ./internal/hostdrain
```

没有显式配置时测试跳过；远程 API、非指定 context 和非本地 hub 节点会被拒绝。
webhook 短时 barrier 仅作用于新建测试 namespace 的 eviction，不影响既有资源。

本机 `v1.35.5+k3s1` 已通过一次（143.35秒），完整非敏感receipt在
[20261004-k3s-v1.35.5.json](evidence/20261004-k3s-v1.35.5.json)，11项checks通过且自己的
namespace/webhook已清理。云上TKE为`v1.30.0-tke.22`，本地结果不能转为云Claim资格。

共享 fixture 重构后的本地真实 API 回归也通过（147.43秒），见
[新回执](evidence/20261004-k3s-v1.35.5-shared-fixture.json)。12项检查包括新增 Node UID
全程不变；仍是 local scope/claimEligible=false。原 loopback/context/single-node guard
未放宽。云上使用[独立受锁入口](../../../tencent/fleet/qualification/host-eviction-api/README.md)，
不得把这里的本地通过转成 TKE 通过；新回执路径拒绝覆盖旧文件。
