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

- 新加坡 Sandbox 扩展到新山时，云网络与现有 `llmgateway-sgprod-jhb` 支撑 VPC 分离。
  `infra_pulumi` 使用持久化 `sandbox-network` scope，只拥有 VPC、pool/support 子网、
  NAT/EIP、路由/SNAT 和 TAT-only Sandbox 安全组；不得借网络扩容创建第二套 TKE、数据库、
  Redis、TCR、CLS、内部模型 CLB 或跳板机。network-only `preview` 不需要平台密码，`up`
  不回写 TKE deploy 输出或 kubeconfig，并且必须在精确资源 diff 审阅后单独获得付费授权。
  首个 pool 使用 `ap-johorbahru-1`，但网络预留 1/2 区 pool 子网；新加坡存量 pool 的生命周期
  继续由原 region 维护，网络创建本身不改变 CTL admission。

- Collaboration 北京 foundation 首次进 Argo 时必须能在默认 Kustomize load restriction 下渲染。
  Namespace 和默认 ServiceAccount 的 deploy-facing 清单置于
  `argocd/services/collaboration/beijing-sandbox-foundation/` 内，并由契约测试核对其与源清单的语义一致；
  不为单一服务放宽 Argo 全局路径限制。foundation 活动目录只允许这两种资源和加密 Secret，
  Runtime、migration 要在 foundation live 收敛并独立验收后启用。
- Collaboration 北京 Runtime 的 `DB_JOB_KUBECONFIG_B64` 在 Stream 中使用 `PASSWORD` 类型 protected
  credential；流水线必须引用 `.password` 字段，不能把 credential 对象本身传给 Base64 解码器。
  kubeconfig 来源保持在受控 DevCloud/Stream 边界，不写入仓库或普通日志。

- Stream V2流水线的触发入口使用顶层普通`on:`。其预处理按行首文本映射到`triggerOn`，
  带引号的入口虽然符合YAML语法，却会丢失触发限制并落入默认通配规则；候选制品契约测试须覆盖此预处理差异。

- Collaboration 北京复用现有普通 MySQL 8 服务的独立逻辑库/账号/DSN，不新建 DB 实例。
  Runtime 与 migration/verify Job 显式使用 `mysql`；`tdsql` 只用于真实 TDSQL Proxy。
  MySQL 独立迁移线不修改已发布 SQLite/TDSQL 历史，保留业务 ID、逻辑路由键、主键/索引和
  字符语义；不伪造物理分片审计，不削弱 owner claim、进度 CAS、失败状态拒绝及只读校验。
  Atlas 对连续 SQL 分隔符产生的空片段不是可执行 migration 语句，不计入
  revision `total/applied` 也不下发数据库；状态预期和执行路径必须复用同一过滤结果。
  修复这类解析差异时不改写已发布 SQL、摘要或发布锁。
  foundation、迁移/verify、Runtime、Gateway 和产品 Web 仍按既定分段门禁交付。

- vela-computer候选流水线在checkout前独立内联隔离旧工作树和全部复用的普通`.git`元数据，关闭浅克隆
  （`fetchDepth=0`），让checkout从空对象库获取完整历史。连通性正常的浅缓存也不复用：
  SDK按SHA做depth1增量fetch时曾在预检通过后仍报缺失父对象，预检不能覆盖该协商失败路径。
  仅隔离元数据会使旧源码成为未跟踪文件，SDK先checkout基线再merge目标提交时仍可能拒绝覆盖。
  当前候选CI目录的旧内容移入0700私有隔离目录：元数据置于`git`，工作树/制品/业务文件置于
  `worktree`，不删除，必要时可恢复；即使`.git`缺失也隔离遗留文件。旧隔离目录保留原位，
  不跟随普通文件的外部symlink；拒绝symlink/gitfile类型的`.git`和共享commondir，隔离目录不归档。
  checkout后在执行源码脚本前验证完整目标SHA、HEAD连通性和源提交属于当前checkout；MR的SDK
  checkout可能生成合并快照，必须显式detach到`ci.sha`，再严格核对HEAD并构建源提交候选。
  切换不使用force、不执行checkout hooks；日志输出checkout SHA与候选source SHA，错误不得静默放过。
  不能删除SHA判断，或以MR合并快照内容冒充源提交候选；本步骤只影响候选流水线，
  不修改独立的可信MR guard或其校验对象。干净工作树、对象库与全量拉取必须同时成立。
- LightVela Web产品构建/发布沿用OpenCraft本地发布契约：`deploy:lightvela-web`先构建并检查
  产品边界，再从`dist-lightvela-web`发布到显式审查的`OPENCRAFT_WEB_RELEASE_ROOT`；不能用
  通用Web产物冒充该产品，不恢复已取消的OpenCraft专用CI/MR guard。该命令不创建域名或后台。
