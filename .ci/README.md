# Stream CI Layout

当前 `mono2` 采用：

- `master`
  - 源码变更与镜像构建入口
- `gitops`
  - Argo CD 实际跟踪的发布分支

当前分支模型的目标是：

- `master` 上构建镜像
- 北京测试环境自动把 `master@SHA` 的发布子集投影到 `gitops`，创建 MR 并自动合并
- 上海正式环境手动 promote 到 `gitops` 的 MR；门禁通过后可自动合并，但 Argo sync 仍由人工执行

标准服务 `.ci/<service>.yml` 保留各自的 `on.push.paths` 和 `manual` 入口，
但发布执行逻辑统一复用 `.ci/templates/service-release.yml`。

流水线内仍然避免依赖 `ci.event == 'push' / 'manual'` 做复杂策略分流：

- 默认 `PIPELINE_MODE=build`
  - 运行构建
  - 北京自动 promote MR + auto-merge
  - 上海 / 新加坡正式环境在构建完成后进入人工确认；确认通过后自动创建对应 GitOps promote MR
- 北京沙箱 DB 变更跟随 GitOps release gate：
  - 构建脚本 auto-pin 北京沙箱镜像后，promote 分支的 release gate 会自动执行受控 DB job
  - DB job 后继续执行 DB readiness 只读校验
  - 门禁通过后自动合并并按北京沙箱策略收敛
- 手动把 `PIPELINE_MODE` 改成 `promote`
  - 只执行 `手动发布 <service> 到 GitOps` 对应步骤
  - 需要同时提供 `SOURCE_SHA`
- 如果本次包含 DB 结构或 migration 变更，先手动执行 `生产 DB migration`：
  - `SERVICE=<service>`
  - `TARGET_ENV=shprod` 或 `sgprod`
  - `SOURCE_SHA=<本次构建输出的 SOURCE_SHA>`
  - `TIMEOUT_SECONDS` 可不填，默认 `1800`
- playground 分支只展示 playground 自身的 auto-pin / bootstrap 后续，不展示生产人工审批或生产 DB migration 参数。
- BK-CI `check-in` 审核页不要依赖 `ci.*` 运行时上下文渲染；审核说明里使用静态文字或模板参数，真实 `SOURCE_SHA` 以构建日志和执行阶段日志为准。
- 生产人工审核 stage 的可见性只依赖模板开关、push 事件和 master 分支环境变量；`PIPELINE_MODE` 只在脚本内做二次保护，避免启动变量在 stage `if` 中导致误跳过。
- 北京测试 auto-pin 拆成独立 `北京测试 DB gate 与 GitOps auto-pin` step；DB job / DB readiness 仍由 release gate 执行，但不再混在镜像构建 step 里。
## Service Release Template

标准服务构建发布入口正在从“每个 `.ci/<service>.yml` 复制完整 stages”演进为根级 `extends` 模板模型。

已迁移入口：

- `.ci/admin-gateway.yml`
- `.ci/ai-gateway.yml`
- `.ci/ctl.yml`
- `.ci/gateway-dashboard.yml`
- `.ci/lightclaw-auth.yml`
- `.ci/nextgen-dashboard.yml`
- `.ci/payment.yml`
- `.ci/sandbox.yml`
- `.ci/service-gateway.yml`
- `.ci/staticpages.yml`
- `.ci/subscription.yml`
- `.ci/trade.yml`

独立验证入口：

- `.ci/cloudladdergateway.yml`
  - 当前只运行 `go test ./...` 和 Docker 镜像构建验证。
  - 该服务暂未接入 GitOps release bundle，因此不使用 `.ci/templates/service-release.yml`，也不会自动 promote/pin。
- `.ci/hermes-image.yml`
  - 用 `images/build-image.py --runtime hermes --base-image-id img-id352nof --with-verify` 构建、验证并同步 Hermes CVM 镜像。
  - 腾讯云凭据只从构建机本地 `/etc/lightclaw-ci/tencentcloud_secret_id` 和 `/etc/lightclaw-ci/tencentcloud_secret_key` 读取，不通过流水线启动变量传入。

这些入口保留 `name` / `on.push.paths` / `manual` / `extends`，并通过统一模板传入
`SERVICE` / `BUNDLE` / `DISPLAY_NAME`。服务级变更仍由对应 `.ci/<service>.yml`
的 `push.paths` 触发，模板只承载执行逻辑。
其中 `lightclaw-auth` 的 `SERVICE` 仍是 release bundle id `user-auth`，`BUNDLE`
仍是 GitOps pin target `lightclaw-auth`。
其中 `sandbox` 显式覆盖 env 矩阵，当前只构建和自动 pin 北京沙箱链路，不隐式构建 `shprod`。
当前标准服务入口统一使用 `version: v2.0` + `extends.parameters`。

公共模板：

- `.ci/templates/service-release.yml`
  - 统一承载 service release 的启动变量、checkout、build、北京自动 pin、生产人工确认后自动 promote、手动 promote 逻辑
  - 继续调用 `.ci/runtime/build_and_promote_to_gitops.sh` 与 `.ci/runtime/promote_bundle_image_to_gitops.sh`

约束：

- `on.push.paths` 只放业务路径、GitOps 服务路径、对应 secrets/app 路径；不要放 `.ci/**`。
- `concurrency` 必须放在每个 service 入口 YAML；蓝盾模板 schema 不允许 `.ci/templates/service-release.yml` 顶层声明 `concurrency`。
- `version: v2.0` 入口使用 `extends.template: service-release.yml` + `extends.parameters`；当前平台会拒绝 v2 里的 `extends.template` 对象写法。
- 蓝盾解析 `extends.template` 时会相对 `.ci/templates/` 查找；不要写 `.ci/templates/service-release.yml`，否则可能被解析为 `.ci/templates/.ci/templates/service-release.yml` 并 404。
- 不要为了 `extends.template.path` 对象写法切到 `version: v3.0`；蓝盾 PAC v3 暂未支持局部模板，`.ci/templates/service-release.yml` 这类本仓库模板应继续走 Stream v2。
- 非流水线配置不要使用 `.yaml` 后缀放在 `.ci/**` 下；蓝盾会把 `.ci/**/*.yaml` 误识别成流水线候选。Guard 注册表用 `.ci/guards.manifest`，release bundle 源用 `.ci/runtime/bundles/*.bundle`。
- `frontend`、`frontend-edgeone-*`、`gitops-*`、`ci-runtime`、`mr-placeholder` 不属于这批标准 service release 入口，不使用该模板。
- `cloudladdergateway` 当前只有独立验证入口，不属于标准 service release 入口；等补齐 GitOps closure 和 release bundle 后再迁入模板。
- `trade`、`staticpages` 当前 master 构建矩阵不包含 `shprod` / `sgprod`，因此显式设置 `ENABLE_MASTER_PROD_PROMOTE=false`，避免没有正式产物时卡人工确认。

### Release 并发模型

标准服务 release 入口按服务维度独立排队：

- `mono2-service-release-<service>`：同一个服务的构建 / 手动 promote 串行，避免同服务多个提交互相覆盖 GitOps pin。
- 不同服务使用不同 concurrency group，可以并行构建镜像，避免 `sandbox`、`ctl`、`ai-gateway` 等互不相关的发布互相阻塞。
- `gitops-promotion.yml` 仍由 promote 分支触发 GitOps MR 前置验收、自动合并、Argo 收敛和分支清理；不要把多个服务重新塞回 `mono2-master-release`。
- `frontend-edgeone-*` 和 `frontend-preview` 已有独立发布/预览并发组，不参与标准服务 release group。

