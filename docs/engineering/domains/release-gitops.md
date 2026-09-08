# 发布与 GitOps 领域

本领域覆盖源码构建、镜像/制品、环境输入、GitOps 期望、Argo 收敛和业务验收。任何一层成功都不能代替下一层。

## 交付链

```text
master 源码
  → .ci 构建与制品可见性
  → promote 分支/MR 更新 gitops
  → argocd 应用消费目标 revision/image
  → Argo Synced + Healthy
  → 服务健康、路由和业务 E2E
```

## 权威分工

- `.ci`：流水线与可复用构建/晋级命令。
- `infra_pulumi`：云资源和环境 inventory；`platform.env` 是派生输出，可能含敏感值。
- 服务 `k8s/base` 与 `k8s/overlays/<env>`：source-facing Kustomize。
- `argocd/services/<service>/<env>` 与 `argocd/apps/<env>`：deploy-facing 期望。
- Argo/集群/线上 E2E：真实运行态。

## 不变量

- 正式发布只认 Argo CD；service-local apply/release 脚本不是主线。
- Secret 值不进 Git、日志、渲染输出或文档。
- DB migration/seed 不塞进应用启动；使用受控 GitOps job 与明确回滚。
- migration version 一旦被任一长期环境记入 `schema_migrations` 即视为已占用；后续把该 SQL
  合并进较早版本或从源码删除，都不能再次复用这个编号。新 schema 变更使用未占用的新版本，
  版本号允许不连续；环境已紧急补过同一 DDL 时，forward migration 应幂等收敛并正常推进版本，
  不直接删除或伪造迁移记账。
- release plan 检查 merge commit 的 source diff 时，必须比较 merge 结果与第一父提交；不能依赖
  `git diff-tree <merge-commit>` 的默认输出，否则文件变更可能被静默识别为空，导致依赖 source diff
  的 migration 与依赖门禁漏报。
- 未经用户明确授权，不构建付费制品、不更新 GitOps、不 apply、不发布。
- 修改 `.ci/runtime/`、`argocd/`、`infra_pulumi/` 或 `codesign/` 时，先定位当前交付设计并同步更新映射的正式设计文档；`docs-impact` 只验证同一变更集含设计更新，不能代替平台 Owner 审阅。
- 接管已经存在的 Deployment、StatefulSet 或 StatefulSetPlus 时，GitOps manifest 必须沿用 live 对象的 `spec.selector`；该字段不可变，不能为了补充组织标签而扩展。新增标签只能放在允许变更的 metadata/Pod template，并确保 Pod labels 继续匹配 selector。发现 selector 漂移时先修 `master` 真源，再由流水线投影到 `gitops`，不直接热修 `gitops`。
- 生产镜像 promote 只有在 staged diff 符合该服务的 pin-only 合约时才允许自动合并或自动同步。VelaGW 的 pin-only 合约仅允许目标环境 `velagw-platform.env` 中的 `VELAGW_IMAGE` 与 `VELAGW_DEPLOYED_AT` 变化；Kustomize 结构、NewAPI release pin 或任何其他 deploy-facing 配置变化必须关闭自动合并和自动同步，先审查差异并回填 `master` 真源后重新生成候选。

## 跨服务计费能力的发布门禁

- 跨 Trade、CTL、Sandbox 的能力必须先在同一个候选源码 revision 上完成三个服务的
  test/vet、受影响包 race、migration up/down 和配置 contract，再构建镜像。
- migration 必须先于常驻 workload 镜像。测试环境若删除了 migration Job，需在受控
  临时执行器中手工迁移并回读版本；常驻环境的固定名 Job 必须变更名称或时间戳，不能因
  Job 对象仍在就假定新 migration 已执行。
- 外部计费 CategoryID 和资源池映射属于独立前置。只有计费变更已发布到目标环境、DB
  schema ready、目标 Pool/SKU/Plan 可用后，才允许 seed 启用入口；seed 必须在镜像之后，
  且有精确、幂等、拒绝歧义数据的回滚脚本。
- 测试环境验证必须记录订单/flow、业务实体、权益和底层资源联合终态。国内与国际是独立
  发布面；国内灰度稳定观察完成前，不用国内结果替代国际站放行。

## CloudLadder Gateway 回调环境

`tkexgz` 的三个 CloudLadder Gateway workload 共享路由定义，但通过各自
StatefulSetPlus manifest 中的
`CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_BASE_URL` 隔离默认计费回调环境：

- `lightvela-proxy`：回调北京环境 `https://lightclaw.tech`。
- `lightvela-proxy-staging`：回调北京环境 `https://lightclaw.tech`。
- `lightvela-proxy-testing`：回调北京7环境
  `https://api-sandbox-bj-7.lightclaw.tech`。

环境差异必须保留在 `argocd/services/cloudladdergateway/tkexgz/` 下对应的
`statefulsetplus*.yaml` 中，不通过修改共享路由默认值实现。修改 testing 默认回调时，
不得连带修改 prod、staging 或地域专用的 `jifei-callback-<region>` 路由。

## Secret 交付

- 环境 Secret 的长期真源是 SSM；`master` 中的 SOPS 文件是 source-facing 快照，`gitops` 中的 SOPS 文件是 deploy-facing 期望。修复顺序必须是 SSM → `master` → `gitops`，不能只 patch live 或只修改 `gitops`。
- SSM manifest 应声明运行时必填键。重新导出时缺少 required key 必须失败，避免后续 promotion 静默删除 live 已有凭据。
- SOPS 每次加密的密文可以不同。判断 Secret 是否一致必须在受控环境中比较解密后的键集合和值，或比较逐键安全摘要；仅看到密文 diff、MR 已合入或 Argo `Healthy` 都不能证明语义一致。
- live hotfix 后，即使业务已经恢复，也必须补齐 SSM、`master` 和 `gitops`。执行 Argo Sync 前先确认 deploy-facing 明文语义与 live 一致，否则 Sync 可能把正确的 live Secret 覆盖成旧值。
- Secret 只更新对象数据时，Pod 不会自动重启。需要运行进程读取新值时应单独执行受控 rollout，并分别验证 Secret、Pod 环境和业务请求；不要把 Secret `Synced` 等同于进程已生效。
- 跨服务运营 BFF Token 必须在同一环境内从服务端真源复制到消费方 SSM，并由 manifest 固定明确版本、声明 required key 后生成 SOPS；禁止跨地域复用或只在 live Secret 中临时补键。

相关 Journey：[源码到生产](../journeys/source-to-production.md)。Agent 摘要：[release-gitops Context](../../context/domains/release-gitops.md)。