- frontend Pages artifact在release matrix显式启用时，先构建OpenCraft独立Embedded Workbench
  target，再把无sourcemap、内容寻址的静态树放入Next导出的`/__opencraft/`子树；Next主chunk
  不导入OpenCraft，未执行rollout `show()`的页面也不请求该树。同源共包避免ES module CORS和
  两个独立发布版本漂移，但artifact构建必须在缺少loader输入时失败，不能静默回退成只含前端代码。
  Embedded staging 必须先于 EdgeOne Build Output 投影脚本执行，确保实际上传的
  `.edgeone/assets/__opencraft/` 同样包含 loader、version 与 hashed assets；仅检查 `out/__opencraft/`
  不能作为正式站产物验收。回归用例执行真实投影脚本并通过 `resolveDeployDir` 检查上传树。
  Embedded artifact 还必须携带 namespaced Host Proxy Service Worker；该稳定路径需要
  `no-cache`，同时其注册 scope 必须限制在 `/__opencraft/host-proxy/`，不能扩大到站点根。
- `vela-computer`客户端候选CI只构建原生Linux AMD64、校验并归档到流水线制品库，不下发
  实例、不接自动更新、不上传公共COS。候选带`schemaVersion=1`、完整源码SHA、dirty标记、
  平台、版本和SHA256SUMS；`deploymentQualified=false`不能用作正式可用证明。
  候选构建禁用CGO/个人Go配置/额外build tags，不引入旧TAT桥或升级签名参数。正式Linux
  下发仍需独立的凭据注入、Runtime/IM Canary和目标实例审批；制品不是新的常驻后台组件。
- 前端 MR guard 的隔离工作目录必须保持 `frontend/package.json` 中本地 `file:` 依赖的相对布局：
  当前复制 `frontend`、`velalink` 和 `shared/lightvela-agent-core`，排除依赖目录与构建缓存后执行
  frozen install。完整实现由 `.ci/checks/frontend_guard.sh` 持有，旧 `frontend/checks/guard.sh` 仅转发。
  MR runner 仍从可信 `origin/master` 提取注册入口；旧 guard 无法校验自身修复时，先通过独立
  `.ci` bootstrap MR 引入新可信入口，再收敛旧入口，不修改可信 ref 或豁免检查。
  回归测试应实际执行复制命令并逐个验证本地依赖源码存在，并验证转发保留参数、环境与退出码。
- 正式发布只认 Argo CD；service-local apply/release 脚本不是主线。
- 服务级生产审核人由对应 `.ci/<service>.yml` 的 `PROD_REVIEWERS` 跟踪，并通过契约测试锁定服务边界；
  不为单一服务改动共享模板默认名单。Stream 构建使用启动时的流水线版本快照，审核人变更只对新构建
  生效，不追溯修改已暂停或运行中的构建。
- Gateway Dashboard 新增内部上游时，source-facing ConfigMap 占位符、各环境 Kustomize replacement
  与 deploy-facing `gateway-dashboard-platform.env` 必须在同一变更中成套更新。所有复用共享
  component 的 sandbox/playground 环境都要提供对应环境键；生产环境则在各自 Kustomization 中
  显式接线。严格 Kustomize 校验必须证明渲染结果不再包含 `REPLACE_` 占位符，才能创建 promote MR。
  上游地址和 Secret 键映射先回填 `master`，再由服务 CI 投影到 `gitops`，不得直接修改运行中
  Deployment 或 deploy-facing 分支。多个上游明确共用同一内部服务令牌时，消费方 Deployment 可从
  已有 runtime Secret 键分别映射语义化环境变量，不重复保存同值 Secret，也不把令牌写入 ConfigMap。
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
- 尚未激活、仅保存在 `argocd/catalogs/candidates/` 的服务，不得提前把不存在的 active catalog
  写入 `publish_paths_by_env`。候选可以留在 `allowed_paths` 和流水线触发路径中；正式激活时再将
  active catalog 文件与对应发布路径在同一变更中加入，避免阻塞其他服务的环境级 GitOps 静态校验。
