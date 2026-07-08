# mono


⚠️ **必读**：clone 后请执行 `make setup` 启用编译检查门禁，防止编译不通过的代码被提交。

## 这是什么项目

这是 `LightVela` 的主 monorepo。

`LightVela` 当前是一套围绕“用户申请机器人实例 -> 分配 sandbox 运行环境 -> 通过 gateway 对外提供能力 -> 前后台分别管理和使用”的完整系统。这个仓库承载的不是单个服务，而是整条主链路：

- 用户前台与营销站点：`frontend`
- 用户认证、邀请与账户体系：`user/auth`
- 用户实例 / bot 生命周期编排：`ctl`
- sandbox 资源池、实例库存与 ingress proxy：`sandbox`
- 对外统一 API / 管理 API 入口：`service-gateway`、`admin-gateway`
- 管理后台与运维面板：`gateway-dashboard`、`nextgen-dashboard`
- AI 兼容代理能力：`ai-gateway`
- 云资源、集群、仓库、监控等基础设施：`infra_pulumi`

如果只想用一句话理解：

- `ctl` 决定“给谁分什么实例”
- `sandbox` 决定“实例怎么创建、回收、路由和执行”
- `gateway` 决定“外部怎么访问这些能力”
- `dashboard` 决定“运营和研发怎么管理系统”
- `infra_pulumi` 决定“这些东西跑在哪些云资源上”

当前主要外网地址：

- 北京测试：
  - `https://lightclaw.tech`
  - `https://admin.lightclaw.tech`
- 上海 `shprod`：
  - `https://api.lightclaw.cn`
  - `https://admin.lightclaw.cn`
  - `https://preview.lightclaw.cn`

当前主线已经比较明确：

- 用户前台：`frontend`
- 用户与订阅：`user/auth`
- 外网统一入口：`service-gateway`
- 沙箱资源池：`sandbox`
- 管理终端：`nextgen-dashboard`
- 环境与云资源：`infra_pulumi`

## Infra 与 Deploy 标准链路

如果是新 agent / 新同学，只记这几条就够了：

1. `infra_pulumi` 只管 infra，不管 workload 正式发布
2. 北京 / 上海当前正式 workload 发布真源是当前 repo 的 `gitops` 分支上的 `argocd/`
3. `scripts/deploy-k8s.sh` 仍可作为服务级渲染 / 手工 apply / 迁移阶段工具，但不是北京 / 上海主链正式发布入口
4. `ENV=<env>` 必须显式传，不允许默认北京
5. `deploy/envs/<env>/platform.env` 是生成物，来自 `infra_pulumi sync/up`，不手改
6. 服务私有密钥放 `.secret/<service>/test.env`
7. 公共发布行为优先改：
   - [`scripts/lib/kustomize-deploy-common.sh`](scripts/lib/kustomize-deploy-common.sh)
   不要每个服务各改一遍

## Agent 发布约定

这段不是泛泛而谈的“理想流程”，而是当前已经实际跑过的发布方式，供后续 agents 直接复用。

### 1. 当前发布真源

- WOA 远端是：
  - `origin git@git.woa.com:wisp/mono2.git`
- 当前 GitOps 真源远端是：
  - `origin git@git.woa.com:wisp/mono2.git`
- 历史 deploy-only 远端已废弃，不再作为正式发布目标
- 默认推送分支：
  - `master`
- 标准代码提交动作：

```bash
git add <scoped paths>
git commit -m "<中文说明 / English summary>"
git push origin master
```

约束：

- 不要把 `.omx/` 状态文件、临时缓存、构建 cache 一起提交
- 优先按目录收窄提交范围，不要一锅端整个工作树
- 提交信息遵守仓库里的 Lore commit protocol

当前口径：

- `origin`：日常代码协作主远端，也是北京 / 上海当前 GitOps 真源仓库

不要默认把“push 到 WOA”当成“发布已经完成”。

### 2. Velalink subtree 协作模型

`velalink/` 是 `git@git.woa.com:wisp/velalink.git` 的完整 subtree。它的目标是让
AI 和开发者可以在 mono2 里直接读、改、测、review velalink 代码，同时仍保留向
velalink 上游贡献的标准路径。

长期协作规则：

