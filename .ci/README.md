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

当前 `.ci/*.yml` 不再依赖 `ci.event == 'push' / 'manual'` 来分流。
已改为：

- 默认 `PIPELINE_MODE=build`
  - 运行构建
  - 北京自动 promote MR + auto-merge
- 手动把 `PIPELINE_MODE` 改成 `promote`
  - 只执行 `手动发布 <service> 到 GitOps` 对应步骤
  - 需要同时提供 `SOURCE_SHA`

## Service Release Template

标准服务构建发布入口正在从“每个 `.ci/<service>.yml` 复制完整 stages”演进为根级 `extends` 模板模型。

试点入口：

- `.ci/admin-gateway.yml`
  - 保留 Stream 发现所需的 `name` / `on` / 路径触发声明
  - 使用 `extends.template.path: .ci/templates/service-release.yml`
  - 通过 `extends.template.variables` 传入 `SERVICE` / `BUNDLE` / `DISPLAY_NAME`

公共模板：

- `.ci/templates/service-release.yml`
  - 统一承载 service release 的 `concurrency`、启动变量、checkout、build、北京自动 pin、手动 promote 逻辑
  - 继续调用 `.ci/runtime/build_and_promote_to_gitops.sh` 与 `.ci/runtime/promote_bundle_image_to_gitops.sh`

约束：

- `on.push.paths` 仍留在每个服务入口 YAML；这是 Stream 触发发现和 MR check 可读性的服务边界。
- 不使用 `extends.parameters`；当前 BK-CI v2.0 schema / model 更稳的是 `extends.template.variables`。
- 新服务迁移时先迁一个入口、观察 Stream 实例化结果，再批量推广。

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
  - promote 写 GitOps pin 前先校验目标镜像 tag 已存在于 TCR；缺失时停止，避免 Argo `ImagePullBackOff`
  - 只要服务声明 `db_contract.mode: migration`，promote 时默认执行幂等受控 DB job
  - DB job 成功后再运行只读 DB readiness Job，确认 `schema_migrations` 非 dirty 且版本达到 repo 期望
  - readiness 失败时不创建可自动合并的发布 MR
- 上海生产：
  - promote MR 允许在 release gate 通过后自动合入 `gitops`
  - 合入后只表示 desired state 已进入“待同步状态”
  - `argocd/apps/shprod/**` 必须保持非自动 sync，人工确认 DB readiness 后再 sync
  - 进入待同步前同样必须通过目标镜像存在性校验；Git commit 存在不等于镜像 tag 已构建并推送

镜像存在性门禁：

- `.ci/runtime/commands/verify_image_exists.py`
  - 支持单镜像 ref 和 `{"images": {...}}` 多镜像 payload
  - 使用 `docker manifest inspect` 校验 registry 中的 tag 是否存在
  - 由 `.ci/runtime/pin_image_to_gitops.sh` 在更新 `*-platform.env` 前执行
- registry 凭据仍通过 `.ci/init.sh` 的 `ci_set_registry_credentials <env>` 读取 `/etc/lightclaw-ci/tcr_*` 或 Stream settings
- 这个门禁属于 promote runtime gate，不是 MR 静态 guard；它校验的是“发布输入是否真实存在”

DB contract 的声明位置是：

- `.ci/runtime/release-bundles.manifest`

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

发布契约、bundle 元数据和镜像 pin 规则：

- `.ci/runtime/release-bundles.manifest`
  - bundle owner/source、publish paths、image targets、DB contract、轻量依赖声明
- `.ci/runtime/contracts/bundles.py`
  - 解析 release bundle manifest
- `.ci/runtime/contracts/image_pin.py`
  - 更新 `argocd/services/<service>/<env>/*-platform.env`
- `.ci/runtime/contracts/image_existence.py`
  - promote 写 pin 前校验目标镜像 tag 已存在，支持单镜像和多镜像 payload
- `.ci/runtime/contracts/project_release_bundle.py`
  - 从 `master@SHA` 投影发布子集到 promote 分支

### gitops

GitOps MR、promote 分支、收敛验收和漂移审计：

- `.ci/runtime/pin_image_to_gitops.sh`
  - image gate / DB gate 后投影 GitOps 子集、更新 image pin、创建 MR
- `.ci/runtime/promote_bundle_image_to_gitops.sh`
  - 手动 promote 已存在镜像到 GitOps
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
  - Kustomize / SOPS / KSOPS 渲染校验
- `.ci/runtime/gitops/gitops_drift_audit.py`
  - GitOps 漂移审计

### db_gates

DB-aware release gate、受控 DB Job 和只读 readiness：

- `.ci/runtime/db_gates/release_gates.py`
  - 根据 source diff、DB contract、环境策略输出 release gate plan
- `.ci/runtime/db_gates/db_contract_verifier.py`
  - 渲染并可执行只读 DB readiness Kubernetes Job
- `.ci/runtime/commands/plan_release_gates.py`
  - CI 命令入口
- `.ci/runtime/commands/verify_db_contract.py`
  - CI 命令入口
- `scripts/run_gitops_db_job.py`
  - 实际执行 migration / seed 这类受控 DB Job

### guards

MR / push 变更目录约束派发：

- `.ci/mr-placeholder.yml`
  - MR commit check 入口，从 `origin/master` materialize trusted runtime 后运行 guard dispatcher
  - trusted guard 失败且本次 MR 只修改 `.ci/**` 时，允许 fallback 到当前分支的 `.ci/checks/guard.sh`，用于修复坏掉的 `.ci` 自身 guard；业务代码变更不允许 fallback