- 未经用户明确授权，不构建付费制品、不更新 GitOps、不 apply、不发布。
- 修改 `.ci/runtime/`、`argocd/`、`infra_pulumi/` 或 `codesign/` 时，先定位当前交付设计并同步更新映射的正式设计文档；`docs-impact` 只验证同一变更集含设计更新，不能代替平台 Owner 审阅。
- Service Gateway 的国内与全球 allowlist 是独立发布面。国内站新增用户路由时只更新明确的国内环境配置，并用配置策略测试证明全球环境未暴露该路由；源码配置通过、MR 合入或镜像完成均不代表路由已发布，仍需目标 Argo revision、`Synced`、`Healthy` 和公网请求证据。
- 新加坡生产多 Bot 由 `argocd/services/ctl/sgprod/ctl-platform.env` 显式设置 `MULTI_BOT_ENABLED`，并由 CTL base 将该可选键注入 `ctl-api`。回滚时只把目标环境值切为 `false`，仍需独立审查 Gateway Bot 路由、promote GitOps、确认 Argo `Synced/Healthy` 并执行真实国际站回归；源码中的 `true` 不代表运行态已启用。
- 个人 DevCloud 动态注册只允许在 `sandbox-bj-7` 与 `sandbox-kr-1` Auth overlay 中开启。客户端只提交 callback port 与 TTL；UIN 必须由 Auth session 的 active shadow binding 派生，来源 IP 必须由 Auth 从可信代理链确认，不能接受客户端自报 `targetIp`。CloudLadder 与 devtunnel 的 testing allowlist 只加入真实观测到的最小 DevCloud/NAT 网段，两个工作负载必须保持一致；不要用页面访问 IP 代替服务端观测值，也不要放开整段公网 CIDR。生产、staging、common/default 配置保持关闭。发布或修复这条能力时只精确同步目标 sandbox/testing 资源，不得借机全量同步同一 Argo App 中已有的生产漂移。
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
  auto-pin Credit。`master` 同时构建上海和新加坡 Credit 镜像，但两地仍须人工 promote 到 `gitops`；
  东京由 `.ci/tokyo-credit.yml` 构建并更新 `sandbox-jp-1`，不得用北京 auto-pin 代替东京发布。
- 每个已接入地域使用独立 `credit` 库/用户、Redis 和 SSM/SOPS runtime Secret，不跨地域复用敏感输入。
  Credit API 的支付票据依赖 Redis，每日用量与生命周期 worker 不依赖该连接。发布 API 前必须验证
  Redis 地址、凭据和连通性；只有 API 与精确的 Service Gateway `optional_auth_allow` 同时收敛后，
  才允许无主站 session 的支付中转页流量进入。Redis 地址、DB 与 ticket TTL 属于环境级 API 配置，
  必须留在各环境的 Deployment patch，不能提升到 Credit shared base/common。
- 各环境通过 patch 独立设置 `LIGHTVELA_CREDIT_REGION`：北京 `ap-beijing`、东京 `ap-seoul`、上海
  `ap-shanghai`、新加坡 `ap-singapore`。Pass/default 的 `LIGHTVELA_TRADE_REGION` 保持原值；单独
  发布 Credit 不得改变存量 Pass 地域。
- 东京、上海和新加坡接入 Credit 时，Credit、Trade 与 Service Gateway 的环境配置必须在同一候选
  revision 完成渲染和 contract 校验。上海、新加坡保持生产人工晋级，不因源码包含环境配置而自动发布。
- Credit 每日用量的 `sendResource` 必须按环境使用 CloudLadder 签名路由：北京 sandbox 与上海使用
  `qbilling-send-resource-cn-prod`，东京与新加坡使用 `qbilling-send-resource-intl-prod`，仅北京 7 与
  首尔保留 `qbilling-send-resource-test`。正式路由必须使用计费文档指定的域名，不得写死上游 IP。
  `tkexgz` 与 `tkexsg` 的 CloudLadder 源码、Trade transport 和目标镜像必须协同构建/晋级，避免 Trade
  已切换签名路由而网关仍返回 404。
- Credit migration Job 独立于 Trade 的历史固定名 Job，避免 Kubernetes Job immutable 字段和旧完成
  状态阻断新服务迁移；移除旧 Job 时仍需通过 release contract 验证 migration delivery 未被静默跳过。
- Credit 首次进入上海或新加坡生产时，DB migration/readiness 门禁允许在 GitOps MR 创建前幂等创建
  contract 声明的最小 `credit` Namespace，并打上 CI bootstrap 标签供后续 Argo 接管；该动作不得提前
  创建 Deployment、Service、常驻 ConfigMap 或 runtime Secret，也不得在一次性 Job 清理时删除 Namespace。
  Namespace 创建失败必须 fail closed，不能以“首次发布”为由跳过 DB 版本探测或 readiness。
  Namespace bootstrap 必须由 `db_contract.bootstrap_namespace: true` 显式启用；Trade、CTL 等 namespace
  已有的服务不得在每次 DB Job 前重复申请 cluster-scope Namespace。kubectl 超时输出可能是 bytes，runner
  必须先安全解码再进入既定重试，不能让日志格式异常绕过重试或遮蔽原始集群错误。