- 在 mono2 内开发时，可以直接修改 `velalink/` 目录。
- 需要贡献回 velalink 上游时，用 `git subtree split --prefix=velalink` 切出上游分支，再推到 `wisp/velalink.git`。
- `frontend` 的 `velachat` 依赖必须 pin 到 `wisp/velalink.git` 的真实上游 commit。
- 不要通过前端 deep import 绕过 velalink 包导出问题；应在 `velalink` 上游修复 public export，再更新前端 pin。
- 拉取 velalink 上游更新时，按 `velalink/MONO2_SUBTREE.md` 执行 subtree merge，并同步 `velalink/.mono2-subtree`。

常用命令：

```bash
# 拉取 velalink 上游到 mono2 subtree
git remote add velalink git@git.woa.com:wisp/velalink.git
git fetch velalink master
git merge -s recursive -Xsubtree=velalink --no-commit velalink/master

# 从 mono2/velalink 切出可推给 velalink 上游的分支
git subtree split --prefix=velalink -b velalink/from-mono2-topic
git push git@git.woa.com:wisp/velalink.git \
  velalink/from-mono2-topic:codex/from-mono2-topic
```

详细说明见 [`velalink/MONO2_SUBTREE.md`](velalink/MONO2_SUBTREE.md)。

### 3. Frontend 发布到 Cloudflare Pages

当前 `frontend` 的 Cloudflare Pages 实战发布方式是：

```bash
cd frontend
pnpm install
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw pnpm deploy:cf
```

补充约束：

- 发布前先跑 `npx wrangler whoami`，确认有 `pages (write)` 权限
- 这条链必须先 build，再 deploy，不允许跳过构建
- 如果刚 `git pull` 过，先补一次 `pnpm install`
- 当前生产后端基址用：
  - `https://lightclaw.tech`
- Pages 项目名当前用：
  - `lightclaw`

### 4. Frontend 分支自动预览

当前已经支持基于 StaticPages 的 frontend 自动预览。

推送到 `master` 且命中 `frontend/**` 时，CI 会自动构建 `frontend/dist-cn` 和 `frontend/dist-global` 并上传到稳定预览地址：

```text
https://master.preview.lightclaw.tech/
https://intl-master.preview.lightclaw.tech/
```

也可以把分支推送到 `frontsandbox/` 前缀生成按分支命名的预览：

```bash
git push origin <local-branch>:frontsandbox/<preview-name>
```

预览地址规则：

```text
frontsandbox/<preview-name> -> https://<preview-name>.preview.lightclaw.tech/
frontsandbox/<preview-name> -> https://intl-<preview-name>.preview.lightclaw.tech/
```

示例：

```bash
git push origin HEAD:frontsandbox/codex-staticpages-smoke
```

约 2 分钟后可访问：

```text
https://codex-staticpages-smoke.preview.lightclaw.tech/
https://intl-codex-staticpages-smoke.preview.lightclaw.tech/
```

补充约束：

- `<preview-name>` 会作为子域名前缀使用，建议只用小写字母、数字和 `-`
- `intl-<preview-name>` 固定对应国际版 `dist-global`；不带 `intl-` 的地址对应国内版 `dist-cn`
- 这条链路只用于分支预览，不创建 GitOps MR，也不代表正式发布
- 如果预览站短时间返回 `502`，通常是 CI 仍在构建或上传，等待流水线完成后再刷新

### 5. 当前正式环境发布方式

当前北京 / 上海正式链路统一按 GitOps 发布：

1. 构建并推镜像
2. 更新 `argocd/services/<service>/<env>/` 下的 deploy-facing 文件
3. 提交到 GitOps 发布分支 `gitops`
4. 让 Argo 自动收敛或显式 sync
5. 验证 live app 的：
   - `repoURL`
   - `targetRevision`
   - `revision`
   - `image`
   - `Synced / Healthy`

当前北京 / 上海 live app 已统一切到：

- `git@git.woa.com:wisp/mono2.git`
- `gitops`

最常见的正式发版动作示例：

```bash
python3 .ci/runtime/commands/build_release_image.py --service sandbox --env shprod --tag <tag>
# 更新 argocd/services/sandbox/shprod/sandbox-platform.env
git add argocd/services/sandbox/shprod/sandbox-platform.env
git commit -m "<中文说明 / English summary>"
git push origin HEAD:gitops
```