### 新增标准服务流水线

新增一个普通镜像 + GitOps pin 的标准服务时，新增 `.ci/<service>.yml`，形态如下：

```yaml
version: v2.0
name: 构建 <service>

on:
  push:
    branches:
      - master
      - playground/sandbox-bj-2
    paths:
      - <service>/**
      - argocd/services/<service>/**
      - argocd/apps/*/<service>.yaml
      - argocd/secrets/*/<service>-runtime-secrets.sops.yaml
    paths-ignore:
      - OWNERS
      - "**/OWNERS"
  manual: enabled

concurrency:
  group: mono2-service-release-<service>
  cancel-in-progress: false
  queue-length: 20
  queue-timeout-minutes: 480

extends:
  template: service-release.yml
  parameters:
    SERVICE: <release-bundle-id>
    BUNDLE: <gitops-pin-target>
    DISPLAY_NAME: <service>
    DEFAULT_TARGET_ENV: shprod
    MASTER_BUILD_ENVS: beijing-sandbox,shprod
    MASTER_AUTO_PIN_ENVS: beijing-sandbox
    PLAYGROUND_BUILD_ENVS: beijing-sandbox-2
    PLAYGROUND_AUTO_PIN_ENVS: beijing-sandbox-2
```

规则：

- 业务 YAML 只声明 `on.push.paths`、`manual`、`concurrency` 和 `extends`；不要复制 `variables`、`stages`。
- 不要把 `.ci/**`、`.ci/runtime/**`、`.ci/templates/**` 放进业务流水线 `paths`，避免 CI 模板变更隐式构建镜像或推进 GitOps。
- CI 模板、runtime、guard 的变更只触发 `构建 CI runtime`；业务服务是否需要重新构建，应由业务路径变更或手动触发决定。
- `SERVICE` 是 `.ci/runtime/bundles/*.bundle` 里的 bundle id；`BUNDLE` 是 GitOps pin target。多数服务二者相同，`lightclaw-auth` 是例外：`SERVICE=user-auth`、`BUNDLE=lightclaw-auth`。
- `MASTER_*` / `PLAYGROUND_*` 是 CSV env set。标准服务默认 master 构建 `beijing-sandbox,shprod` 但只自动 pin `beijing-sandbox`；`sandbox` 当前覆盖为只构建北京沙箱环境。

### 模板变更服务端验收

`.ci/templates/service-release.yml` 或模板调用契约变化后，本地 guard 只能证明仓库内静态逻辑正确，不能完全证明 BK-CI 服务端模板实例化成功。

推荐验收顺序：

1. 推送后确认 `构建 CI runtime` 通过。
2. 手动触发一个低风险标准服务，例如 `构建 gateway-dashboard` 或 `构建 ai-gateway`。
3. 在日志中确认模板已正确实例化：`SERVICE`、`BUNDLE`、`PIPELINE_MODE`、`TARGET_ENV` 输出符合预期。
4. 确认 `PIPELINE_MODE=build` 时只按业务分支规则构建；`PIPELINE_MODE=promote` 时只进入手动 GitOps promote。
5. 如果只是验证模板实例化，不要通过修改 `.ci/**` 来触发业务流水线。

## Playground DNS

Playground 环境公网 DNS 通过 `.ci/runtime/commands/configure_playground_dns.py`
维护。脚本只从环境变量读取腾讯云密钥，不把 Secret 写入仓库。

典型用法：

```bash
TENCENTCLOUD_SECRET_ID=... \
TENCENTCLOUD_SECRET_KEY=... \
python3 .ci/runtime/commands/configure_playground_dns.py \
  --env sandbox-bj-4 \
  --domain lightclaw.tech \
  --namespace lightvela-playground-sandbox-bj-4 \
  --kubeconfig /etc/lightclaw-ci/kubeconfig_beijing_sandbox_2 \
  --include-env-root
```

脚本会从 Kubernetes Ingress 发现 host -> CLB 地址，并 upsert DNSPod
记录。`--include-env-root` 会把 `<env>.lightclaw.tech` 指向
`*.<env>.lightclaw.tech` 同一个 sandbox ingressproxy CLB，避免根域不被通配
记录覆盖。

## Verified Working Setup

这套模式已经实际验证通过：

- `master`
  - 保留源码和 CI 配置
- `gitops`
  - 作为 Argo CD 的唯一 live 发布分支
- 北京 / 上海当前 live Argo app 都已经盯住 `gitops`
- `master` 上新增 service 级 Stream YAML
- 自动 promote 为北京创建 MR 并自动合并
- 手动 promote 为指定环境创建 MR；上海生产合并后只表示进入待同步状态

当前已经验证成功的关键点：

- `targetRevision` 从 `master` 切到 `gitops` 后，北京/上海 live app 仍然 `Synced / Healthy`
- `env` 自有构建池上的 Linux 机器可以通过 SSH 免密 push `mono2`
- `.ci/runtime/pin_image_to_gitops.sh` / `.ci/runtime/promote_bundle_image_to_gitops.sh` 能承载 GitOps 发布子集投影和 image pin 写回
- `.ci/runtime/commands/gitops_merge_request.py` 负责创建 / 复用 MR，并在北京环境轮询后自动合并
- service 级 YAML 可以继续使用蓝盾 v2.0 的 `jobs.runs-on + steps` 结构
- `.ci/mr-placeholder.yml` 已从空占位升级为 changed-file guard dispatcher，MR 必须通过对应目录 guard 后才能合并

## GitOps Release Gates

当前 release gate 的分层策略：

- 北京预发布：
  - `beijing-sandbox` / `beijing-sandbox-2` 保持自动 GitOps MR 合并和 Argo 自动收敛
  - promote 写 GitOps pin 前先校验目标镜像 tag 已存在于 TCR，并把 tag 解析成 digest pin；缺失或无法解析 digest 时停止，避免 Argo `ImagePullBackOff` 和 mutable tag 漂移
  - GitOps desired state 变更必须通过 config contract：静态结构、服务级 Kustomize 渲染、未替换占位符
  - 只要服务声明 `db_contract.mode: migration`，promote 时默认执行幂等受控 DB job
  - DB job 成功后再运行只读 DB readiness Job，确认 `schema_migrations` 非 dirty 且版本达到 repo 期望
  - readiness 失败时不创建可自动合并的发布 MR
- 上海生产：
  - promote MR 允许在 release gate 通过后自动合入 `gitops`
  - 合入后只表示 desired state 已进入“待同步状态”
  - `argocd/apps/shprod/**` 必须保持非自动 sync，人工确认 DB readiness 后再 sync
  - 进入待同步前同样必须通过目标镜像存在性和 digest 解析；Git commit 存在不等于镜像 tag 已构建并推送
  - 进入待同步前同样必须通过服务级 config contract；生产配置变化通过 GitOps MR 审计，不绕过 MR

三类发布 contract：

- `image_contract`
  - 目标 TCR tag/digest 必须存在，pin 前校验并转换为不可变 digest ref，失败时不写 GitOps desired state
  - 这是最先执行的门禁，因为失败时继续跑 DB job 没有意义