- 首次发布阶段的 Credit migration、版本探测和 readiness Job 必须自包含：非敏感连接参数与 node pool
  从候选 revision 投影后的 `credit-platform.env` 读取，数据库密码从同一投影中的 SOPS Secret 解析后只注入
  一次性 Kubernetes Secret。Job 不依赖 live `credit-config` 或 `credit-runtime-secrets`；临时 Secret 与 Job
  执行后清理，因此尚未存在 Credit workload 时也能先完成 DB 门禁，再生成可审阅的 GitOps MR。
- 积分包控制台 checkout 新增用户路由时，先发布支持订单归属和资源类型校验的 Trade 与 Credit，
  再在目标 Service Gateway 的 authenticated、实名、精确 allowlist 中加入
  `POST /v1/credit/packages/order-url`。各地域只能在 Credit、Trade、Redis、Secret 和计费回调均完成
  接线后启用该路由；共享源码或策略测试不能替代目标地域的独立发布验收。

### Referral 北京与上海交付

- 现有北京 P2 Pulsar 集群是外部依赖，Pulumi 只管理 namespace、主 topic、DLQ、三类角色和最小权限；
  preview 必须先只读核对 cluster id、名称、规格、可用区、VPC、子网和 broker endpoint，不能把弹性存储
  集群误导入固定 `storage_size` 资源。
- 发布顺序固定为 Pulsar 子资源和角色 token、Referral/Auth/CTL Secret、Auth/CTL/Referral schema、
  Referral API/worker、Auth/CTL relay、Service Gateway 路由、前端入口。邀请双方各 500 积分通过 CTL 送积分
  接口按额度发放，VelaGW 自动准备内部权益模板，不要求运营预先导入 Plan。
- Referral 流水线构建北京与上海镜像，必须显式设置 `MASTER_AUTO_PIN_ENVS=none` 和
  `ENABLE_MASTER_PROD_PROMOTE=false`。上海只能通过人工 promote、人工合并 GitOps MR 和人工 Argo sync 发布。
  Pulsar、独立 DB/user 和 SSM/SOPS 前置条件完成后才加入 Argo；首次基础发布保持 Referral 总开关、worker
  processing、campaign Job、Auth/CTL relay、Gateway 路由和前端入口关闭，待 schema/API 健康后单独启用。
- 基础阶段 `REFERRAL_PROCESSING_ENABLED=false` 时，`referral-worker` Deployment 必须同步缩容到 0；
  正式启用时须在同一变更中恢复副本并开启 processing，避免“禁用即退出”的 worker 被 Deployment 误判为 CrashLoop。
- Referral 的环境配置必须由带名称哈希的 Kustomize ConfigMap 生成，并让 API、worker 和 campaign Job
  引用生成后的名称。配置内容变化必须形成 Pod template diff并自动滚动，不能依赖人工重启读取 `envFrom`。
- 北京或上海正式激活必须同时开启 Auth/CTL outbox relay、Referral worker processing、精确 Gateway 路由和 CTL runtime flag；
  Gateway 还必须将只读的 `GET /v1/frontend/runtime-config` 精确转发到 CTL，否则前端会回退为 Referral 关闭。
  公共面只允许查询单个返利码与准备注册上下文，用户统计和返利码创建必须经过 session 鉴权。
- 上海 CTL 的 Referral patch 必须按容器名 `api` 合并到原容器，不能把 Deployment 名 `ctl-api`
  当作容器名。GitOps 候选需在 Kustomize 中保留原容器并成功应用既有 volumeMount/volume 删除补丁，
  否则不得创建或合并发布 MR。
- 北京、上海和新加坡环境显式设置 `REFERRAL_ENABLED=true`；其他环境默认关闭。CTL migration 31 未执行时
  严禁开启事件，否则生产发货事务会访问不存在的 outbox 表。
- 新 bundle 必须进入 `.ci/runtime/materialize-files.txt`。首次上线需要独立 migration 与 campaign
  bootstrap 证据；镜像构建、Pulsar 资源存在或 UI 可见均不能单独代表返利闭环。
- Role Token 交付统一使用 `infractl bootstrap-referral-tokens --stack <env>`。命令从目标环境 inventory
  读取集群、角色和 SSM 名称，默认只做全量预检，显式 `--apply` 后才幂等合并；默认拒绝覆盖不同 Token。上海首次上线复用
  同一入口，必须先补齐并审查 `shprod` inventory，不能复制北京 Token 或在日常发布中重复执行。