说明：

- `argocd/apps/<env>/`
- `argocd/root/*.yaml`
- `argocd/services/<service>/<env>/`

是当前正式发布入口。

`deploy-k8s.sh` 现在主要用于：

- 本地渲染
- 手工 apply
- 迁移阶段排障
- 尚未完全纳入 Argo 的场景

### 6. 北京集群公网 Endpoint 操作

关闭北京 TKE 集群公网访问时，当前实战约定是：

```bash
tccli tke DeleteClusterEndpoint --region "$TENCENT_REGION" --ClusterId "$TKE_CLUSTER_ID" --IsExtranet true
```

关键点：

- `IsExtranet=true` 必须显式带上
- 如果返回：
  - `same type task in execution`
  说明 TKE 后台还有同类 endpoint 任务在跑，先查状态再重试

状态查询：

```bash
tccli tke DescribeClusterEndpointStatus --region "$TENCENT_REGION" --ClusterId "$TKE_CLUSTER_ID" --IsExtranet true
tccli tke DescribeClusterEndpoints --region "$TENCENT_REGION" --ClusterId "$TKE_CLUSTER_ID"
```

## 工程思想与实操标准

这套 mono repo 当前已经收敛到一套明确的工程模型。后续 agent 或新同学改动时，优先遵守下面这些原则，而不是沿用历史习惯各自发挥。

### 1. 单一事实来源

- 云资源事实以 `infra_pulumi` 为准
- 环境运行时事实以 `deploy/envs/<env>/platform.env` 为准
- 服务自身敏感配置以 `.secret/<service>/test.env` 为准
- `k8s/overlays/<env>/generated/*` 只是发布中间产物，不是事实来源

不要手改：

- `deploy/envs/<env>/platform.env`
- `k8s/overlays/<env>/generated/*`

如果这两类文件不对，正确修法是：

- 改 `infra_pulumi`
- 或改服务自己的 `deploy-k8s.sh`
- 或改 `.secret/<service>/test.env`

### 2. 控制面与工作负载边界

- `infra_pulumi` 负责：
  - 腾讯云资源
  - TKE/TCR/TDSQL/监控等基础设施
  - 环境差异
  - 集群级能力
  - 回写 `platform.env`
- 各服务目录负责：
  - workload manifest
  - 镜像构建
  - migration / seed
  - rollout 与运行时配置

不要把 workload 发布逻辑塞回 `infra_pulumi`，也不要在服务目录里重新发明一套 infra 事实来源。

### 3. 收敛优先，不保留双轨

- 新链路一旦跑通，就直接收敛到单一实现
- 不再长期保留：
  - `deploy-test.sh`
  - 单文件 `k8s/manifests.yaml`
  - 项目内私有 `imagePullSecrets` 方案
  - 写死北京地址、旧域名、旧 registry 的模板

这里的原则不是“兼容一切历史”，而是“尽快消灭双轨”。

### 4. 生成物与源码严格分层

- 源码应可 review、可复现、可迁移
- 生成物只为发布服务，不应进入长期版本管理

当前默认约定：

- `platform.env` 不提交
- `generated/*` 不提交
- 真实变更应落在：
  - `infra_pulumi`
  - `k8s/base`
  - `k8s/overlays/<env>`
  - `scripts/deploy-k8s.sh`
  - 文档

### 5. 发布是显式动作，不允许隐式默认

- 所有正式发布都必须显式带 `ENV=<env>`
- 不允许“默认北京”或“默认某个 kubeconfig”
- 域名、registry、CLS、DB 地址都应来自当前环境输入，而不是代码里的默认常量

一个发布动作至少应满足：

1. 环境是显式的
2. 镜像地址是显式的或可从 `platform.env` 推导
3. rollout 结果有显式验证

### 6. 数据库按三段式治理

有数据库的服务，统一按下面的职责分层：

1. `bootstrap`
   - 建库
   - 建用户
   - 授权
2. `migration`
   - 只执行 schema 迁移
3. `seed`
   - 只写默认业务数据
   - 必须幂等

不要再把：

- 建库
- 跑 schema
- 写默认数据

混成一个黑盒 `db-init-vN`。

同样，不要把 seed 偷偷藏进应用启动路径里；seed 必须是显式动作。