- `config_contract`
  - 默认适用于所有 GitOps bundle
  - 由 `.ci/runtime/contracts/bundles.py` 解析为 `mode: gitops`
  - promote 分支提交前执行 `validate_gitops_static.py` 和服务级 `validate_gitops_kustomize.py --source-path`
  - 校验范围是本次 pin target 的 `argocd/services/<service>/<env>`，避免 unrelated shprod placeholder 阻塞单服务 promote
  - 镜像存在性通过后，CI 会在临时 GitOps worktree 中预投影 desired state，并与 DB gate 并行执行
- `db_contract`
  - 仅 DB 服务显式声明；`mode: migration` 时每次 promote 都跑幂等 DB job/readiness
  - 与 config contract 并行执行，但仍依赖 image contract 先通过，避免镜像不存在时推进 DB

执行顺序：

1. `image_contract`
2. 拉取 GitOps 基线，在临时 worktree 预投影 desired state
3. 并行执行 `config_contract` 与 `db_contract`
4. 两个门禁都通过后，主工作区投影 GitOps desired state 并更新 image pin
5. 创建 / 自动合并 GitOps MR

GitOps promote 分支策略已收口到 `.ci/runtime/gitops/promotion_policy.py`：

- `beijing-sandbox` / `beijing-sandbox-2`
  - 全量 GitOps static / Kustomize 验收
  - gate 允许后自动合并
  - 合并后等待 Argo 收敛
  - 合并完成后清理 promote 源分支
- `shprod`
  - changed-only GitOps Kustomize 验收
  - gate 允许且 `Release-gate-argo-sync=manual` 时自动合并
  - 合并后只校验进入待同步状态，不执行 Argo 自动 sync
  - 不清理 promote 源分支

`.ci/gitops-promotion.yml` 只负责四个阶段的 Stream 编排和 runtime bootstrap，不再直接写北京/上海策略 `case`。

GitOps promote 的可读发布视图由 `.ci/runtime/gitops/release_facts.py` 与
`.ci/runtime/gitops/release_view.py` 派生生成：

## Playground 环境创建提示词

`sandbox-bj-N` / `beijing-playground` 新环境建设先按 GitOps closure 推进，再补外部 DNS/证书/SSM 动作。不要为了复用证书临时改变域名模型。

playground 的运行时状态也应尽量 namespace-local：

- `env-bootstrap` app 管理 `mysql` / `redis` 的 `StatefulSet + PVC + Service`。
- 业务配置指向 `mysql.<namespace>.svc.cluster.local` 和 `redis.<namespace>.svc.cluster.local:6379`。
- `create_playground_environment.py --write` 会为新环境生成最小 `playground-runtime-secrets.sops.yaml`，只承载 MySQL root 和 Redis password；缺 `sops` 或 age key 时直接失败。
- `env-bootstrap` 通过 `ksops-runtime-secrets-generator.yaml` 引入该 secret；MySQL/Redis StatefulSet 与 DB bootstrap/root 路径不能再引用复制来的大 secret。
- 删除 playground catalog 后，Argo prune namespace 内 workload 和 PVC，销毁语义比共享外部 MySQL/Redis 更干净。
- 共享外部 MySQL/Redis 只适合 `beijing-sandbox` 这类预发布环境，不作为 `sandbox-bj-N` 的默认模型。

frontend 容器镜像必须单独确认：

- `argocd/services/frontend/<env>/frontend-platform.env` 写入的 `FRONTEND_IMAGE` 必须已经存在于 TCR。
- 正常路径是构建并推送目标 env tag，例如 `frontend-sandbox-bj-N-<source-sha>`。
- 只有当同 registry 中已经存在同 source sha 的等价 frontend 镜像，且只是缺少目标 env tag 时，才允许把已有 tag retag 成目标 tag 来解锁 live。
- retag 必须记录来源 tag、目标 tag、digest 和“不重新构建”的理由；它只解决 registry tag 缺失，不替代长期 CI 构建入口。
- 如果 frontend 源码、Dockerfile、lockfile、`VITE_*` 构建参数或静态资源入口有任何差异，必须重新构建，不能 retag。

受控检查/retag 入口：

```bash
python3 .ci/runtime/commands/ensure_playground_frontend_image.py \
  --target-image lightclaw-bj8.tencentcloudcr.com/lightclaw/frontend:frontend-sandbox-bj-6-d28bf7b09cab \
  --source-image lightclaw-bj8.tencentcloudcr.com/lightclaw/frontend:frontend-sandbox-bj-5-d28bf7b09cab
```

默认只检查并给出结论；确认为同 source sha 等价镜像后，加 `--apply` 才会执行 `docker pull/tag/push`。执行前先用 `.ci/init.sh` 的 `ci_set_registry_credentials <env>` 加载 registry 凭据。

GitOps closure 克隆入口：

```bash
.ci/runtime/create_playground_from_gitops.sh --to-env sandbox-bj-6
```

默认模板源是 `sandbox-bj-5`，因为它包含 frontend closure；不要退回 `sandbox-bj-3` 作为默认模板源。不要在 `master` 源码 checkout 里直接跑 `create_playground_environment.py` 的默认命令；playground 模板在 `origin/gitops`。如果已经有持久 GitOps worktree，需要写文件时使用：

```bash
GITOPS_WORKTREE=/tmp/mono2-gitops-create \
  .ci/runtime/create_playground_from_gitops.sh --to-env sandbox-bj-6 --write
```

固定入口默认是：

- `api-sandbox-bj-N.lightclaw.tech`
- `admin-sandbox-bj-N.lightclaw.tech`
- `frontend.sandbox-bj-N.lightclaw.tech`
- 可选 `sandbox-bj-N.lightclaw.tech`

实例入口默认是：

- `*.sandbox-bj-N.lightclaw.tech`

证书规则：

- 固定入口申请或选择单域名证书。
- wildcard 实例入口默认只开 HTTP；没有真实覆盖 `*.sandbox-bj-N.lightclaw.tech` 的证书时，不要绑定 HTTPS。
- 不要把 `*.sandbox.lightclaw.tech` 证书复用到 `sandbox-bj-N` 的 API/Admin/frontend/wildcard host。
- 证书 secret 进入 GitOps 前，必须确认 SAN 覆盖目标 host。

推荐执行顺序：

1. 用 `.ci/runtime/commands/create_playground_environment.py` 生成或克隆 GitOps closure。
2. 校验 catalog、services、secrets、AppProject 和 strict Kustomize。
3. 配置 DNS：固定入口和 wildcard HTTP。
4. 配置固定入口单域名证书；wildcard HTTPS 没有合适证书时跳过。
5. 合入 GitOps MR，让 sandbox-family AppSet 生成 apps。
6. 等 Argo apps 到最新 `gitops` revision 的 `Synced / Healthy`。
7. 确认 frontend 目标镜像 tag 存在。缺 tag 时优先补构建；只有同 source sha 等价 tag 已存在时，才允许 retag 解锁。
8. 确认 namespace-local MySQL/Redis Ready，且 `playground-runtime-secrets` 已生成并由 env-bootstrap 引入，再执行 DB bootstrap / readiness。
9. 检查 pods、Service endpoints、Ingress Ready。
10. 用公网 curl 验证固定 HTTPS 入口；wildcard HTTP 出现 `400 invalid host` 时，说明已到 ingressproxy，只是没有具体实例映射。