- 上海没有可复用 Pulsar 集群时，`shprod` 可显式使用 `manage_cluster=true` 由 `pulsar` scope 购买受保护的
  P2 专业集群。首次 apply 只建立独立消息基础设施，不得同步开启 Auth/CTL relay、Referral worker、Gateway
  路由或前端入口；创建后必须把真实 cluster ID 与 broker endpoint 回填 inventory，再执行 Role Token bootstrap。
- 新加坡启用 Referral 时遵循同一 foundation/activation 边界，并使用 `sgprod` 地域内独立的 Pulsar 与
  `lightvela_referral` 数据库。foundation MR 只增加受管 Pulsar inventory、sgprod 镜像构建、Referral SSM
  清单和幂等数据库 bootstrap；首次 scoped preview 必须只包含 12 个 Pulsar 资源。Pulsar apply 后先回填真实
  cluster ID/broker endpoint，再依次执行 `bootstrap-referral-database`、`bootstrap-referral-tokens` 和 SOPS 导出。
  在这些前置条件、schema migration 和 API/worker 健康证据完成前，不创建 `referral-sgprod` Application，
  不开启 Auth/CTL relay，也不向 Service Gateway 添加 Referral 路由。
- 新加坡 activation 使用独立 campaign `singapore-launch-2026-09`、双方各 500 积分且 `vesting_days=0`；
  CTL schema 必须先升级到 31，Auth schema 必须包含 referral outbox，VelaGW 必须先具备按 `token_amount`
  自动创建促销 Plan 的能力。Gateway 只暴露单码查询、已登录用户统计/发码和 referral prepare 精确路径。
- TDMQ P2 会把非分区 Topic 的 `partitions=0` 创建参数规范化为读取值 `1`。Pulumi 必须忽略该只读字段的
  回读漂移，并继续以 `pulsar_topic_type=2` 作为“持久化非分区 Topic”的语义真源；不得因伪漂移反复更新
  生产 Topic。首次 apply 后的 scoped preview 必须达到全部 unchanged。
- 上海 foundation 使用独立 `lightvela_referral` 数据库和 `referral` 用户。激活时必须使用上海独立 Campaign、
  Pulsar producer/consumer Token 和精确 Gateway 路由，同时把 worker 恢复到 2 副本；不得复用北京 campaign ID、
  Token 或 endpoint。上海 Campaign 双方各 500 积分、`vesting_days=0`，资格仍是首次成功开通且 0 元 dianshi 订单也算。
- Referral 首次生产迁移必须从候选 `referral-platform.env` 和对应 SOPS Secret 构造一次性 Job/Secret，不能依赖
  尚未部署的 live ConfigMap 或 runtime Secret；bundle 必须显式声明 `bootstrap_namespace: true`，临时 Namespace
  只用于 DB 门禁，随后由 Argo 接管正式资源。生产 DB migration 服务映射必须显式包含 `referral -> referral`。
- Stream 手动启动变量不能作为生产 DB migration 的条件 stage 真源。`run_migration` 必须使用
  `.ci/db-migration-apply.yml` 的固定 dry-run、人工审核、apply 序列；旧入口遇到此决策时 fail closed。
  dry-run 和 apply 都按相同的不可变 SOURCE_SHA、目标环境及实际 schema 版本重新校验；脚本阶段成功
  不代表迁移 Job 已执行或数据库已升级。
- 标准 service-release 与生产 GitOps promote 只使用主仓库的服务源码、发布脚本和 manifests；其 checkout
  不应拉取无关子模块。需要子模块的独立构建入口须自行显式启用，不能让通用发布链依赖外部仓库可用性。

### Collaboration 北京两阶段 bootstrap

- Collaboration 首次发布不是镜像流水线的附带动作。`.ci/collaboration.yml` 继续保持
  `MASTER_AUTO_PIN_ENVS=none`；`.ci/collaboration-bootstrap.yml` 是唯一可写入口，固定执行
  dry-run、人工审批、apply 和可审阅 GitOps MR，不自动合并。
- 现有 CynosDB 集群 ID、内部 endpoint、独立 DB/账号、SSM 名、namespace 和 node pool 进入
  `infra_pulumi` inventory。`infractl bootstrap-collaboration` 默认只读，显式 `--apply` 后按
  SSM → 账号 → 逻辑库 → DB 级权限幂等执行；任何失败都可重入，默认拒绝密码或 IM Secret 轮换。
- 首次创建账号的密码须符合目标 CynosDB 的复杂度约束，同时能安全写入受管 DSN。若 SSM 已创建而
  账号尚未创建，且其中旧 DSN 密码不合规，重入 bootstrap 仅重新生成并更新该受管 DSN 密码，
  保留其他 Secret 字段后再创建账号；账号已经存在时不得借此隐式轮换密码，仍需显式恢复授权。