### 6.1 数据库时间统一按 UTC 存储

- UTC 不是“实现细节”，而是本仓库的时间语义底线：
  - 数据库里的时间字段必须代表同一个全球时间轴上的事实
  - 不能依赖部署机器、本地开发机、容器默认时区来解释时间
  - 不能让“今天/昨天/过期/出生顺序”这类语义随着运行节点时区漂移
- 选择 UTC 的原因是：
  - 多 region、多集群、多机器下语义唯一
  - 分库分表、异步任务、补偿重放、报表聚合时更容易收敛
  - 排障时可以先信任 DB 中的时间事实，再决定展示层怎么转时区
- 因此默认原则是：
  - **存储层只存 UTC**
  - **业务展示层按需要转时区**
  - **中国自然日、born card、日报这类概念都属于读时派生语义，不属于底层持久化语义**
- 所有数据库内部时间统一按 UTC 存储
- MySQL 连接层应统一满足：
  - DSN 开启 `parseTime=true`
  - DSN 级别显式设置 `time_zone='+00:00'`，保证连接池新建连接也保持 UTC
  - 如果使用 GORM，`NowFunc` 统一返回 `time.Now().UTC()`
- 显式写库时间统一使用 `time.Now().UTC()`
- 展示层若需要中国自然日或本地时间，再在读时做 `UTC -> +8` 转换
- 不再使用 `loc=Local` 作为数据库连接默认值，也不要把“本地 wall clock”写进持久化表

### 7. 先统一模式，再迁服务

后续新服务或旧服务整改，优先顺序是：

1. 先统一目录形态：`k8s/base + k8s/overlays/<env> + scripts/deploy-k8s.sh`
2. 再统一配置来源：`platform.env` + `.secret/<service>/test.env`
3. 再统一数据库模型：`bootstrap / migration / seed`
4. 再统一发布行为：显式 `ENV`、显式 rollout、显式校验
5. 最后删除旧入口和旧脚本

### 8. 上海公网 TLS 证书的边界

- `shprod` 的公网 `Ingress` 继续由 IaC 管理：
  - host
  - path
  - upstream service
  - tls secret name
- 但 `qcloud_cert_id` 不再属于日常 workload 发布的一部分
- 原因是上海证书由腾讯云云端托管并自动轮转，日常 `deploy-k8s.sh apply` 如果继续覆盖 `qcloud_cert_id`，就会和云端轮转后的新 cert id 打架
- 当前约定：
  - `frontend/service-gateway/admin-gateway` 的 `shprod` overlay 默认不会 apply `tls-secrets.yaml`
  - 这些文件只保留作“首次绑定证书 / 显式切换证书”的手工入口
  - 日常服务发布只更新 workload 和 ingress 结构，不覆盖现网 `qcloud_cert_id`

不要反过来先做“局部补丁”，否则技术债会继续扩散。

### Agent 最短路径

如果目标是“把某个服务发到某个环境”，优先按这个顺序：

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl up --stack <env>

cd ..
python3 .ci/runtime/commands/build_release_image.py --service <service> --env <env> --tag <tag>
# 更新 argocd/services/<service>/<env>/*
git add <scoped paths>
git commit -m "<中文说明 / English summary>"
git push origin HEAD:gitops
```

如果本机没有 `platform.env`，不要手抄，直接：

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl sync --stack <env>
```

当前推荐的标准链路是：

1. `infra_pulumi` 管腾讯云基础设施
2. `infra_pulumi` 回写 `deploy/envs/<env>/platform.env`
3. source-facing workload 侧通过 `k8s/base + k8s/overlays/<env>` 消费环境事实
4. deploy-facing 正式发布入口统一落在 `argocd/`
5. 运行时敏感值通过 Kustomize / ksops 下发到集群

关键约束：

