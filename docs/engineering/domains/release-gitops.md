# 发布与 GitOps 领域

Pass 升配 Web checkout 在北京测试环境发布时，需协调前端、CTL、Trade 与 Service Gateway 的精确可选认证路由。先确认两步式订单/支付和票据接口可用，再开放前端；按正常测试流水线发布并验证公共扫码入口。北京配置不能代替韩国或生产对应入口的独立审查，本次不自动扩散配置。

国内正式站隐藏发布使用同样的依赖顺序：先晋级支持 checkout 的 CTL、Trade，以及上海 Gateway 的精确 `POST /v1/passes/{pass_id}/modify/order-url` 票据路由，验证就绪后才发布前端制品。前端默认隐藏，Console `show()` 只临时启用当前页面的 UI，刷新重置；不按用户白名单限制。必须分别验证默认隐藏、显式显示和重新隐藏；国际正式站不随本次发布开放。此开关不承担后端权限控制。

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
- EdgeOne Production artifact 发布必须先使用可访问的短期签名 Preview URL 完成烟测。CLI 返回的裸
  `*.edgeone.dev` URL 缺少 `eo_token` / `eo_time` 时，应根据同次部署的 project ID 和 deployment ID
  通过 Makers SDK 获取签名 URL；不得依赖 runner 出口地域绕过 Preview 认证，也不得记录签名 query
  或认证 Cookie。
- DB migration/seed 不塞进应用启动；使用受控 GitOps job 与明确回滚。
- migration version 一旦被任一长期环境记入 `schema_migrations` 即视为已占用；后续把该 SQL
  合并进较早版本或从源码删除，都不能再次复用这个编号。新 schema 变更使用未占用的新版本，
  版本号允许不连续；环境已紧急补过同一 DDL 时，forward migration 应幂等收敛并正常推进版本，
  不直接删除或伪造迁移记账。
- release plan 检查 merge commit 的 source diff 时，必须比较 merge 结果与第一父提交；不能依赖
  `git diff-tree <merge-commit>` 的默认输出，否则文件变更可能被静默识别为空，导致依赖 source diff
  的 migration 与依赖门禁漏报。
- `.ci/runtime/bundles/*.bundle` 是 release bundle 的拆分真源，必须全部登记在
  `.ci/runtime/materialize-files.txt` 中。GitOps promotion 从物化后的 runtime snapshot 生成
  `release-bundles.manifest`；新增 bundle 却未登记会让发布候选在前置验收阶段失去对应路径契约。
- 未经用户明确授权，不构建付费制品、不更新 GitOps、不 apply、不发布。
- 修改 `.ci/runtime/`、`argocd/`、`infra_pulumi/` 或 `codesign/` 时，先定位当前交付设计并同步更新映射的正式设计文档；`docs-impact` 只验证同一变更集含设计更新，不能代替平台 Owner 审阅。
- Service Gateway 的国内与全球 allowlist 是独立发布面。国内站新增用户路由时只更新明确的国内环境配置，并用配置策略测试证明全球环境未暴露该路由；源码配置通过、MR 合入或镜像完成均不代表路由已发布，仍需目标 Argo revision、`Synced`、`Healthy` 和公网请求证据。
- 接管已经存在的 Deployment、StatefulSet 或 StatefulSetPlus 时，GitOps manifest 必须沿用 live 对象的 `spec.selector`；该字段不可变，不能为了补充组织标签而扩展。新增标签只能放在允许变更的 metadata/Pod template，并确保 Pod labels 继续匹配 selector。发现 selector 漂移时先修 `master` 真源，再由流水线投影到 `gitops`，不直接热修 `gitops`。
- 生产镜像 promote 只有在 staged diff 符合该服务的 pin-only 合约时才允许自动合并或自动同步。VelaGW 的 pin-only 合约仅允许目标环境 `velagw-platform.env` 中的 `VELAGW_IMAGE` 与 `VELAGW_DEPLOYED_AT` 变化；Kustomize 结构、NewAPI release pin 或任何其他 deploy-facing 配置变化必须关闭自动合并和自动同步，先审查差异并回填 `master` 真源后重新生成候选。
- Service Gateway 为独立 chat 前端开放浏览器能力时，应使用精确 method/path 的 `cors_allow`，
  不把 chat origin 加入全局 `allowed_origins`。国内与国际生产配置必须成对审查，并分别验证
  OPTIONS 预检、凭据响应头和未声明相邻路径仍不返回 CORS 许可；配置变更仍按各环境独立
  promote、GitOps 合入和 Argo 收敛确认。