- CynosDB 账号创建 API 返回只表示请求被受理；同次 bootstrap 在授予目标库权限时，若刚创建的
  账号暂未就绪，只对明确的账号未存在瞬态错误做有界等待，尊重取消并保持其他错误立即失败。
  超时后保留已完成的 SSM、账号和逻辑库，由下一次只读预检重新判断，不盲目重复创建。
- `foundation` GitOps MR 只包含 Namespace、ServiceAccount 与由 SSM 导出的加密 Secret，不能出现
  Deployment、Service 或 migration Job。只有 foundation 在目标集群收敛后，才能进入 runtime 阶段。
- SSM→SOPS 导出和后续 GitOps 投影需要相同的受控 Python `yaml` 依赖，apply 必须在读取 SSM 前
  准备并验证固定版本的隔离环境。若 DB/SSM 已幂等写入而导出失败，保留云端事实，修复工具链后
  重新只读预检并经人工审批重入；不得手工复制明文 Secret 或跳过加密投影。
- 同一次导出从 Collaboration SSM 只选择 `gateway.token`，生成 Gateway namespace 的专用
  `collaboration-gateway-token` SOPS Secret；投影不得包含 DSN、JWT 或 IM Secret。Gateway 激活必须
  在该 artifact 已进入 GitOps 后独立发布，避免 source 配置先于 Secret 收敛。
- 北京 Gateway 激活阶段在 bridge artifact 合入后，才允许同时增加 KSOPS generator、非 optional
  Secret 引用和 Collaboration upstream 配置；本地预览 Origin 采用路由级 allowlist，不继承全局 `*`。
  `service-gateway.bundle` 的北京 publish paths 必须显式包含该 bridge SOPS artifact，否则 auto-pin
  应在创建 promote MR 前 fail closed。Deployment 的 bridge Secret 注入 patch 必须由
  `service-gateway/k8s/overlays/beijing-sandbox` source-facing Component 持有，与基准 Deployment 同层组合；
  deploy-facing 目录只保留环境配置和 Secret generator，不能对仅由 Component 引入的资源做顶层 patch。
  北京主 sandbox 必须使用一个普通 Kustomization，直接拥有 base resource、平台值 replacements、
  Secret generators 和北京专用 patches；禁止使用 Component 注入内部 token，因为 Component 的 patch
  不能修改 Component 自己或其他 Component 引入的资源。
- `runtime` 阶段必须使用同一 digest 镜像先执行普通 MySQL `migrate → status/verify` 门禁，再把
  active catalog 从 foundation sourcePath 切换到 runtime sourcePath。Migration Job 始终是一次性门禁，
  不进入常驻 Kustomize。
- runtime 已收敛后允许同一阶段幂等重入，以刷新 SOPS artifact 或平台投影；active catalog 只能指向
  已知的 foundation 或 runtime sourcePath，任何其他路径仍须 fail closed。重入不得先回退到 foundation。
- Collaboration `im-identity.key` 的持久语义是 32 字节随机材料的 Base64 表达。bootstrap 新建时必须
  直接生成该形态；已知旧版本留下的 64 字符 hex 只能通过解码后再编码为 Base64 做无损规范化，
  不得重新随机生成或当作 IM Secret 轮换。任何其他非法形态必须在 SSM/SOPS 写入前 fail closed。
- `.ci/collaboration-recovery.yml` 是首发期间的独立受控例外流水线，只修复已知双分号缺陷
  留下的精确空基线状态，不向 foundation/runtime bootstrap Job 扩大 kubeconfig 或其他权限面。
  审批前的 `recovery-plan` Job 只读校验已发布 baseline hash、旧 `1/50` revision、
  `statement_failed`/空 `error_stmt`、首语句 partial hash、单一
  `account_login_identities` 表及 0 行。审批后 `recovery-apply` 必须再次执行全部校验，
  按 `count → drop table → revision CAS delete → empty 回读` 收敛。任一字段、表集或行数不符即
  fail closed；plan 不得写库，recovery 不导出 Secret、不生成 GitOps MR、不自动继续 runtime。
  两种 recovery Job 成功时必须在删除 Job 前收集并脱敏 CLI 摘要，校验预期成功标记后写入
  流水线审计 JSON；无日志或标记不符必须按 `audit_failed` 阻断审批。
  Runtime migration 完成后仍须通过严格 schema audit；Computer v2 字段若因旧增量 DDL 被追加到
  表尾，必须新增 MySQL/TDSQL forward migration 以 `MODIFY COLUMN ... AFTER ...` 收敛到当前物理
  列序，不能修改已发布 migration。SQLite 已通过重建表满足同一列序时不添加无语义版本。