- `infractl` 只管 infra，不管 workload 正式发布。
- `deploy/envs/<env>/platform.env` 是部署事实来源，由 `infra_pulumi` 自动回写，不手改、不提交。
- `platform.env` 现在在 `.gitignore` 里统一忽略；如果某个历史环境文件仍污染工作树，说明它曾被 Git 跟踪过，需要额外 `git rm --cached` 一次。
- 北京 / 上海当前正式发布以当前 repo 的 `gitops` 分支上的 `argocd/` 为准。
- `sandbox`、`ctl`、`user/auth`、`payment`、`subscription`、`service-gateway`、`admin-gateway`、`gateway-dashboard`、`ai-gateway`、`frontend` 的北京 / 上海主链都已经迁到这套模式。
- `frontend` 的正式构建仍按 `cd frontend && pnpm install && pnpm build` 执行，再更新 GitOps pin。
- 各服务的 `deploy-k8s.sh` 现在共用：
  - [kustomize-deploy-common.sh](scripts/lib/kustomize-deploy-common.sh)
  里面统一收敛了命令检查、overlay 检查、`EOF -> --validate=false` 回退、监控 CRD 缺失兼容等行为。
- 不建议把所有服务压成一个超大总脚本；推荐形态是：
  - 每个服务保留自己的 `deploy-k8s.sh`
  - 公共行为收进 `scripts/lib/`
- 但不要再把这些脚本写成“北京 / 上海正式发版唯一入口”。
- 对于新创建的 workload namespace，默认 `ServiceAccount` 也应显式挂标准集群 pull secret，不能只假设 TKE addon 会自动把引用补到位。
- 集群级镜像拉取凭据应由 `infra_pulumi` 在建集群时统一下发，不再把“给某个项目单独补 imagePullSecrets”当成长期方案。
- 开公网的 TCR 不只要 `open_public_operation=true`，还要同时下发公网访问白名单；否则公网域名可能存在但外部机器仍然无法 `docker push/pull`。

### 现在的域名分层

当前推荐域名模型：

- 根域/前台：
  - 北京测试：`lightclaw.tech`
  - 上海 `shprod`：`preview.lightclaw.cn`
- 公网 API：
  - 北京测试：`lightclaw.tech`
  - 上海 `shprod`：`api.lightclaw.cn`
- 管理后台：
  - 北京测试：`admin.lightclaw.tech`
  - 上海 `shprod`：`admin.lightclaw.cn`

这意味着后续 agent 改配置时，不要再默认“根域就是 API”。上海已经正式分离成：

- `preview.lightclaw.cn`
- `api.lightclaw.cn`
- `admin.lightclaw.cn`

## 新服务发布改造模板

后续如果要把别的服务也迁到这套标准链路，统一按下面这个模板做，不要再回到“单个 `manifests.yaml` + 手写脚本替换变量”的旧方式。

### 目录结构

推荐结构：

```text
<service>/
  k8s/
    base/
      manifests.yaml
      kustomization.yaml
    overlays/
      beijing-sandbox/
        kustomization.yaml
      shprod/
        kustomization.yaml
  scripts/
    deploy-k8s.sh
  secret-templates/
    test.env.example
  AGENTS.md
```

### 输入边界

- `infra_pulumi` 负责回写 `deploy/envs/<env>/platform.env`
- 服务自己的敏感值放本地未跟踪文件：
  - `.secret/<service>/test.env`
- 发布脚本在 `k8s/overlays/<env>/generated/` 下生成中间输入：
  - `platform.env`
  - `<service>-runtime-secrets.env`

这些 `generated/` 文件都是本地生成物，必须忽略，不提交 Git。

### Kustomize 约束

- `base/` 里放稳定的 Deployment/Service/Job/ServiceAccount 等资源
- `overlays/<env>/` 只放环境差异和 generator 配置
- 非敏感运行时事实通过 `configMapGenerator` 下发
- 敏感值通过 `secretGenerator` 下发
- workload 默认通过 `envFrom` 读取运行时 ConfigMap/Secret
- 不再把 `MYSQL_DSN` 这类整条连接串作为跨环境主输入；优先用 `HOST/PORT + Secret password`

### 默认 ServiceAccount 约束

对新 namespace，不要只假设集群 addon 会自动兜底。服务清单里应显式声明默认 `ServiceAccount`，并挂上标准 pull secret：

- `tcr.ipsqcloudregistrykey`
- `tcr.ipstcr-regcred`
- `tcr.ipstcr-lightclaw-secret`

这样新 namespace 第一次部署也能稳定拉私有镜像。

### deploy-k8s.sh 约束

服务自己的 `deploy-k8s.sh` 应统一提供：

- `apply`
- `build`
- `status`

标准职责：

