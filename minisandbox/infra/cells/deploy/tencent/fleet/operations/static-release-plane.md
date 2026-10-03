# 静态发布面与自治运行面的边界

本集群使用真实 Argo CD 作为很窄的静态发布面：保存 Git 中的期望版本、检测并修复已授权的静态字段漂移，并把不一致反馈给自治门禁。Argo CD 部署在 C/管理集群；Pod、Node、FDB 和容量仍由 Kubernetes 与 Actor Fleet 控制器自愈。不得再实现第二套 Git watcher、diff 或通用 desired-state reconciler。

## 不变量

1. 只有发布流程可以改变组件 image digest、源码 revision 和 source-manifest hash。
2. 发布真值必须来自 Registry 远端可解析的 digest；本地镜像 ID、tag 和 Buildah `FromImageDigest` 都不是发布真值。
3. rollout 前，候选 digest 必须在所有目标节点以 `imagePullPolicy: Always` 拉取，并执行该组件的固定 probe 命令。
4. 运行态必须同时满足：workload 期望 digest、Pod `imageID`、OCI source label 和最近资格 receipt 的 release binding 一致。
5. 静态发布面不写动态容量字段。资格或 operation lock 存在时，它只报告漂移，不发起同步。
6. 自动同步失败不能触发 Node/Machine 更换；Registry、DNS、FDB、COS、NATS 等共享故障不得归咎于单节点。
7. 一段 workflow 只能有一个共享内核锁所有者。`run-autonomy-ops-cycle.sh` 自己持锁覆盖 pre-audit、action 和 post-audit，不能再嵌套在持同一锁的 supervisor 下。后续完整 qualification 使用 supervisor，并重新核验 release 身份；中间不合格状态不能开放 placement。

## 字段所有权

| 对象/字段 | 唯一所有者 | 静态发布面行为 |
| --- | --- | --- |
| CRD、RBAC、Service、NetworkPolicy、PDB | 静态发布面 | 检测；通过 dry-run 后可自愈 |
| Deployment/StatefulSet Pod template、固定 ConfigMap schema | 正式 release workflow | 仅对照已晋升 release ledger；不得自行选择新版本 |
| image digest、source revision、manifest hash | 正式 release workflow | 检测 workload、Pod 和 receipt 是否一致 |
| Deployment/StatefulSet `spec.replicas` | HPA / Host drain | 忽略差异 |
| MachineSet `spec.replicas`、drain/repair annotation | runtime-capacity controller | 忽略差异 |
| FDB process count、scale operation、PV quarantine | FDB autoscaling controller | 忽略差异 |
| Node admission label/taint/state annotation | runtime admission controller | 忽略差异，只校验不变量 |
| Secret 数据、短期 OIDC token | credential/rotation workflow | 不保存明文；只校验 Secret 引用与轮换健康 |
| qualification receipt、operation lock | qualification/governance workflow | 只读，作为同步门禁 |

## 已落地的最小实现

当前代码已经实现：

1. `release-runtime.sh` 在所有 rollout 和数据健康门禁通过后写入 Cell 级 release ledger，并保存同内容的外部 receipt。ledger 记录组件、远端 digest、两套 source identity、probe 合约和静态 spec 指纹。
2. runtime Host 更新时先把现有 `spec.replicas` 交还给容量控制器，再从 SSA 文档删除该字段；fresh install 才使用三副本 bootstrap 值。rollback 的所有权恢复同样排除 replicas。
3. `autonomy_audit.py` 周期读取 ledger，并比较 workload 静态 spec、Ready Pod `imageID`、ConfigMap 内容和外部 receipt；不一致直接关闭 autonomy verdict。
4. 现有 `rivet-cell-reporter` 用只读 RBAC 完成集群内相同审计，通过 Prometheus 暴露 Cell 级收敛、findings 数和漂移年龄，并写入 `RivetCellReport.spec.staticRelease`。
5. Grafana Hub 只聚合低基数 Cell 指标，不携带 release ID、Pod、Actor 或对象 key。

6. 本地三集群在 C 中运行固定版本的真实 Argo CD；A/B 使用 namespace-scoped、ConfigMap-only 的凭据，并通过 `resource.inclusions` 和 AppProject 双重限制缓存与写入范围。
7. 本地资格门已证明：A 漂移自愈、Application Controller Pod 替换后 B 漂移自愈，同时 A/B runtime StatefulSet UID 与动态副本数均不改变。

Argo CD 只接管经过所有权故障矩阵的静态对象，并配置以下约束：

- 关闭 prune，直到每个对象有明确的删除协议。
- 对 replicas、状态 annotation、Node/Machine/FDB 控制字段配置差异忽略。
- 禁止 Argo CD 直接推进镜像 tag；release ledger 中只允许 digest。
- `RespectIgnoreDifferences=true` 必须与 replicas 等忽略规则同时存在；只有 ignore 规则不足以阻止 sync 写回。
- operation lock、资格运行中或 release binding 不一致时不得执行 runtime 发布 Hook。
- Argo CD 的健康只是一条证据，不能替代发布预检、事务回滚和生产资格 receipt。

Argo CD 自身必须放在 C/管理集群；A/B Cell 的请求、对象唤醒、容量控制和数据恢复均不得依赖它在线。已验证的 ConfigMap canary 使用 `prune=false`、`selfHeal=true`。CRD、RBAC、Service、NetworkPolicy、PDB 只有在各自所有权和删除故障矩阵通过后才可逐类加入白名单。workload image/ConfigMap 的发布字段仍只能由串行 release workflow 晋升；该流程后续作为 Argo Hook 可视化，但 Argo Sync/Healthy 不等于公共 `/v1` 发布成功。

这个定位等价于“GitOps 负责静态声明，Actor Fleet 负责运行态收敛”。它避免第二套容量控制器，也保留未来替换 Argo CD 的自由。