- active catalog 在 foundation/runtime 两阶段均由 bootstrap 流水线独占写入，因此登记为普通
  release-bundle catalog 覆盖检查的显式豁免；普通服务发布不得覆盖或删除它。该豁免只能在 catalog
  所有权迁回标准 release bundle 后移除。
- 北京 Collaboration 固定使用 `AgentNetwork` SDKAppID `1600137234`；SDKAppID/管理员是普通平台值，
  SecretKey 只通过 protected credential 生成临时安全文件并
  写入 SSM/SOPS；不得从旧 Secret 手工复制到仓库或日志。Gateway 与产品 Web 仍是后续独立激活步骤。

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
全部 Credit 地域回调目标，避免依赖镜像内默认值。生产切流后的映射为：`tkexgz` 仅上海
`SH` 指向 `https://api.lightvela.com`，其他地域保留北京预发布 `https://lightclaw.tech`；
`tkexsg` 仅新加坡 `SG` 指向 `https://api.lightvela.ai`，其他地域统一指向东京 sandbox
`https://api-sandbox-jp-1.lightclaw.tech`。映射变更必须同步更新逐地域 GitOps 契约测试，不能通过
修改共享路由默认值或 Pass 回调配置实现。

## 个人 DevCloud testing-only 发布门禁（2026-09-17）

个人环境能力分三层发布：`master` 中的 Auth/CloudLadder/Skill 源码、`sandbox-bj-7` 与
`sandbox-kr-1` Auth 配置、广州/新加坡 testing CloudLadder 运行态。只允许启用北京和韩国 sandbox
Auth、`lightvela-proxy-testing`、`devtunnel-testing` 和韩国 sandbox Service Gateway。动态注册状态
保存在各自 Auth testing MySQL 的 `developer_route_registrations`，CloudLadder 与 devtunnel 只用既有
Shadow HMAC 调用 registry；不得为该能力新增 TKEx ServiceAccount、Role、RoleBinding 或 Lease。production
与 staging manifests 必须保持零 diff，运行态也不得发生变更。

北京 `sandbox-bj-7` 可单独开启 `PERSONAL_DEV_ROUTE_EXPLICIT_TARGET_IP_ENABLED`，用于接收 Skill 自动
探测的 DevCloud `9.0.0.0/8:18084` 地址；韩国 `sandbox-kr-1` 不得开启，继续使用可信代理来源。两站
CloudLadder testing 的动态 developer route 都必须使用各自的 `devtunnel-testing` 反向隧道和短期
capability，不能让 TKEx Pod 直连任意 DevCloud。该开关只有在 sandbox route control client 成功构造时
才生效，不能进入 production、staging 或其他环境的 Auth 配置。已有静态 UIN 路由可以继续保留原落点，
动态注册的 delivery mode 变化不得顺带改写静态测试账号。

CloudLadder 的 `tkexgz`、`tkexsg` 目录同时包含 primary、staging、testing 三份 platform env。个人
环境相关的 master 构建必须显式使用 `IMAGE_PIN_VARIANT=testing`，只更新
`cloudladdergateway-platform-testing.env`；通用发布模板的默认值仍为 `all`，供确实需要同步晋级全部
变体的服务使用。任何 testing 发布若改动 primary 或 staging image pin，必须先恢复生产期望态，不能
依赖“暂不执行 Argo Sync”作为长期隔离措施。

广州和新加坡 Argo App 同时管理 production、staging 与 testing 资源，因此禁止 App 级全量 Sync。
发布前必须先按精确资源查看 diff/dry-run；计划中只要出现非 testing workload、共享生产 ConfigMap、
Secret 或生产 Service 就立即停止。发布时只同步本变更新增或修改的 testing 资源，并逐个核对 kind、
namespace、name、目标 revision 与镜像。

Shadow Binding 自助管理沿用既有 Auth `shadow_bindings` 表，不新增 migration。管理接口的代码即使进入
`master` 也必须默认关闭；GitOps 只允许在 `argocd/services/lightclaw-auth/sandbox-bj-7/` 同时设置
`SHADOW_BINDING_ADMIN_ENABLED=true` 与匹配的 `SHADOW_BINDING_ADMIN_ENVIRONMENT=sandbox-bj-7`。
其他 Auth 环境不得出现启用值，运行时还要用精确 `LIGHTCLAW_PUBLIC_BASE_URL` 做第二层 fail-closed 校验。
Gateway Dashboard 发布只更新 `sandbox-bj-7` 镜像 pin；新增 BFF 路径必须先验证 Dashboard admin session，
再使用服务端 Auth admin token。不得把该开关或 UI 发布扩散到 production、staging、韩国 sandbox，
也不得通过 App 级全量 Sync 携带无关资源。