排障优先级：

- pod/endpoints 正常但公网 504：优先查 `ingress.cloud.tencent.com/direct-access: "true"`、TkeServiceConfig health check、NodePort/endpoints。
- Argo app missing：先查 `sandbox-family-appset.yaml` 是否覆盖 playground catalog，再 refresh root app。
- DB job 失败：先确认 namespace-local MySQL/Redis Ready、namespace、`playground-runtime-secrets` 和业务 SOPS payload，不要只看 secret 文件名或 metadata。
- frontend `ImagePullBackOff`：先查 `FRONTEND_IMAGE` tag 是否存在。若同 source sha 的其它 playground tag 已存在，可以 retag 临时解锁；否则必须构建目标 env 镜像。
- TLS 不通：先查证书 SAN 覆盖，不要反复切换 Ingress 配置。

## Playground 环境诊断脚手架

北京 playground 的新增/恢复流程不是完全自动化发布产品，但已经沉淀了一个可执行诊断入口：

```bash
python3 .ci/runtime/commands/diagnose_playground_environment.py \
  --repo-root . \
  --env sandbox-bj-3 \
  --fetch \
  --argocd-base-url https://9.208.245.238:30547 \
  --argocd-username admin \
  --argocd-insecure-skip-verify \
  --kubeconfig .secret/cls-ftjhqdjt-config
```

该脚本按证据链分段检查：

- `origin/master` 与 `origin/gitops` 的 `sandbox-family-appset.yaml` 是否同时扫描 sandbox 和 playground catalog。
- `origin/gitops` 是否存在 `argocd/catalogs/playground/beijing-playground/<env>/*.yaml` inventory。
- Argo live apps 是否按 catalog 生成，并达到 `Synced / Healthy`。
- 可选 kubeconfig 下目标 namespace 是否有 pod，且 pod phase 没有异常。

脚本不直接写 Git、不直接改 live，不会替代 GitOps MR。遇到不能稳定自动化的环节，它只打印下一步建议，例如：

- AppSet glob 被 promote 回滚：分别修 `master` 和 `gitops` 的 `sandbox-family-appset.yaml`。
- catalog 不存在：创建 GitOps 迁移 MR，把 playground catalog / services / secrets 投影到 `gitops`。
- Argo app missing：refresh `root-beijing-sandbox`，等待 ApplicationSet 重建；如果仍 missing，再查 AppSet generator。
- namespace 为空或 kubectl EOF：先以 Argo API 为主证据，再排查目标集群 apiserver/network。

常用弱依赖模式：

```bash
python3 .ci/runtime/commands/diagnose_playground_environment.py \
  --repo-root . \
  --env sandbox-bj-3 \
  --fetch \
  --skip-argocd \
  --skip-kubernetes
```

这个模式适合在没有 Argo 凭据或 kubeconfig 的本地先检查 GitOps 入口和 catalog 真相源。

- 真相源仍是 promote commit trailers、Gongfeng MR、`gitops` merge commit 和 Argo live state
- MR comment 与 CI console 只作为派生视图，不引入持久 `release-record.json`
- 手动排障可运行 `.ci/runtime/commands/describe_gitops_promotion.py --source-branch <promote-branch> --target-branch gitops`

镜像存在性门禁：

- `.ci/runtime/commands/verify_image_exists.py`
  - 支持单镜像 ref 和 `{"images": {...}}` 多镜像 payload
  - 使用 `docker manifest inspect --verbose` 校验 registry 中的 tag 是否存在，并读取 manifest digest
  - 由 `.ci/runtime/pin_image_to_gitops.sh` 在更新 `*-platform.env` 前执行；后续 `*-platform.env` 写入的是 `repo@sha256:...` digest ref
  - promote commit trailer 会同时保留 `Release-image` 原始 tag、`Release-image-pin` digest pin 和 `Release-image-digests` 解析证据
- registry 凭据仍通过 `.ci/init.sh` 的 `ci_set_registry_credentials <env>` 读取 `/etc/lightclaw-ci/tcr_*` 或 Stream settings
- 这个门禁属于 promote runtime gate，不是 MR 静态 guard；它校验的是“发布输入是否真实存在”

DB contract 的声明位置是：

- `.ci/runtime/bundles/*.bundle` 是唯一人工维护源
- `.ci/runtime/release-bundles.manifest` 是 CI/runtime 临时生成物，不提交到 Git

已支持的契约类型：

- `db_contract: none`
  - 无 DB 发布门禁
- `db_contract.mode: migration`
  - 默认每次 promote 都执行幂等 DB job 和 readiness
  - `migration_paths` 只用于生成 `migration_changed` 审计字段，不再决定是否执行 DB gate
  - `expected_migration_source` 决定 readiness 校验的 repo 期望 schema version
  - `verifier.baseline_checks` 声明必要业务基线数据

DB job / readiness Job 的 kubeconfig 读取顺序：

1. `DB_JOB_KUBECONFIG_B64`
2. `DB_JOB_KUBECONFIG_FILE`
3. `/etc/lightclaw-ci/kubeconfig_<env>`，其中环境名里的 `-` 转成 `_`
4. `deploy/envs/<env>/platform.env` 里的 `DEPLOY_KUBECONFIG`

当前特殊约定：

- `subscription` 要求 `subscription_plans` 中存在 `free/lite/pro`
- `sandbox` 的 default pools 属运营态数据，自动发布不 seed；缺 pools 时阻断并提示人工 `sync-default-pools`
- `service-gateway` 只做轻量依赖发现；如果同批包含 `lightclaw-auth/payment/subscription` 变更，会阻断无序自动 sync

## Runtime Semantic Map

当前 runtime 已按语义拆分到 `.ci/runtime/` 下的多个包。修改时按下面的边界定位，避免把发布契约、GitOps 自动化、DB gate 和工具自举继续混在一起。

### contracts

发布契约与 bundle 元数据。这里描述“必须满足什么”，不执行 registry / Kustomize / Kubernetes / GitOps 变更：

- `.ci/runtime/bundles/*.bundle`
  - bundle owner/source、publish paths、image targets、DB contract、轻量依赖声明的 review 源文件
- `.ci/runtime/release-bundles.manifest`
  - CI/runtime 临时生成的合并产物；运行时仍以这个文件作为 bundle manifest 输入，但不提交到 Git
- `.ci/runtime/contracts/release_bundle_manifest.py`
  - 从拆分源生成合并 manifest，并提供 `--check` 校验 `.bundle` 源可合并、无重复、可渲染
- `.ci/runtime/contracts/bundles.py`
  - 解析 release bundle manifest，并提供默认 `config_contract`
- `.ci/runtime/contracts/release_plan.py`
  - 根据 source diff、DB contract、环境策略输出纯 release gate plan
- `.ci/runtime/contracts/image_existence.py`
  - 镜像引用解析/存在性辅助；release promote 由 `.ci/runtime/gates/image.py` 执行门禁

### gitops

GitOps MR、promote 分支、收敛验收和漂移审计：

- `.ci/runtime/pin_image_to_gitops.sh`
  - 调用统一 release gate runner；门禁通过后投影 GitOps 子集、更新 image pin、创建 MR