1. 读取 `deploy/envs/<env>/platform.env`
2. 读取 `.secret/<service>/test.env`
3. 生成 overlay 下的 `generated/*`
4. `kubectl apply -k`
5. 如果上海公网 API 遇到 `failed to download openapi: ... EOF`，自动回退到：

```bash
kubectl kustomize <overlay> | kubectl apply --validate=false -f -
```

这个回退已经在 `sandbox`、`payment`、`subscription` 中验证过，后续新服务继续沿用。

### 镜像地址规则

- 北京沿用当前既有 registry/path 时，可以先兼容现状
- 新环境应优先收敛到 `lightclaw` namespace
- 对 `shprod` 这类环境，镜像地址应从 `platform.env` 提供的真实 `REGISTRY_SERVER` 派生，而不是在 yaml 里写死 registry 域名

### 数据库标准

当前 repo 推荐统一成：

1. `bootstrap`
   - 只负责建库、建用户、授权
   - 可以作为 migration Job 的 `initContainer`
2. `migration`
   - 只负责执行 `migrations/*.sql`
   - Job 名用 `service-db-migrate-<UTC时间戳>`
   - 不允许再依赖固定 `db-init-vN`
3. `seed`
   - 只负责默认业务数据
   - 必须幂等
   - 不允许藏在应用启动路径里

当前可作为样板的服务：

- `sandbox`
  - 已拆成 `db-migrate` + `db-seed`
- `ctl`
  - 已有 timestamp migration Job + schema guard

已经收敛到新模型的服务：

- `user/auth`
  - `db-migrate-<timestamp>` + `db-seed-<timestamp>`
  - 应用启动不再对 MySQL store 偷偷 seed
- `payment`
  - `db-migrate-<timestamp>`
- `subscription`
  - `db-migrate-<timestamp>`
- `ai-gateway`
  - `db-migrate-<timestamp>`
  - 不再在 deploy 脚本里动态生成 `apply-migrations.sh`

### 北京 TCR 特殊说明

北京测试环境当前有一个容易踩的差异：

- 本地习惯上还能向 `ccr.ccs.tencentyun.com/clawhub/...` 推镜像
- 但 `beijing-sandbox` 集群里 workload namespace 默认挂的 pull secret，实际认证的是 `lightclaw-bj8.tencentcloudcr.com`

这会导致一种很迷惑的现象：

- 旧 Pod 继续跑没问题
- 新 tag 本地 push 也成功
- 但集群一拉新镜像就会报：
  - `failed to fetch anonymous token: 401 Unauthorized`

原因不是镜像没推成功，而是：

- kubelet 对 `ccr.ccs.tencentyun.com` 没有命中的 registry 凭据
- 于是会退回匿名拉取

所以当前北京环境发布镜像时，应该优先使用：

```text
lightclaw-bj8.tencentcloudcr.com/lightclaw/<service>:<tag>
```

对 `sandbox`、`gateway-dashboard` 这类已经切到统一 Kustomize 发布流的服务，发布时也应显式对齐到北京私有 TCR，例如：

```bash
ENV=beijing-sandbox \
REGISTRY_SERVER=lightclaw-bj8.tencentcloudcr.com \
bash sandbox/scripts/deploy-k8s.sh

ENV=beijing-sandbox \
GATEWAY_DASHBOARD_IMAGE=lightclaw-bj8.tencentcloudcr.com/lightclaw/gateway-dashboard:<tag> \
bash gateway-dashboard/scripts/deploy-k8s.sh
```

不要默认沿用：

```text
ccr.ccs.tencentyun.com/clawhub/<service>:<tag>
```

至少在 `beijing-sandbox` 这套集群里，前者才是和 namespace pull secret 对齐的地址。

另一个和这条链路相关的小坑是：

- 当因为公网 API 校验失败而退回到
  - `kubectl kustomize <overlay> | kubectl apply --validate=false -f -`
- 如果里面包含 `Job` 且模板内容变了（例如镜像地址变了）
- `apply` 会因为 `spec.template` immutable 报错

这时应先显式删除旧 `Job`，再重新 apply，而不是误以为整个发布失败。

## 当前主线

### 1. 用户侧

- [frontend](frontend)
  - 面向用户的 Web 前端
  - 当前承载营销页、登录入口、计划选择、Dashboard 外壳