完成证据必须分层记录：源码合并 revision、Argo 目标 revision、精确资源 `Synced/Healthy`、运行镜像、
国内/国际 registration、registry/tombstone、devtunnel poll/reply、真实回调，以及 dynamic/static/shared
优先级和 fail-closed 结果。源码合入、HTTP 200、Pod Ready 或页面可打开都不能单独作为个人环境闭环。

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

## Collaboration 北京候选交付

- Collaboration 使用独立 `collaboration` release bundle 与 Stream 构建入口，仅构建北京镜像；
  默认不 auto-pin、不创建生产 promote，不因源码合入就加入自动同步 AppSet。
- Argo 描述符先保存在 `argocd/catalogs/candidates/beijing-sandbox/`，不在 AppSet 扫描范围。
  SSM/SOPS 和独立逻辑 DB/user/DSN 就绪后，先用 foundation 描述符交付 Namespace/Secret，
  再将同一个 active catalog 描述符切为 runtime 组合层；不新增手写 leaf Application。
- Runtime promote 的配置门禁要求 active catalog 与真正的 SOPS artifact 已存在，并拒绝未替换
  的 IM/镜像占位符。内部 Gateway token 由同环境两端 Secret 对齐后单独激活用户路由。
- Collaboration 使用 Atlas/Ent 迁移历史。DB gate 每次先用候选镜像执行幂等 `database migrate`，
  再由同一 digest 镜像执行 `database verify`；只以 Secret 文件挂载 DSN，不使用其他服务的
  `schema_migrations` SQL 或 shell 拼接凭据。Migration/verify 都是受控一次性 Job，不进入应用启动。
- `service-command` readiness 的候选 digest 必须由 release plan 显式传入 verifier，并优先于
  deploy-facing platform 中的旧 workload image；这在 active catalog 仍指向 foundation 时尤其必要。
  非 `service-command` verifier 不接收服务镜像 override，避免把业务镜像误用为通用 SQL 检查器。
- 本轮只准备源码接线，不创建数据库实例、逻辑库、Secret 或 live workload。北京成功不能替代
  上海/新加坡的独立接入；CI、GitOps、Argo 收敛和真实 IM 使用仍须分层验收。

## Secret 交付

- 环境 Secret 的长期真源是 SSM；`master` 中的 SOPS 文件是 source-facing 快照，`gitops` 中的 SOPS 文件是 deploy-facing 期望。修复顺序必须是 SSM → `master` → `gitops`，不能只 patch live 或只修改 `gitops`。
- SSM manifest 应声明运行时必填键。重新导出时缺少 required key 必须失败，避免后续 promotion 静默删除 live 已有凭据。
- SOPS 每次加密的密文可以不同。判断 Secret 是否一致必须在受控环境中比较解密后的键集合和值，或比较逐键安全摘要；仅看到密文 diff、MR 已合入或 Argo `Healthy` 都不能证明语义一致。
- live hotfix 后，即使业务已经恢复，也必须补齐 SSM、`master` 和 `gitops`。执行 Argo Sync 前先确认 deploy-facing 明文语义与 live 一致，否则 Sync 可能把正确的 live Secret 覆盖成旧值。
- Secret 只更新对象数据时，Pod 不会自动重启。需要运行进程读取新值时应单独执行受控 rollout，并分别验证 Secret、Pod 环境和业务请求；不要把 Secret `Synced` 等同于进程已生效。
- 跨服务运营 BFF Token 必须在同一环境内从服务端真源复制到消费方 SSM，并由 manifest 固定明确版本、声明 required key 后生成 SOPS；禁止跨地域复用或只在 live Secret 中临时补键。
- Gateway Dashboard 调用 Credit 时，`CREDIT_INTERNAL_TOKEN` 必须由 Dashboard 自有 Secret 的
  `CTL_INTERNAL_TOKEN` 显式映射，不能只依赖 `envFrom`；北京 sandbox、上海、新加坡和东京分别使用
  本地域 Credit 内部 token。东京的 Credit 地址和消费方 SSM/SOPS 必须随 `sandbox-jp-1` overlay 一起交付。

VelaGW subtree 更新时，北京 workload 的 `OTEL_SERVICE_VERSION` 以及 `shprod`、`sgprod` 的
`VELAGW_OTEL_SERVICE_VERSION` 必须同步指向 subtree 源码短版本；这些字段只描述构建源码，
不得借此修改镜像 pin 或触发生产 Argo sync。

相关 Journey：[源码到生产](../journeys/source-to-production.md)。Agent 摘要：[release-gitops Context](../../context/domains/release-gitops.md)。