- `.ci/runtime/promote_bundle_image_to_gitops.sh`
  - 手动 promote 已存在镜像到 GitOps
- `.ci/runtime/gitops/projection.py`
  - 从 `master@SHA` 投影发布子集到 promote 分支
- `.ci/runtime/gitops/image_pin.py`
  - 更新 `argocd/services/<service>/<env>/*-platform.env`
- `.ci/runtime/gitops/gitops_merge_request.py`
  - 创建 / 复用 / 自动合并 GitOps MR
- `.ci/runtime/gitops/gitops_merge_request_note.py`
  - 写 MR note
- `.ci/runtime/gitops/gitops_release_verifier.py`
  - 北京等待 Argo 收敛；上海只确认 merge-only 待同步状态
- `.ci/runtime/gitops/gitops_cleanup_source_branch.py`
  - 北京 merged 后清理 promote 分支
- `.ci/runtime/gitops/gitops_static_validation.py`
  - GitOps 静态结构校验
- `.ci/runtime/gitops/gitops_kustomize_validation.py`
  - Kustomize / SOPS / KSOPS 渲染校验，支持按 env 或显式 `--source-path` 校验单服务
- `.ci/runtime/gitops/gitops_drift_audit.py`
  - GitOps 漂移审计
- `.ci/runtime/gitops/argocd.py`
  - Argo CD settings / login / API 访问共享 helper；release verifier 与 drift audit 不再各自维护凭据解析和 HTTP 调用
- `.ci/runtime/gitops/git.py`
  - GitOps runtime 共享 Git 读操作 helper，避免 projection / verifier / drift audit 各自维护 `git show` / `ls-tree` 包装

### gates

Release gate 执行层。这里负责证明 image/config/db contract 是否满足，并把结果收敛为 shell 可读的 allowlist 字段：

- `.ci/runtime/commands/run_release_gates.py`
  - CI 命令入口；thin wrapper，只导入 `gates.runner.main`
- `.ci/runtime/gates/runner.py`
  - 先执行 image gate；image 通过后并行执行 config gate 与 DB gate；只输出 allowlist `GATE_*` dotenv
  - runner 独占 gate-run 临时 bootstrap/worktree 生命周期；shell 只拥有后续 GitOps publish/MR 所需资源
- `.ci/runtime/gates/image.py`
  - 校验目标镜像 tag 已存在并生成不可变 digest pin payload
- `.ci/runtime/gates/config.py`
  - 在 runner 提供的临时 GitOps worktree 中预投影 desired state，并调用 GitOps static/Kustomize 校验
  - 只做 proof 编排，不拥有 projection/image-pin 业务语义
- `.ci/runtime/gates/db.py`
  - 执行 DB-aware gate：受控 DB job + 只读 readiness，复用纯 planner 的 release policy 结果
- `.ci/runtime/gates/db_contract_verifier.py`
  - 渲染并可执行只读 DB readiness Kubernetes Job
- `.ci/runtime/commands/plan_release_gates.py`
  - CI 命令入口
- `.ci/runtime/commands/verify_db_contract.py`
  - CI 命令入口
- `.ci/runtime/commands/run_gitops_db_job.py`
  - 实际执行 migration / seed 这类受控 DB Job

### guards

MR / push 变更目录约束派发：

- `.ci/mr-placeholder.yml`
  - MR commit check 入口，从 `origin/master` materialize trusted runtime 后运行 guard dispatcher
  - trusted guard 失败且本次 MR 只修改 `.ci/**` 时，允许 fallback 到当前分支的 `.ci/checks/guard.sh`，用于修复坏掉的 `.ci` 自身 guard；业务代码变更不允许 fallback
- `.ci/guards.manifest`
  - guard 注册表，声明 changed path pattern 与对应 guard command
- `.ci/runtime/guards/changed_guards.py`
  - 计算 changed files，按 `.ci/guards.manifest` 派发匹配的 guard
- `.ci/checks/guard.sh`
  - `.ci/**` 变更的 CI runtime / YAML / materialize 门禁
- `service-gateway/checks/guard.sh`
  - service-gateway 相关变更的发布契约与 Go 单测门禁
- `admin-gateway/checks/guard.sh`
  - admin-gateway 相关变更的独立发布契约门禁
- `frontend/checks/guard.sh`
  - frontend 相关变更的 release matrix 门禁

Guard 自举策略：

- 默认执行 **trusted guard**：MR 流水线从 `origin/master` 读取 `.ci/guards.manifest`、dispatcher runtime 和 guard command，避免 MR 分支通过修改 guard 绕过门禁。
- 允许 `.ci` 自修复 fallback：如果 trusted guard 失败，且变更文件全部位于 `.ci/**`，则允许执行当前 MR 分支的 `.ci/checks/guard.sh` 作为 candidate guard。
- fallback 的目的只用于修复 target branch 上已经损坏的 `.ci` 自身 guard，不能用于业务代码变更。
- 只要变更中包含非 `.ci/**` 文件，例如 `frontend/**`、`service-gateway/**` 或 `argocd/**`，fallback 立即禁止，保持 trusted guard 的失败结果。
- candidate guard 必须跑完整 `.ci` 门禁，包括 shell 语法、Python compile、prod manual sync、runtime 单测、materialized runtime smoke、YAML parse 和 `git diff --check`。
- 后续新增目录 guard 时，应把 command 放在对应目录的 `checks/guard.sh`，并在 `.ci/guards.manifest` 注册；不要依赖隐式目录扫描。

### frontend

前端 Pages / EdgeOne / GitOps 镜像构建发布：

- `.ci/frontend.yml`
  - 默认先构建并归档完整 frontend Pages artifact 矩阵：`cf:cn-lightvela-staging`、`cf:global-lightvela-intl-staging`、`eo:cn-lightvela-prod`、`eo:global-lightvela-intl-prod`
  - Cloudflare 预发发布步骤只允许 `cf:*` 矩阵，并从 TCR 拉取已归档 artifact 校验后发布；不现场 rebuild
  - artifact 构建步骤只需要 TCR/ORAS，不加载 Cloudflare/EdgeOne 发布 token
- `.ci/frontend-edgeone-lightvela.yml`
  - 手动发布 `eo:cn-lightvela-prod`；强制从已归档 artifact 发布
- `.ci/frontend-edgeone-lightvela-intl.yml`
  - 手动发布 `eo:global-lightvela-intl-prod`；强制从已归档 artifact 发布
- `frontend/release-matrix.json`
  - Pages / EdgeOne 发布矩阵唯一事实来源；CF 组合 ID 使用站点化名称 `cf:cn-lightvela-staging`、`cf:global-lightvela-intl-staging`
- `frontend/scripts/release-matrix.mjs`
  - 解析矩阵并执行 build/deploy；不作为 `.ci/frontend.yml` 的默认发布入口
- `frontend/scripts/build-release-artifacts.mjs`
  - 复用矩阵 env 逻辑，只执行 build/archive/verify，不执行 deploy
- `frontend/scripts/release-cloudflare-from-artifact.mjs`
  - CF 预发发布入口：拉取 artifact，校验 repo/tag/source/combo/baked env/content 后，用解压目录发布 Cloudflare Pages