- [user/auth](user/auth)
  - 用户、登录、QQ OAuth、session、subscription
  - 其他服务可通过 `/auth/session` 做 token introspection

### 2. 服务侧

- [service-gateway](service-gateway)
  - 对外统一 API 入口
  - 负责路径转发、白名单、鉴权透传、用户上下文注入
- [sandbox](sandbox)
  - 沙箱资源池系统
  - 负责 pool、inventory、预创建 CVM、分配、回收、重装、clientproxy、worker
  - 当前也已经接入 Prometheus 业务指标

### 3. 运维侧

- [nextgen-dashboard](nextgen-dashboard)
  - `/admin` 对应的 shell-first 管理台
  - Go 托管静态前端，浏览器里是终端
- [gateway-dashboard](gateway-dashboard)
  - 当前主线管理后台
  - 负责 auth users、providers/routing、sandbox pools、ctl bots 等后台管理页
- [nextgen-dashboard-client](nextgen-dashboard-client)
  - 本地终端客户端
  - 通过 websocket + Basic Auth 连接 `nextgen-dashboard`

### 4. 基础设施

- [infra_pulumi](infra_pulumi)
  - 腾讯云基础设施、TKE、数据库、监控的当前控制面
- [beijing-sandbox env docs](infra_pulumi/envs/tencentcloud/beijing-sandbox/AGENTS.md)
  - 北京测试环境的环境级文档入口
- 北京测试环境已经购买托管 Grafana，可通过腾讯云 OAuth 登录：
  - 控制台入口：`https://console.cloud.tencent.com/monitor/grafana`
  - 环境文档： [README.md](infra_pulumi/observability/beijing-sandbox/README.md)

## 顶层目录说明

- [AGENTS.md](AGENTS.md)
  - 仓库级协作规则，重点约束 migration 和 schema 变更
- [docs](docs)
  - 设计文档、开发说明、计划文档
- [infra_pulumi](infra_pulumi)
  - 当前云资源控制面和 observability 资产
- [deploy](deploy)
  - 环境部署事实目录，承接 `infra_pulumi` 回写的 `platform.env`
- [sandbox](sandbox)
  - 沙箱池系统主仓
- [user](user)
  - 用户域，目前核心是 `user/auth`
- [frontend](frontend)
  - 用户前台 Web 项目
- [service-gateway](service-gateway)
  - 公网服务网关
- [nextgen-dashboard](nextgen-dashboard)
  - 浏览器终端式管理台
- [nextgen-dashboard-client](nextgen-dashboard-client)
  - 管理台的本地客户端
- [images](images)
  - 镜像辅助内容、envd daemon 源码、agent/helper、小工具镜像
- [ctl](ctl)
  - 当前 LightVela 主链路的一部分
  - 负责实例资源、bot 归属事实等控制面能力
- [ai-gateway](ai-gateway)
  - 独立 AI 网关方向服务
- [gateway-dashboard](gateway-dashboard)
  - 当前后台主线，不再是旧原型
- [_bmad](_bmad) / [_bmad-output](_bmad-output)
  - 规划、分析、backlog、实现产物，不是运行时服务

## 怎么理解这个仓库

一句话：

`frontend + user/auth + service-gateway + sandbox + nextgen-dashboard + infra_pulumi`

构成了当前线上主链路。

其余目录里有一部分是：

- 平台模板
- 旧原型
- 独立旁支服务
- 镜像与运维辅助材料

所以这个仓库不是“一个应用”，而是一个以 `LightVela` 为中心的小型平台仓库。
# 测试环境 user-assets 桶

资源由 [infra_pulumi](infra_pulumi) 纳管：

- COS 桶：`lightclawuser-1388575217`
- 桶地址：`lightclawuser-1388575217.cos.ap-beijing.myqcloud.com`
- 桶权限：`private`
- CAM 用户：`lightclawuser-cos`

说明：

- 这套 IaC 负责 bucket 和受限 CAM API 用户。
- 凭据本身不写入仓库，只通过本地状态或安全分发渠道管理。




### 凭据配置和密钥
为了安全，我们的凭据和密钥都防止在单独的repo中，这个repo由 vaultbox 文件夹管理。
vaultbox 是一个由本地启动的服务器，