- Sandbox Worker 必须使用 Kubernetes 默认 Pod 网络和集群 DNS，不得设置 `hostNetwork`、
  `ClusterFirstWithHostNet`，也不得用 `hostAliases` 把腾讯云 CloudAPI 域名固定到链路本地地址。
  发布前应在目标集群的普通 Pod 中验证 `cvm.internal.tencentcloudapi.com` 可解析且 HTTPS 可达；
  该连通性证明不能用作共享宿主机网络命名空间的理由。

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

### Credit 积分包交付

- Credit 作为独立服务交付，镜像同时包含 API、migration、每日用量 worker 和生命周期 worker
  入口；常驻进程不能代替 migration Job 执行 schema 变更。
- 环境启用顺序为 Credit/Trade schema、LLMGateway plan 与 Trade 商品定义、服务和 worker、
  Service Gateway 用户路由，最后才开放真实购买流量。
- `sandbox-bj-7` 是首个验证环境；北京验证通过后由 `master` 为 `beijing-sandbox` 构建并
  auto-pin Credit。北京使用独立 `credit` 库/用户和 SSM Secret，不沿用 playground 敏感输入。
- Credit API 的支付票据依赖 Redis：`sandbox-bj-7` 复用命名空间 Redis 和已有 playground Secret，
  `beijing-sandbox` 从 Credit 自己的 SSM/SOPS runtime Secret 注入密码。发布 API 前必须验证 Redis
  地址、凭据和连通性；每日用量与生命周期 worker 不依赖该连接。只有 API 与精确的 Service Gateway
  `optional_auth_allow` 同时收敛后，才允许无主站 session 的支付中转页流量进入。Redis 地址、DB 与
  ticket TTL 属于环境级 API 配置，必须留在各环境的 Deployment patch；不能提升到 Credit shared
  base/common，否则未接入 Redis 的其他地域也会被共享 replacement 阻断发布。
- `beijing-sandbox` 的 Pass/default 计费地域保持 `LIGHTVELA_TRADE_REGION=ap-guangzhou`；
  Credit 通过环境 patch 单独设置 `LIGHTVELA_CREDIT_REGION=ap-beijing`。其他环境未声明 Credit
  专用地域时继承 Trade 地域，避免仅引入新配置键就改变存量行为。
- 上海 Credit 仍按生产晋级流程单独接线；在上海验证完成前，Credit 的地域计费回调统一指向
  北京预发布，之后只把 `jifei-credit-callback-sh` 切到 `https://api.lightvela.com`。
- Credit migration Job 独立于 Trade 的历史固定名 Job，避免 Kubernetes Job immutable 字段和旧完成
  状态阻断新服务迁移；移除旧 Job 时仍需通过 release contract 验证 migration delivery 未被静默跳过。
- 积分包控制台 checkout 新增用户路由时，先发布支持订单归属和资源类型校验的 Trade 与 Credit，
  再在目标 Service Gateway 的 authenticated、实名、精确 allowlist 中加入
  `POST /v1/credit/packages/order-url`。首轮只更新 `sandbox-bj-7` 与 `beijing-sandbox`；不得因共享
  源码或策略测试把该路由自动扩散到上海、新加坡等尚未完成 Credit 接线的环境。

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

Credit 资源包使用独立的 `jifei-credit-callback-<region>` 路由，不与 Pass 的
`jifei-callback-<region>` 共用目标配置。`tkexgz` 与 `tkexsg` 生产 workload 必须显式声明
全部 Credit 地域回调目标；北京联调阶段统一为 `https://lightclaw.tech`，避免依赖镜像内默认值。

## CloudLadder HMAC 分阶段发布

CloudLadder 公网代理认证必须分阶段收敛，不能从完全关闭直接全局切换到 `required`：

1. 先发布 `optional` 网关。无签名旧客户端继续工作，携带部分或错误签名的请求被拒绝。
2. 再发布 Trade 等调用方签名，并从网关审计确认正常请求稳定显示已验证 caller。
3. 为每个环境核对调用方 Secret 与对应 tkex 网关 Secret 的安全摘要一致；不得输出明文。
4. 将计费、Credit、账号回调和测试 devtunnel 明确归入兼容路由，避免强认证误拦外部回调。
5. 从匿名白名单移除 jifei、点石和 Billing CloudAPI 等敏感出向路由，完成负向探测后再切
   `required`。