- `frontend/scripts/release-edgeone-from-artifact.mjs`
  - EO 正式发布入口：拉取 artifact，校验 repo/tag/source/combo/baked env/content 后，用解压目录发布 EdgeOne

### bootstrap

CI 运行环境自举、secret 读取和工具安装：

- `.ci/init.sh`
  - repo root、Git WOA 默认值、Cloudflare/EdgeOne/TCR token、本地 secret、Node/pnpm、kubectl、Kustomize/SOPS/KSOPS
- `.ci/AGENTS.md`
  - CI 机、`/etc/lightclaw-ci/` 本地 secret 和 kubeconfig 运作约定
- `.ci/runtime/smoke_materialized_runtime.sh`
  - 验证 materialized runtime 里 command wrapper 的 import/`--help` 可用
- `.ci/runtime/materialize-files.txt`
  - CI runtime 临时目录投影的唯一文件清单，promotion workflow 和 smoke 共用
  - materialized runtime 会从 `.ci/runtime/bundles/*.bundle` 生成 `.ci/runtime/release-bundles.manifest`，不要手工维护临时目录内的合并产物
- `.ci/runtime/gitops_promotion_bootstrap.sh`
  - GitOps promotion 各 stage 共用的 runtime materialize 自举函数，避免 YAML 里重复维护 `CI_RUNTIME_REF` / manifest 投影逻辑

### support

Python runtime 的低层复用工具。这里只放跨包、无业务领域知识的基础设施 helper：

- `.ci/runtime/support/process.py`
  - 统一 `subprocess.run` 的 stdout/stderr 转发和失败传播；调用方仍显式声明命令、`cwd` 和业务顺序
- `.ci/runtime/support/logging.py`
  - 统一中文 section/banner 输出；不要把 release gate 顺序或业务判断藏进日志 helper
- `.ci/runtime/support/yaml.py`
  - 统一“文件必须是 YAML mapping”的低层读取逻辑；不承载 release bundle / GitOps 领域规则

边界约束：

- 当前只允许 `process` / `logging` / `yaml` 这类机械基础设施；`support.cli` 和 decorator 风格 CLI framework 暂不引入
- `support.temp` 只有在单独迁移 `gates/runner.py` 或 `gates/db_contract_verifier.py` 这类真实 temp consumer 时才允许新增
- 新增 `support/*.py` 必须同步 `.ci/runtime/materialize-files.txt`、`.ci/runtime/check_ci_runtime.sh` 和 materialized runtime smoke 覆盖
- support 只能消除机械重复；不能隐藏 image-first、config/db 并行、GitOps publish/MR 这类发布编排顺序

### commands

所有 CI 可执行 Python 入口统一放在 `.ci/runtime/commands/`。这些文件只做两件事：

1. 把 `.ci/runtime` 加入 `sys.path`
2. 从 `contracts` / `gitops` / `gates` / `guards` 导入对应 `main`

不要把业务逻辑写进 command wrapper。

### root scripts boundary

根目录 `scripts/` 不再承载 CI release runtime。判断规则：

- 需要被 `.ci/*.yml`、GitOps promote、release gate、drift audit 或 MR guard 直接调用的发布运行时代码，必须放在 `.ci/runtime/`
- `scripts/` 可以保留仓库维护 / 一次性运维 / 本地辅助脚本，例如 SSM 导出、SOPS 扫描、CLS 校验、EdgeOne 子账号创建、旧环境 bootstrap
- 新增脚本如果需要进入 CI 发布闭环，先放入 `.ci/runtime/commands/` 或对应语义包，再同步 `.ci/runtime/materialize-files.txt` 和 runtime 测试
- 禁止重新引入 `scripts/build_and_promote_to_gitops.sh`、`scripts/promote_bundle_image_to_gitops.sh`、`scripts/verify_gitops_release.py` 这类 CI release runtime 入口

### tests

Runtime 单测按语义分组，避免一个扁平目录继续增长：

- `.ci/runtime/tests/command_tests/`
  - command wrapper 纯度、materialize manifest 覆盖
- `.ci/runtime/tests/contract_tests/`
  - release bundle / image contract / release plan
- `.ci/runtime/tests/gate_tests/`
  - image/config/db gate runner 与 DB readiness verifier
- `.ci/runtime/tests/gitops_tests/`
  - GitOps projection、MR、Kustomize、drift、prod manual sync
- `.ci/runtime/tests/guard_tests/`
  - changed-file guard dispatcher 和 MR placeholder workflow
- `.ci/runtime/tests/test_discovery.py`
  - meta-test：确认 `python3 -m unittest discover -s .ci/runtime/tests` 能加载所有 `tests/**/test_*.py`，防止分组后漏跑
- `.ci/runtime/tests/helpers.py`
  - 测试侧共享 Git 命令 helper；只抽机械 fixture，不把业务断言藏进 helper

注意：测试子目录不要命名为 `contracts` / `gates` / `gitops`，否则会遮蔽 runtime 同名包。

## Successful Experience

### 1. 分支职责必须拆开

- `master` 只负责代码和镜像构建
- `gitops` 只负责 deploy-facing 发布视图
- 不要让 Argo 继续盯 `master`

### 2. Monorepo 下 trigger 和 release 执行边界要清晰

当前仓库是 monorepo。  
如果只有一份完整发布流水线 YAML，push 到 `master` 时很容易把 trigger、调度、构建、promote 全揉在一起。
当前保留每个 service 自己声明 `on.push.paths`，执行逻辑用 `extends` 复用模板。

已验证更稳的方式是：

- 每个 service 一份 `.ci/<service>.yml`
  - 明确声明自己的 `push.paths` 和手动入口
  - 继续通过 `extends` 复用 service release 模板
- `extends.template` 使用短名 `service-release.yml`
  - 蓝盾会相对 `.ci/templates/` 解析模板路径
  - 不要写 `.ci/templates/service-release.yml`，否则可能解析成重复路径并 404

### 3. service-gateway / admin-gateway 发布边界必须拆开

`service-gateway` 和 `admin-gateway` 都运行 gateway 二进制，但发布边界已经拆成两个镜像、两个流水线、两个 release bundle。

当前实现方式：

- `service-gateway.yml`
  - 只构建 / pin / promote：
    - `service-gateway`
  - `on.push.paths` 监听：
    - `service-gateway/**`
- `admin-gateway.yml`
  - 只构建 / pin / promote：
    - `admin-gateway`
  - 当前构建实现仍临时复用：
    - `service-gateway/Dockerfile`
    - `service-gateway` build context
  - `on.push.paths` 监听：
    - `admin-gateway/**`
    - `service-gateway/**`

拆分原因：

- shprod 是 direct Argo Application，一个 promote branch 不应夹带多个 direct app
- admin-gateway 的 placeholder / readiness 问题不应阻塞 service-gateway 发布
- 后续回滚、审计、MR title、image pin 都按服务独立处理

### 4. Git push 走 SSH，MR 创建走 API

当前这套 Stream 运行在自有构建池 `env` 的 Linux 机器上。  
已验证更适合的方式是：

- 使用构建机已有的 SSH 免密推送能力
- push `promote-*` 分支
- 再用工蜂 API 创建 / 复用到 `gitops` 的 MR

而不是：

- 让发布继续 direct push `gitops`

### 5. `runs-on` 要放在 job 级

蓝盾 v2.0 文档明确说明：

