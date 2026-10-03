# TKE Host eviction API primitive 门禁

这是独立、显式运行的云 API fixture，不是 Actor 迁移或生产 placement 资格。
当前源码只准备入口；原 strict10k supervisor 持锁时不得执行，不重启/替换它。
本地 `TestRealKubernetesFencedEviction` 继续只接受原 loopback hub，并不增加 TKE 例外。

云入口使用 strict JSON intent，要求以下精确字段：

- `schema=minisandbox-tke-eviction-api-intent/v1`。
- `context`、私有 HTTPS `apiServer`、`clusterNamespaceUid`（kube-system UID）、`serverVersion`。
- `nodeName/nodeUid/nodeProviderId`：当前 Ready、无压力、未 cordon/无 NoSchedule taint 的控制节点。
- `callbackIp`：builder 实际私有接口；API server 必须能回连这个带精确 IP SAN/CA 的 TLS listener。
- `fixtureImage`：目标完整 inventory 的 `observability-busybox@sha256:...`，不使用 public tag。
- `adapterHashes`：`controller.go`、`topology_adapter.go`、`topology_capacity.go` 实际 SHA-256。

intent 不包含凭据；生成时只投影上述非敏感字段，kubeconfig 作为受保护路径选择器。
身份漂移或未知字段、重复 JSON key、缺失 hash 在写 fixture 前失败。不通过关 TLS、放开
公网监听、更改 Node/路由/安全组来掩盖回连失败。回连仍需实际 TKE 验证，不能靠离线测试推断。

从已提交 mono2 导出完整 `minisandbox/infra/cells` 为 `infra/cells/`，使用 `.actor-source/`
revision/逐文件 manifest。运行入口必须也来自同一个 frozen snapshot。全 closure 包括 test/
wrapper/verifier，不接受额外文件或 symlink。Go toolchain 使用现有已配置 `/data` selector。

```bash
ACTOR_GO_BINARY=/data/tools/go/bin/go \
  /data/actor-build/deploy/<reviewed-source>/infra/cells/deploy/tencent/fleet/qualification/host-eviction-api/run.sh \
  /data/actor-build/deploy/<reviewed-source> <full-revision> <manifest-sha256> \
  /data/qualification/<run>/intent.json /data/protected/cell.kubeconfig \
  /data/qualification/<run>/new-receipt.json
```

入口使用既有 whole-operation lock 覆盖源码验证、Go-only 测试与回执校验。没有显式 intent
时 Go 会 SKIP；wrapper 必须找得到绑定 intent SHA 的 passed 回执，否则失败，不允许“exit0即通过”。
不要一边执行 helper 一边修改它，不要在 TAT 失联后启动第二份；续接原 invocation。

fixture 只创建新的 namespace、单副本 sleep StatefulSet、PDB 和仅匹配该 namespace UID label
的 webhook；不碰现有 Host、Node、Machine、FDB、业务 Secret 或日志。驱逐通过正常 PDB/grace，
取消 reservation 等真实 controller 自然过期；不修改 PDB status。清理必须 exact UID，
webhook UID 替换则拒绝清理，不删 successor；回执新建 `0600`，拒绝覆盖。

和本地门禁共用 PDB429、迟到 CREATE eviction→取消 CAS→409、post-condition stale DELETE
存储前置条件及同名新 UID 拒绝旧操作的 fixture。内部 condition/Delete 窗口没有被拦截，
回执始终 `intraServerConditionDeleteWindowObserved=false`、`claimEligible=false`。
即使此门禁实际通过，仍要真实 Actor generation、目的 AZ 容量和完整串行安全缩容证据；
不能据此自动启用 repair 或宣布 strict10k、完整 stateless/DO/跨 Cell 目标完成。