密钥交付继续遵循 SSM → `master` SOPS → `gitops` SOPS → Argo Sync。只更新 SSM 不会改变
运行中 Pod；只发布 Trade 而未发布支持相同签名协议的 CloudLadder，也不能作为切换完成。
`required` 放行前必须同时证明：匿名敏感路由返回 401、合法签名请求成功、计费回调仍成功，
并检查目标环境没有遗留未配置 HMAC 的 Trade 实例。

首次严格模式只在 `tkexsg` 的生产 StatefulSetPlus 上通过
`CLOUDLADDERGATEWAY_AUTH_MODE=required` 启用；共享镜像配置、`tkexsg` testing 和 `tkexgz`
继续保持 `optional`，避免跨环境联动。若韩国测试 Trade 尚未升级，可在该生产 workload 上
用环境级追加项临时豁免 `jifei-test`，但不得豁免任何生产计费路由。发布后须验证无签名
`jifei-prod` 返回 401、带签名生产请求为 200、计费回调仍为 200，并持续检查 401/5xx。

新加坡验证完成后，广州生产 StatefulSetPlus 可独立设置相同的 `required` 覆盖；广州 staging
和 testing 继续保持 `optional`。切换前须确认北京测试与上海正式 Trade 的 HMAC 均与 tkexgz
网关匹配，并已在 optional 阶段观察到签名请求成功。广州生产不追加 `jifei-test` 例外，
sandbox-bj-7 继续使用独立 testing 入口。

## OpenCraft 第一方 OIDC 配置与镜像门禁

原生与 Web 客户端复用现有 OIDC 登录渠道，不是新增身份渠道。上海与新加坡生产环境登记
`opencraft-native-v1`、`opencraft-web-v1` 及各自精确回调，同时保留各环境既有
`site-gateway` 精确 HTTPS 回调；对应 Service Gateway 只公开精确的
`POST /auth/session/exchange`（旧 native 路径仅作兼容）。客户端注册与兑换路由是同一能力的两个发布输入，必须在每个
地域成对审查、成对做配置契约测试，并分别证明 `GET`、后缀路径及旧的 native start/session
路径仍受保护；一个地域已发布不能替代另一个地域的验收。

sgprod 旧 Auth 镜像（源码 `bf1c36960ed4`）只接受一个 Sites client，提前加入 native client
会使整个 OIDC 配置失效。因此必须先完成支持 MR !3762 的 Auth 镜像晋级和环境门禁，
再批准包含新 registry 的部署候选；配置与镜像一起审核，不能把“源码已合入”当作部署前置完成。
配置先回填 `master`，再通过正常晋级生成的 `gitops` MR 下发，禁止直接修改 `gitops` 或仅改 live。
回滚至旧镜像前须移除 native client。发布验收同时覆盖 App 回跳/兑换和存量 Sites 登录。

## Secret 交付

- 环境 Secret 的长期真源是 SSM；`master` 中的 SOPS 文件是 source-facing 快照，`gitops` 中的 SOPS 文件是 deploy-facing 期望。修复顺序必须是 SSM → `master` → `gitops`，不能只 patch live 或只修改 `gitops`。
- SSM manifest 应声明运行时必填键。重新导出时缺少 required key 必须失败，避免后续 promotion 静默删除 live 已有凭据。
- SOPS 每次加密的密文可以不同。判断 Secret 是否一致必须在受控环境中比较解密后的键集合和值，或比较逐键安全摘要；仅看到密文 diff、MR 已合入或 Argo `Healthy` 都不能证明语义一致。
- live hotfix 后，即使业务已经恢复，也必须补齐 SSM、`master` 和 `gitops`。执行 Argo Sync 前先确认 deploy-facing 明文语义与 live 一致，否则 Sync 可能把正确的 live Secret 覆盖成旧值。
- Secret 只更新对象数据时，Pod 不会自动重启。需要运行进程读取新值时应单独执行受控 rollout，并分别验证 Secret、Pod 环境和业务请求；不要把 Secret `Synced` 等同于进程已生效。
- 跨服务运营 BFF Token 必须在同一环境内从服务端真源复制到消费方 SSM，并由 manifest 固定明确版本、声明 required key 后生成 SOPS；禁止跨地域复用或只在 live Secret 中临时补键。

相关 Journey：[源码到生产](../journeys/source-to-production.md)。Agent 摘要：[release-gitops Context](../../context/domains/release-gitops.md)。