- 当需要指定构建环境时，应使用 `jobs.<job>.runs-on`

不要假设顶层 `steps` 省略 job 后还能稳定支持所有 `runs-on` 配置。  
当前 service 级 YAML 全部统一为：

- `jobs.release.runs-on.self-hosted: true`
- `jobs.release.runs-on.pool-name: env`
- `concurrency.group: mono2-service-release-<service>`
  - `cancel-in-progress: false`
  - `queue-length: 20`
- `PIPELINE_MODE`
  - 默认值 `build`
  - 手动 promote 时改成 `promote`

### 5B. 按服务限制 release 并发，不锁 promote 检查

当前 service release 流水线按服务维度设置顶层 `concurrency.group`：

- `mono2-service-release-admin-gateway`
- `mono2-service-release-ai-gateway`
- `mono2-service-release-sandbox`
- 其他服务同理

效果是：

- 同一个服务的多次构建 / 手动 promote 串行，避免同服务多个提交互相覆盖 GitOps pin
- 不同服务可以并行构建镜像，避免一个服务的慢构建阻塞其他服务
- promote 分支仍然进入 `.ci/gitops-promotion.yml` 做统一验收、自动合并和 Argo 收敛

但 `.ci/gitops-promotion.yml` 没有使用这个 group。原因是：

- 北京主链路会等待 `promote-*` 分支自己的检查结果
- 如果把 promote 检查锁进服务构建并发组，会和主链路互相等待，形成死锁

### 6. 不要再把 `ci.event` 当作唯一分流依据

这次已经遇到过：

- push 触发时，`if: ${{ ci.event }} == 'push'` 仍然被判 false

因此每条流水线都加了 `打印 <service> 发布上下文` step，会直接打印：

- `ci.event`
- `ci.branch`
- `PIPELINE_MODE`
- `TARGET_ENV`
- `SOURCE_SHA`

后续若平台事件语义变化，优先看这一步的日志，不要继续猜事件值。

### 7. 不再依赖 `DockerBuildAndPushImage@3.*`

这次已经验证过：

- 宿主机 `docker build` 正常
- 北京 / 上海 TCR 口令本体都能 `docker login`
- 但 `DockerBuildAndPushImage@3.*` 的凭据读取链路不稳定

当前稳定方案是：

- CI 直接用 `run` step
- 调 `.ci/runtime/build_and_promote_to_gitops.sh`
- 底层走 `.ci/runtime/commands/build_release_image.py --push`
- shell 优先从构建机本地文件读取 TCR token，不存在时再回落到 Stream settings
- `docker login` 在 shell 里显式执行

也就是说，TCR 认证从“蓝盾插件取票据”切成了“shell 自己登录 TCR”。

### 8. 环境依赖统一收口到 `.ci/init.sh`

当前 CI 的公共执行面约定放在：

- `.ci/init.sh`

它负责这几类公共初始化：

- repo root 归一化
- Node 22 自举
- pnpm 自举
- Cloudflare 本地票据读取

当前推荐模式是：

```bash
source .ci/init.sh
ci_init_repo_root
```

再继续：

- `bash .ci/runtime/...`
- 或 `cd "$REPO_ROOT/frontend"` 这类子目录操作

如果当前链路还需要前端工具，再补：

```bash
ci_ensure_node
ci_ensure_pnpm
```

不要把这些环境依赖继续散落到每条 YAML 或 Python 脚本里分别维护；优先加到 `.ci/init.sh`，然后由流水线 source 它。

### 9. GitOps promotion runtime ref 必须显式可追溯

`promote-*` 分支自己的检查流水线不会直接相信 promote 分支里的执行脚本。它会先读取 `.ci/init.sh`，
再通过 `ci_prepare_runtime_ref` 解析本次使用的 CI runtime 来源，并从该来源 materialize `.ci/runtime/**`。

默认值是：

- `CI_RUNTIME_REF=origin/master`

每次 promotion 检查都会打印：

- `CI_RUNTIME_REF`
- `CI_RUNTIME_COMMIT`

稳定期可以继续使用 `origin/master`，这样 runtime 修复能被后续 promote 检查立即继承。生产关键发布或高风险变更建议把
`CI_RUNTIME_REF` 固定到明确 tag，例如：

```bash
CI_RUNTIME_REF=refs/tags/ci-runtime-20260429-1
```

这样发布使用的是可审计、可回滚的 runtime 版本，而不是浮动的 `master` 头部。

## Required Runtime Preconditions

除了 `settings` 变量，还需要下面这些前置满足：

- 蓝盾项目里已经存在自有构建池：
  - `env`
- 该池里已经有可用的 Linux agent 节点
- 该节点已具备：
  - Docker / 蓝盾构建插件运行能力
  - 对 `git@git.woa.com:wisp/mono2.git` 的 SSH 免密推送能力
  - 正确的 git committer 身份

如果不满足，会出现类似问题：

- `启动构建机失败- 第三方构建机环境节点不存在(...)`

### 当前自有构建池经验

在这次验证中：

- `devops_agent_mwgvynem`
- `devops_agent_mxdkgndm`

都已经能在目标 Linux 机器上成功安装并启动。  
但是否能被蓝盾项目正确调度，仍取决于构建池和节点绑定状态，而不只是 agent 进程是否存活。

## Troubleshooting Notes

### 构建机启动失败

优先检查：

- 蓝盾项目下 `env` pool 是否真的存在
- pool 里是否有在线 Linux 节点
- 节点是否属于当前项目，而不是只在机器上装了 agent

### promote 失败

优先检查：

- 构建机是否能 `ssh` / `git push` 到 `mono2`
- 构建机 git identity 是否和 SSH 票据账号一致
- `gitops` 分支是否已存在
- `/etc/lightclaw-ci/git_woa_private_token`
- `GIT_WOA_PRIVATE_TOKEN`
- promote 分支对应的 MR 是否已创建、是否被 commit check 阻塞

### 镜像推送失败

优先检查：

- `/etc/lightclaw-ci/tcr_beijing_password`
- `/etc/lightclaw-ci/tcr_shprod_password`
- `settings.TCR_BEIJING_PASSWORD`
- `settings.TCR_SHPROD_PASSWORD`
- token 是否与用户名 `100045199955` 匹配

## Stream Pipelines

当前已接入 Stream YAML：

- `admin-gateway.yml`
- `ai-gateway.yml`
- `ci-runtime.yml`
- `cloudladdergateway.yml`
- `ctl.yml`
- `frontend-edgeone-lightvela.yml`
- `frontend-edgeone-lightvela-intl.yml`
- `frontend.yml`
- `gateway-dashboard.yml`
- `gitops-drift-audit.yml`
- `gitops-drift-audit-shprod.yml`
- `gitops-promotion.yml`
- `lightclaw-auth.yml`
- `mr-placeholder.yml`
- `nextgen-dashboard.yml`
- `payment.yml`
- `sandbox.yml`
- `service-gateway.yml`
- `subscription.yml`

说明：

- `service-gateway.yml`
  - 构建 / promote / pin：
    - `service-gateway`
- `admin-gateway.yml`
  - 构建 / promote / pin：
    - `admin-gateway`
  - 当前复用 `service-gateway/Dockerfile` 和 `service-gateway` build context，但镜像 repo/tag 独立