- `.ci/guards.yaml`
  - guard 注册表，声明 changed path pattern 与对应 guard command
- `.ci/runtime/guards/changed_guards.py`
  - 计算 changed files，按 `.ci/guards.yaml` 派发匹配的 guard
- `.ci/checks/guard.sh`
  - `.ci/**` 变更的 CI runtime / YAML / materialize 门禁
- `service-gateway/checks/guard.sh`
  - service-gateway 相关变更的发布契约与 Go 单测门禁
- `admin-gateway/checks/guard.sh`
  - admin-gateway 相关变更的独立发布契约门禁
- `frontend/checks/guard.sh`
  - frontend 相关变更的 release matrix 门禁

Guard 自举策略：

- 默认执行 **trusted guard**：MR 流水线从 `origin/master` 读取 `.ci/guards.yaml`、dispatcher runtime 和 guard command，避免 MR 分支通过修改 guard 绕过门禁。
- 允许 `.ci` 自修复 fallback：如果 trusted guard 失败，且变更文件全部位于 `.ci/**`，则允许执行当前 MR 分支的 `.ci/checks/guard.sh` 作为 candidate guard。
- fallback 的目的只用于修复 target branch 上已经损坏的 `.ci` 自身 guard，不能用于业务代码变更。
- 只要变更中包含非 `.ci/**` 文件，例如 `frontend/**`、`service-gateway/**` 或 `argocd/**`，fallback 立即禁止，保持 trusted guard 的失败结果。
- candidate guard 必须跑完整 `.ci` 门禁，包括 shell 语法、Python compile、prod manual sync、runtime 单测、materialized runtime smoke、YAML parse 和 `git diff --check`。
- 后续新增目录 guard 时，应把 command 放在对应目录的 `checks/guard.sh`，并在 `.ci/guards.yaml` 注册；不要依赖隐式目录扫描。

### frontend

前端 Pages / EdgeOne / GitOps 镜像构建发布：

- `.ci/frontend.yml`
  - 默认构建 Cloudflare Pages 矩阵 + frontend GitOps 镜像；纯 CF 矩阵不加载 EdgeOne token
- `.ci/frontend-edgeone-lightvela.yml`
  - 手动发布 `eo:cn-lightvela-prod`
- `.ci/frontend-edgeone-lightvela-intl.yml`
  - 手动发布 `eo:global-lightvela-intl-prod`
- `frontend/release-matrix.json`
  - Pages 发布矩阵唯一事实来源
- `frontend/scripts/release-matrix.mjs`
  - 解析矩阵并执行 build/deploy

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

### commands

所有 CI 可执行 Python 入口统一放在 `.ci/runtime/commands/`。这些文件只做两件事：

1. 把 `.ci/runtime` 加入 `sys.path`
2. 从 `contracts` / `gitops` / `db_gates` / `guards` 导入对应 `main`

不要把业务逻辑写进 command wrapper。

## Successful Experience

### 1. 分支职责必须拆开

- `master` 只负责代码和镜像构建
- `gitops` 只负责 deploy-facing 发布视图
- 不要让 Argo 继续盯 `master`

### 2. Monorepo 下不要用一个大 YAML 自动决定 service

当前仓库是 monorepo。  
如果只有一份流水线 YAML，push 到 `master` 时无法稳定判断到底该构建哪个 service。

已验证更稳的方式是：

- 每个 service 一份 `.ci/*.yml`
- 用 `on.push.paths` 只监听自己的目录和共用脚本

### 3. service-gateway / admin-gateway 发布边界必须拆开

`service-gateway` 和 `admin-gateway` 都运行 gateway 二进制，但发布边界已经拆成两个镜像、两个流水线、两个 release bundle。

当前实现方式：

- `service-gateway.yml`
  - 只构建 / pin / promote：
    - `service-gateway`
  - `on.push.paths` 同时监听：
    - `service-gateway/**`
- `admin-gateway.yml`
  - 只构建 / pin / promote：
    - `admin-gateway`
  - 当前构建实现仍临时复用：
    - `service-gateway/Dockerfile`
    - `service-gateway` build context
  - `on.push.paths` 同时监听：
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
- `concurrency.group: mono2-master-release`
  - `cancel-in-progress: false`
  - `queue-length: 20`
- `PIPELINE_MODE`
  - 默认值 `build`
  - 手动 promote 时改成 `promote`

### 5B. 只限制 master 主链路并发，不锁 promote 检查

当前已经给所有 `master` 上的 service 流水线加了同一个顶层 `concurrency.group`：

- `mono2-master-release`

效果是：

- 同一时间最多只跑一个主构建/发布流水线
- 其他被触发的 service pipeline 会排队

但 `.ci/gitops-promotion.yml` 没有使用这个 group。原因是：

- 北京主链路会等待 `promote-*` 分支自己的检查结果
- 如果把 promote 检查也锁进同一个并发组，会和主链路互相等待，形成死锁

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
  - Pages 矩阵发布与 GitOps 镜像发布在同一入口内分流
- `frontend-edgeone-lightvela*.yml`
  - 独立手动发布 EdgeOne 正式项目，不走 GitOps image pin
- `mr-placeholder.yml`
  - MR commit check 入口，按 changed files 派发 `.ci/guards.yaml` 注册的 guard
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