- `frontend.yml`
  - `build` 模式构建 frontend shprod 镜像，不自动 pin shprod
  - frontend Pages artifact 全矩阵归档、CF 预发 artifact 发布与 GitOps 镜像发布在同一入口内分流
- `frontend-edgeone-lightvela*.yml`
  - 独立手动发布 EdgeOne 正式项目，不走 GitOps image pin，不现场 rebuild；必须输入 `FRONTEND_ARTIFACT_SOURCE_SHA` 或高级覆盖 `FRONTEND_ARTIFACT_REF`
- `mr-placeholder.yml`
  - MR commit check 入口，按 changed files 派发 `.ci/guards.manifest` 注册的 guard
- `lightclaw-auth.yml` 对应的 build bundle 是：
  - `user-auth`
  - 但 GitOps pin target 是 `lightclaw-auth`
- `sandbox.yml`
  - 支持 `beijing-sandbox` / `beijing-sandbox-2` 多镜像构建和自动 pin
- `gitops-promotion.yml`
  - 只处理 `promote-*` 分支的 GitOps 验收、自动合并 / 待同步确认和 promote 分支清理

历史注意：

- 不要再假设 `service-gateway.yml` 会更新 `admin-gateway`。
- `admin-gateway` 已有独立 image repo / tag / pin；需要发布时走 `.ci/admin-gateway.yml`。

## Required Settings

这些 Stream settings 需要在平台侧提前配置：

- `TCR_BEIJING_PASSWORD`
  - 北京镜像推送 token
- `TCR_SHPROD_PASSWORD`
  - 上海镜像推送 token
- `GIT_WOA_PRIVATE_TOKEN`
  - Git WOA API token，用于创建 / 轮询 / 合并 GitOps MR
- `CLOUDFLARE_API_TOKEN`
  - Cloudflare Pages API token，用于 frontend 北京测试静态发布
- `CLOUDFLARE_ACCOUNT_ID`
  - Cloudflare account id，用于 frontend 北京测试静态发布
- `EDGEONE_LIGHTVELA_PROD_TOKEN`
  - EdgeOne Pages API token，用于 `发布 frontend eo:cn-lightvela-prod`
- `EDGEONE_LIGHTVELA_INTL_PROD_TOKEN`
  - EdgeOne Pages API token，用于 `发布 frontend eo:global-lightvela-intl-prod`

另外要求：

- 自有构建池 `env` 上的机器必须已经具备对 `git@git.woa.com:wisp/mono2.git` 的 SSH 免密推送能力
- 构建机上的 git committer 身份必须与该 SSH 票据对应的工蜂账号匹配
- TCR 用户名默认使用 `100045199955`，如需覆盖，可设置环境变量 `TCR_USERNAME`
- 如果要完全绕开 Stream settings，可在每台 `env` 构建机上预置：
  - `/etc/lightclaw-ci/tcr_beijing_password`
  - `/etc/lightclaw-ci/tcr_shprod_password`
  CI 会优先读取这两个本地文件
- Git WOA API token 同样支持本地文件优先：
  - `/etc/lightclaw-ci/git_woa_private_token`
  CI 会优先读取该文件
- Cloudflare frontend 测试发布同样支持本地文件优先：
  - `/etc/lightclaw-ci/cloudflare_api_token`
  - `/etc/lightclaw-ci/cloudflare_account_id`
  `发布 frontend` 会优先读取这两个本地文件，缺失时再回落到 Stream settings
- EdgeOne frontend 正式发布同样支持本地文件优先：
  - `/etc/lightclaw-ci/edgeone_lightvela_prod_token`
  - `/etc/lightclaw-ci/edgeone_lightvela_intl_prod_token`
  `发布 frontend eo:cn-lightvela-prod` 和 `发布 frontend eo:global-lightvela-intl-prod` 会优先读取对应本地文件，缺失时再回落到 Stream settings

### Frontend EdgeOne Artifact Release Inputs

EdgeOne 正式发布 CI 不再现场构建源码，只发布 `构建 frontend` 入口已经上传到 TCR 的 frontend Pages OCI artifact。

- 常规输入：`FRONTEND_ARTIFACT_SOURCE_SHA`
  - 接受 12 位 short SHA 或 40 位 full SHA
  - 发布脚本按固定 EO combo 拼出 `<shortSha>-<normalizedComboId>` tag
- 高级覆盖：`FRONTEND_ARTIFACT_REF`
  - 传完整 OCI artifact ref，例如 `lightclaw-shprod.tencentcloudcr.com/lightclaw/frontend-pages:<shortSha>-eo-cn-lightvela-prod`
  - 如果同时传 `FRONTEND_ARTIFACT_SOURCE_SHA`，两者必须解析到同一个 repo、short SHA 和目标 combo
- 目标 combo 固定在对应 CI 文件的 `FRONTEND_RELEASE_MATRIX`，不能跨 combo 发布。
- 发布前会校验 manifest 中的 `comboId`、`projectName`、`channel`、`region`、`outputDir`、Aegis/Vite baked env、archive sha/size 与解压内容 identity。

## Shared Scripts

- `.ci/runtime/commands/update_image_pin.py`
  - 只更新 `argocd/services/<service>/<env>/*-platform.env`
- `.ci/runtime/contracts/bundles.py`
  - 解析 release bundle 元数据和模式化 `publish_paths`
- `.ci/runtime/commands/project_release_bundle.py`
  - 把 bundle 在 `master@SHA` 上的发布子集投影到 `gitops` promote 分支
- `.ci/runtime/pin_image_to_gitops.sh`
  - 先把发布子集投影到 promote 分支，再更新镜像 pin，并创建 / 复用进入 `gitops` 的 MR
- `.ci/runtime/commands/gitops_merge_request.py`
  - 创建 / 复用 GitOps MR
  - 北京环境等待 commit check 成功后自动合并
- `.ci/runtime/commands/gitops_cleanup_source_branch.py`
  - 在 `promote-*` 分支自己的检查流水线结束后轮询 merged MR
  - 北京 auto-merge 成功后再显式删除 `promote-*` 源分支
- `.ci/runtime/promote_bundle_image_to_gitops.sh`
  - 按 `bundle service + env + source sha` 解析镜像并 promote 到 `gitops`

## Current Gaps

当前主要缺口：

- `admin-gateway`
  - 已有独立 CI / 镜像 / release bundle
  - 仍临时复用 `service-gateway` 构建上下文；后续如果需要彻底隔离二进制，应再拆 Dockerfile / build context
- `session`
  - 有 release bundle / GitOps deploy-facing 路径，但没有 CI 构建元数据和独立 Stream YAML
  - 北京测试 / 北京测试2 都把它作为 deploy-only catalog 管理；如果要纳入完整自动镜像发布，需要先补源码构建入口和 Dockerfile
- `frontend-ds`
  - 有 shprod release bundle 和镜像构建元数据，但没有独立 Stream YAML，也不在当前 live 发布主链路中
- `sandbox`
  - 已接入北京 / 北京 2 自动构建与多镜像 pin
  - 仍没有 shprod 镜像构建元数据；shprod promote 只能投影已存在发布内容，不能构建新 shprod 镜像

这几类后续要接入，需要先补：

- 明确的构建入口
- 对应环境的 image pin 约定
- 对应环境的 build metadata / image targets
- 是否允许自动合并 / 自动 sync 的环境策略
