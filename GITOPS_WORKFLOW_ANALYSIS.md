# Mono2 GitOps 工作流完整分析

## 一、Argo CD Application 定义和组织架构

### 1.1 应用架构层级

Argo CD 在本仓库中采用**分层架构**：

```
Root Application (根应用)
    ├── Beijing-Sandbox: root-beijing-sandbox
    │   ├── Project: beijing-root, beijing-argocd-runtime, beijing-sandbox
    │   └── Leaf Applications (由 ApplicationSet 生成)
    │
    └── Shanghai-Prod: root-shprod
        ├── Project: shprod-root, shprod-service-gateway, shprod-payment, ...
        └── Leaf Applications (显式定义)
```

**北京环境（Beijing-Sandbox）：**
- Root App: `root-beijing-sandbox`
- 特点：使用 **ApplicationSet** 动态生成 Leaf App
- ApplicationSet 扫描 `argocd/catalogs/sandbox/{env}/*.yaml` 生成应用

**上海环境（Shanghai-Prod）：**
- Root App: `root-shprod`
- 特点：Leaf App 显式定义，每个服务一个 `Application`
- 按服务拆分 Project（不同服务有不同权限约束）

### 1.2 Root Application 定义示例

**文件路径：** `/argocd/root/beijing-sandbox.yaml`

```yaml
apiVersion: argoproj.io/v1beta1
kind: Application
metadata:
  name: root-beijing-sandbox
  namespace: argocd
spec:
  project: beijing-root
  source:
    repoURL: git@git.woa.com:wisp/mono2.git
    targetRevision: gitops          # 指向 gitops 分支（不是 master）
    path: argocd/apps/beijing-sandbox
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

**关键点：**
- `targetRevision: gitops` - 必须指向 gitops 分支，不是 master
- `path: argocd/apps/beijing-sandbox` - 扫描该目录中的 Application 和 ApplicationSet
- 自动同步 + 自动清理 + 自我修复

### 1.3 北京环境 ApplicationSet（动态生成）

**文件路径：** `/argocd/apps/beijing-sandbox/sandbox-family-appset.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: sandbox-family
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions:
    - missingkey=error
  generators:
    - git:
        repoURL: git@git.woa.com:wisp/mono2.git
        revision: gitops
        files:
          - path: argocd/catalogs/sandbox/*/*.yaml    # 动态扫描目录
  template:
    metadata:
      name: '{{ .service }}-{{ .env }}'
      labels:
        lightclaw.dev/environment-name: '{{ .env }}'
        lightclaw.dev/service: '{{ .service }}'
    spec:
      project: '{{ .project }}'
      source:
        repoURL: git@git.woa.com:wisp/mono2.git
        targetRevision: gitops
        path: '{{ .path }}'
      destination:
        name: '{{ .destinationName }}'
        namespace: '{{ .namespace }}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

**catalog 数据格式：**

文件路径：`/argocd/catalogs/sandbox/beijing-sandbox/sandbox.yaml`

```yaml
service: sandbox
env: beijing-sandbox
project: beijing-sandbox
destinationName: beijing-sandbox
namespace: sandbox
path: argocd/services/sandbox/beijing-sandbox
```

ApplicationSet 根据 catalog 文件生成应用：
- `{{ .service }}-{{ .env }}` → `sandbox-beijing-sandbox`
- 部署到 `argocd/services/sandbox/beijing-sandbox` 中的 Kustomization

### 1.4 上海环境 Leaf Application（显式定义）

**文件路径：** `/argocd/apps/shprod/service-gateway.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: service-gateway-shprod
  namespace: argocd
spec:
  project: shprod-service-gateway
  source:
    repoURL: git@git.woa.com:wisp/mono2.git
    targetRevision: gitops
    path: argocd/services/service-gateway/shprod
  destination:
    namespace: lightclaw-gateway
    name: shprod
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### 1.5 AppProject 权限控制

**文件路径：** `/argocd/projects/shprod-service-gateway.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: shprod-service-gateway
  namespace: argocd
spec:
  description: Service gateway cutover project for Shanghai migration onto mono2
  sourceRepos:
    - git@git.woa.com:wisp/mono2.git
  destinations:
    - namespace: lightclaw-gateway
      name: shprod
  clusterResourceWhitelist:
    - group: '*'
      kind: '*'
  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'
```

**权限映射（通过 GitLab Group）：**

- `mono-shprod-release` → 可以 sync shprod 的 Leaf App
- `mono-shprod-readonly` → 只读权限

---

## 二、GitOps 真源（Source of Truth）

### 2.1 分支模型

**两分支发布模型：**

| 分支 | 用途 | 特点 |
|------|------|------|
| `master` | **源码 + CI 构建入口** | 开发者推送代码，CI 在此构建镜像 |
| `gitops` | **Argo CD 追踪的发布分支** | 部署清单真源，Argo 实时同步 |

### 2.2 分支职责拆分

**Master 分支职责：**
- 源代码
- 服务 K8s 源定义：`<service>/k8s/base/` 和 `<service>/k8s/overlays/`
- CI 配置：`.ci/*.yml`
- 构建脚本：`scripts/build-release-image.py`
- Argo 控制面定义：`argocd/root/`, `argocd/projects/`, `argocd/apps/`

**GitOps 分支职责：**
- Deploy-facing 清单：`argocd/services/<service>/<env>/`
- 镜像 Pin 值：`argocd/services/<service>/<env>/*-platform.env`
- SOPS 加密的 Secret：`argocd/secrets/<env>/*.sops.yaml`
- 由 CI 自动投影和更新

### 2.3 Argo 配置指向

**所有 Argo Application 的 targetRevision 必须是：**

```yaml
targetRevision: gitops
```

**从不指向 master**，原因：
1. Master 专为源码和构建，不是部署真源
2. GitOps 分支保持稳定的、经过验证的部署状态
3. 避免构建过程中的代码波动影响已部署环境

### 2.4 更新流程示意

```
1. 开发者在 master 修改代码
   ↓
2. CI 构建镜像（基于 master 代码）
   ↓
3. CI 运行 pin_image_to_gitops.sh
   - 把 argocd/services/<env>/ 从 master 投影到 gitops
   - 更新 *-platform.env 中的镜像 URL
   ↓
4. GitOps 分支被更新
   ↓
5. Argo 自动同步（基于 gitops 分支）
   ↓
6. 环境更新到最新镜像
```

---

## 三、镜像构建、标记和推送流程

### 3.1 镜像元数据定义

**文件路径：** `/scripts/release-bundles.yaml`

```yaml
bundles:
  sandbox:
    owner: sandbox
    source: sandbox
    reason: "Sandbox service formal release bundle..."
    allowed_paths:
      - sandbox/k8s/base
      - sandbox/k8s/overlays/beijing-sandbox
      - sandbox/k8s/overlays/shprod
      - sandbox/config
      - sandbox/migrations
    exit_condition: "..."
    publish_paths:
      - argocd/services/sandbox/{env}/**
      - argocd/secrets/{env}/sandbox-runtime-secrets.sops.yaml
      - sandbox/k8s/base/**
      - sandbox/k8s/overlays/{env}/**
    dockerfile: sandbox/deploy/Dockerfile
    build_context: sandbox
    image_repo:
      beijing-sandbox: lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api
      shprod: lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-api
```

**关键字段说明：**
- `dockerfile`：Dockerfile 相对路径
- `build_context`：Docker build context 路径
- `image_repo`：环境特定的镜像仓库 URL 前缀
- `publish_paths`：CI 需要投影到 gitops 的路径（支持 `{env}` 占位符）

### 3.2 镜像标记规范

**标记格式：** `{TAG_PREFIX}-{SHORT_SHA}`

**示例：**
```
service-gateway-abc1234567   # 12位短SHA
sandbox-def5678901
```

**完整镜像 URL 示例：**
```
lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-api:shprod-20260424-null-divergence-9da9f73
lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api:bj8-20260420-vpcshard-7912627d
```

**环境差异：**
- Beijing：`lightclaw-bj8.tencentcloudcr.com`
- Shanghai：`lightclaw-shprod.tencentcloudcr.com`

### 3.3 镜像构建脚本

**文件路径：** `/scripts/build-release-image.py`

**调用方式（来自 CI）：**

```bash
python3 scripts/build-release-image.py \
  --service sandbox \
  --env shprod \
  --tag "sandbox-abc1234567" \
  --platform linux/amd64 \
  --push
```

**脚本流程：**

1. 读取 `release-bundles.yaml` 获取元数据
2. 从环境变量或本地文件获取镜像仓库认证
3. 执行 `docker login`
4. 运行 `docker build`
5. 如指定 `--push`，执行 `docker push`
6. 输出最终镜像 URL

**认证优先级：**

```
本地文件（优先）
  ├── /etc/lightclaw-ci/tcr_beijing_password
  ├── /etc/lightclaw-ci/tcr_shprod_password
  └── /etc/lightclaw-ci/git_woa_private_token
↓
Stream Settings（回落）
  ├── TCR_BEIJING_PASSWORD
  ├── TCR_SHPROD_PASSWORD
  └── GIT_WOA_PRIVATE_TOKEN
```

### 3.4 CI 构建和推送整体流程

**文件路径：** `/scripts/build_and_promote_to_gitops.sh`

```bash
# CI 调用方式（来自 .ci/service-gateway.yml）
REMOTE_URL="git@git.woa.com:wisp/mono2.git" \
GITOPS_BRANCH=gitops \
BUILD_TAG_OVERRIDE="${TAG}" \
bash scripts/build_and_promote_to_gitops.sh \
  service-gateway \           # Bundle Service
  service-gateway,admin-gateway \  # Pin Targets (逗号分隔)
  beijing-sandbox,shprod \    # Build Envs (构建的环境)
  beijing-sandbox             # Auto-Pin Env (自动投影的环境)
```

**脚本流程：**

1. 获取当前 commit SHA（短12位）
2. 生成标记：`service-gateway-{SHORT_SHA}`
3. 对于每个环境执行 `build-release-image.py --push`
4. 获得最终镜像 URL（如 `registry/image:tag`）
5. 调用 `pin_image_to_gitops.sh` 投影到 gitops 分支
6. 对于 beijing-sandbox 环境，自动创建 MR 并自动合并
7. 对于其他环境，创建 MR 等待人工审批

---

## 四、部署清单更新和 Argo 同步触发机制

### 4.1 部署清单组织（Deploy-Facing）

**整体结构：**

```
argocd/
├── services/
│   ├── sandbox/
│   │   ├── beijing-sandbox/
│   │   │   ├── kustomization.yaml
│   │   │   ├── sandbox-platform.env
│   │   │   ├── tls-secrets.yaml
│   │   │   └── ksops-secret-generator.yaml
│   │   ├── shprod/
│   │   │   ├── kustomization.yaml
│   │   │   ├── sandbox-platform.env
│   │   │   └── ksops-secret-generator.yaml
│   │   └── common/
│   │       └── kustomization.yaml  # 参数注入配置
│   ├── service-gateway/
│   │   ├── beijing-sandbox/
│   │   ├── shprod/
│   │   └── common/
│   └── [其他服务...]
└── secrets/
    ├── beijing-sandbox/
    │   └── *-runtime-secrets.sops.yaml
    └── shprod/
        └── *-runtime-secrets.sops.yaml
```

### 4.2 参数驱动的 Kustomize 架构

**文件路径：** `/argocd/services/sandbox/common/kustomization.yaml`

核心概念：**ConfigMap 驱动 + Kustomize Replacements**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: sandbox

generatorOptions:
  disableNameSuffixHash: true

# 第一步：从 sandbox-platform.env 生成 ConfigMap
configMapGenerator:
  - name: sandbox-platform-values
    envs:
      - sandbox-platform.env

# 第二步：使用 replacements 把 ConfigMap 值注入到资源
replacements:
  # 注入镜像到 Deployment
  - source:
      kind: ConfigMap
      name: sandbox-platform-values
      fieldPath: data.SANDBOX_API_IMAGE
    targets:
      - select:
          kind: Deployment
          name: sandbox-api
        fieldPaths:
          - spec.template.spec.containers.0.image
  
  # 注入镜像到 Job
  - source:
      kind: ConfigMap
      name: sandbox-platform-values
      fieldPath: data.SANDBOX_WORKER_IMAGE
    targets:
      - select:
          kind: Deployment
          name: sandbox-worker
        fieldPaths:
          - spec.template.spec.containers.0.image
  
  # 注入环境配置
  - source:
      kind: ConfigMap
      name: sandbox-platform-values
      fieldPath: data.SANDBOX_REDIS_ADDR
    targets:
      - select:
          kind: ConfigMap
          name: sandbox-runtime-config
        fieldPaths:
          - data.REDIS_ADDR
```

### 4.3 平台参数文件（部署触发点）

**文件路径：** `/argocd/services/sandbox/shprod/sandbox-platform.env`

```env
# 基础环境配置
REGISTRY_SERVER=lightclaw-shprod.tencentcloudcr.com
SANDBOX_MYSQL_HOST=10.15.192.13
SANDBOX_REDIS_ADDR=10.15.192.115:6379
TENCENT_REGION=ap-shanghai
SANDBOX_VPC_ID=vpc-2y7p1lk6
SANDBOX_NODE_POOL=general-shprod
SANDBOX_SUPPORT_SUBNET_ID=subnet-38xcw327

# 关键：镜像 URL（CI 更新这里）
SANDBOX_API_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-api:shprod-20260424-null-divergence-9da9f73
SANDBOX_MIGRATE_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-migrate:bj8-20260420-vpcshard-7912627d
SANDBOX_WORKER_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-worker:bj8-20260420-vpcshard-7912627d
SANDBOX_WORKER_QUORUM_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-worker:bj8-20260420-vpcshard-7912627d

# 部署时间戳
SANDBOX_API_DEPLOYED_AT=2026-04-24T05:46:35Z
SANDBOX_WORKER_DEPLOYED_AT=2026-04-23T12:36:39Z
```

**关键理解：**
- 每个参数对应一个环境变量名
- 格式：`SERVICE_PARAM_NAME=value`
- Kustomize `configMapGenerator` 把这个 .env 文件转为 ConfigMap
- `replacements` 把 ConfigMap 中的值注入到 K8s 资源中

### 4.4 Argo 同步触发

**触发流程：**

```
1. CI 更新 argocd/services/sandbox/shprod/sandbox-platform.env
   SANDBOX_API_IMAGE=lightclaw-shprod.tencentcloudcr.com/...:{NEW_TAG}

2. Git commit + push to gitops 分支

3. Argo 检测到 gitops 分支变化

4. Argo 重新运行 Kustomize build
   - 读取新的 sandbox-platform.env
   - 生成新的 ConfigMap
   - 通过 replacements 注入新镜像 URL

5. Argo 对比当前集群状态与新清单

6. 如果配置了自动同步（syncPolicy.automated），立即应用

7. 新镜像 Deployment 替换旧 Pod

8. 应用切换到新版本
```

### 4.5 北京 vs 上海环境的同步方式差异

**北京环境（Auto-Sync）：**
- CI 自动构建 + 自动投影 + 自动合并 MR
- Argo 自动同步（`syncPolicy.automated: true`）
- 结果：代码 merge 后立即部署（~5 分钟）

**上海环境（Manual-Sync）：**
- CI 构建 + 投影 + 创建 MR，等待人工审批
- MR 审批后，CI 自动合并
- Argo 自动同步（`syncPolicy.automated: true`）
- 结果：人工审批后部署（取决于审批时间）

---

## 五、双环境部署差异（北京 vs 上海）

### 5.1 Argo 控制面差异

| 配置项 | 北京 | 上海 |
|--------|------|------|
| 控制面 | 新 Argo CD | 新 Argo CD（共享） |
| Root App | `root-beijing-sandbox` | `root-shprod` |
| Leaf 应用定义 | ApplicationSet 动态生成 | 显式 Application |
| 应用数量 | 多环境共生 | 仅 shprod |
| Git 分支 | gitops | gitops |
| Cluster 名称 | `beijing-sandbox` | `shprod` |

### 5.2 源码层差异

**源码目录结构相同，但覆盖层不同：**

```
sandbox/
├── k8s/base/              # 共享源定义
├── k8s/overlays/
│   ├── beijing-sandbox/   # 北京特定覆盖
│   └── shprod/            # 上海特定覆盖
└── deploy/
    └── Dockerfile
```

### 5.3 部署参数差异

**北京 Beijing-Sandbox：**

文件路径：`/argocd/services/sandbox/beijing-sandbox/sandbox-platform.env`

```env
REGISTRY_SERVER=lightclaw-bj8.tencentcloudcr.com
SANDBOX_MYSQL_HOST=10.15.224.4
SANDBOX_REDIS_ADDR=10.15.224.15:6379
TENCENT_REGION=ap-beijing
SANDBOX_VPC_ID=vpc-21gzr2dc
SANDBOX_NODE_POOL=general-bj8
SANDBOX_SUPPORT_SUBNET_ID=subnet-ieszm71b
SANDBOX_INGRESSPROXY_PUBLIC_HOST=*.sandbox.lightclaw.tech
SANDBOX_API_IMAGE=lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api:bj8-20260420-vpcshard-7912627d
```

**上海 Shanghai-Prod：**

文件路径：`/argocd/services/sandbox/shprod/sandbox-platform.env`

```env
REGISTRY_SERVER=lightclaw-shprod.tencentcloudcr.com
SANDBOX_MYSQL_HOST=10.15.192.13
SANDBOX_REDIS_ADDR=10.15.192.115:6379
TENCENT_REGION=ap-shanghai
SANDBOX_VPC_ID=vpc-2y7p1lk6
SANDBOX_NODE_POOL=general-shprod
SANDBOX_SUPPORT_SUBNET_ID=subnet-38xcw327
SANDBOX_API_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-api:shprod-20260424-null-divergence-9da9f73
```

**主要差异：**
- 镜像仓库：bj8 vs shprod
- 数据库地址：北京内网 vs 上海内网
- Redis 地址：不同网段
- VPC / 子网 / Zone：不同基础设施
- 镜像标记方案：可能不同（格式一致）

### 5.4 CI 流程差异

**北京流程（.ci/service-gateway.yml）：**

```yaml
- name: build-and-promote-beijing
  run: |
    bash scripts/build_and_promote_to_gitops.sh \
      service-gateway \
      service-gateway,admin-gateway \
      beijing-sandbox,shprod \        # 构建两个环境
      beijing-sandbox                 # 自动同步北京
```

**自动行为：**
1. 构建 beijing-sandbox 和 shprod 两个镜像
2. 投影到 gitops（推送 promote-* 分支）
3. 创建 MR 到 gitops（自动指定 beijing-sandbox）
4. CI 轮询等待北京环保检查通过
5. 自动合并 MR（仅北京）
6. 删除 promote 源分支

**上海流程（.ci/gitops-promotion.yml）：**

这是一个单独的 CI 工作流，在 promote 分支 commit check 通过后触发。

```yaml
- name: promote-manual
  if: ${{ variables.PIPELINE_MODE }} == 'promote'
  run: |
    bash scripts/promote_bundle_image_to_gitops.sh \
      service-gateway \
      service-gateway,admin-gateway \
      shprod \                        # 目标环境
      "${{ variables.SOURCE_SHA }}"   # 源 SHA
```

**手动行为：**
1. 从 SOURCE_SHA 构建 shprod 镜像
2. 投影到 gitops
3. 创建 MR（等待人工审批）
4. 人工 review 和 approve
5. 人工 merge（不自动）
6. Argo 自动同步

### 5.5 Kustomize 配置差异

**共享 Common 层：** `/argocd/services/sandbox/common/kustomization.yaml`

```yaml
resources:
  - ../../../../sandbox/k8s/base   # 源定义

replacements:
  # 100+ 个参数注入规则
  - source: ConfigMap.sandbox-platform-values.SANDBOX_API_IMAGE
    targets: Deployment.sandbox-api.spec.template.spec.containers.0.image
  # ... 等等
```

**环境特定层 Beijing：** `/argocd/services/sandbox/beijing-sandbox/kustomization.yaml`

```yaml
resources:
  - ../common              # 继承共享层
patches:
  - path: patch-ingressproxy-router-service.yaml
  - path: delete-ingressproxy-router-ingress.yaml
generators:
  - ksops-secret-generator.yaml
configMapGenerator:
  - name: sandbox-platform-values
    envs:
      - sandbox-platform.env
```

**环境特定层 Shanghai：** `/argocd/services/sandbox/shprod/kustomization.yaml`

（结构相同，参数不同）

---

## 六、Secrets 管理（SOPS + AGE + Ksops）

### 6.1 加密架构概览

```
开发者
  ↓
source-facing secret (.secret/)
  ↓
SOPS + AGE 加密
  ↓
Git 存储 (*.sops.yaml)
  ↓
Argo 部署时
  ├─ ksops 插件解密
  ├─ AGE 私钥（集群内注入）
  └─ 生成 K8s Secret
```

### 6.2 Secret 存储位置

**加密的 Secret 文件：** `/argocd/secrets/<env>/*.sops.yaml`

```
argocd/secrets/
├── beijing-sandbox/
│   ├── admin-gateway-runtime-secrets.sops.yaml
│   ├── ai-gateway-runtime-secrets.sops.yaml
│   ├── gateway-dashboard-runtime-secrets.sops.yaml
│   ├── lightclaw-auth-secrets.sops.yaml
│   ├── nextgen-dashboard-runtime-secrets.sops.yaml
│   ├── payment-runtime-secrets.sops.yaml
│   ├── sandbox-runtime-secrets.sops.yaml
│   ├── service-gateway-runtime-secrets.sops.yaml
│   └── subscription-runtime-secrets.sops.yaml
└── shprod/
    └── [相同的 Secret 文件，值不同]
```

### 6.3 SOPS 配置（.sops.yaml）

Repo 根目录的 `.sops.yaml` 定义加密策略：

```yaml
creation_rules:
  - path_regex: argocd/secrets/.*
    age: |
      age1xxxxx...  # AGE 公钥
```

**AGE 公钥：** 用于加密
**AGE 私钥：** 必须 Git 外注入到 Argo 集群

### 6.4 Argo 中的 Secret 解密

**Bootstrap 流程：** `/scripts/bootstrap_argocd_sops_age.sh`

```bash
# 在新 Argo 集群上运行
KUBECONFIG_PATH=/path/to/argocd-control-plane.kubeconfig \
  bash scripts/bootstrap_argocd_sops_age.sh
```

**功能：**
1. 读取本地 AGE 私钥（从某处安全来源）
2. 在 argocd namespace 创建 Secret `sops-age`
3. 配置 repo-server 挂载该 Secret

### 6.5 Ksops Secret Generator

**文件路径：** `/argocd/services/sandbox/shprod/ksops-secret-generator.yaml`

```yaml
apiVersion: viaduct.ai/v1
kind: ksops
metadata:
  name: sandbox-runtime-secrets
files:
  - ../../../secrets/shprod/sandbox-runtime-secrets.sops.yaml
```

**工作原理：**
1. Argo 部署时运行 Kustomize
2. Kustomize 读到 ksops generator
3. Kustomize 调用 ksops 插件
4. ksops 使用 sops 命令解密 .sops.yaml
5. sops 使用集群中的 AGE 私钥解密
6. 生成 K8s Secret

### 6.6 北京特殊配置（Runtime 补丁）

**文件路径：** `/argocd/runtime/beijing-sandbox/argocd-repo-server.yaml`

北京需要额外配置使 repo-server 能解密和执行 Kustomize 插件：

```yaml
apiVersion: v1
kind: Patch
metadata:
  name: argocd-repo-server
spec:
  # 注入 ksops 插件
  # 挂载 sops-age Secret
  # 配置 KUSTOMIZE_PLUGIN_HOME
  # 启用 alpha 插件和 exec
```

**为什么北京需要这个：**
1. 北京 Argo 控制面是新部署的
2. 必须手工注入 ksops 和 sops 能力
3. 通过 `argocd-runtime-beijing-sandbox` 应用自动管理这些补丁
4. 这样重建后会自动应用

### 6.7 Secret 权威来源

**长期权威真源：** Tencent Cloud SSM（密钥管理服务）

**Git 中的 .sops.yaml 是：**
- Deployable snapshot（可部署的快照）
- 用于集群同步
- 但不是长期存储的真源

**更新 Secret 流程：**
1. 在 SSM 更新密钥
2. 使用 `sops` CLI 重新加密 .sops.yaml
3. Commit 到 Git
4. Argo 自动同步新值到集群

---

## 七、完整发布流程（从代码变更到生产）

### 7.1 发布流程总览

```
┌─────────────────────────────────────────┐
│ 1. 开发者修改代码 (master 分支)          │
│    - 修改服务源码（如 sandbox/）        │
│    - 或修改 K8s 定义（sandbox/k8s/）    │
└────────────────┬────────────────────────┘
                 │
                 ↓
┌─────────────────────────────────────────┐
│ 2. 推送到远程 (master 分支)              │
│    git push origin feature-branch      │
│    git push origin master              │
└────────────────┬────────────────────────┘
                 │
                 ↓
┌─────────────────────────────────────────┐
│ 3. CI 触发构建流程 (.ci/sandbox.yml)     │
│    - 基于 on.push.paths 自动触发       │
└────────────────┬────────────────────────┘
                 │
                 ↓
        ╔═══════════════════════╗
        ║ 【北京 Auto-Sync】    ║
        ║ 【上海 Manual-Sync】  ║
        ╚═══════════════════════╝
                 │
        ┌────────┴─────────┐
        │                  │
        ↓                  ↓
   【北京流程】      【上海流程】
```

### 7.2 北京流程详细步骤

**步骤 1-3：同上**

**步骤 4：CI 构建和自动投影**

CI Job 执行：

```bash
# .ci/init.sh 初始化环境
source .ci/init.sh
ci_init_repo_root
ci_ensure_node
ci_ensure_pnpm

# 构建镜像并投影到 gitops
REMOTE_URL="git@git.woa.com:wisp/mono2.git" \
GITOPS_BRANCH=gitops \
BUILD_TAG_OVERRIDE="sandbox-abc1234567" \
bash scripts/build_and_promote_to_gitops.sh \
  sandbox \
  sandbox \
  beijing-sandbox,shprod \
  beijing-sandbox
```

**脚本执行流程：**

1. **获取 Git 信息**
   ```bash
   SHORT_SHA=$(git rev-parse --short=12 HEAD)  # abc1234567
   SOURCE_REF=$(git rev-parse HEAD)             # 完整 SHA
   TAG="sandbox-${SHORT_SHA}"
   ```

2. **构建两个环境的镜像**
   
   对于 beijing-sandbox：
   ```bash
   python3 scripts/build-release-image.py \
     --service sandbox \
     --env beijing-sandbox \
     --tag "$TAG" \
     --push
   # 输出：lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api:sandbox-abc1234567
   ```
   
   对于 shprod：
   ```bash
   python3 scripts/build-release-image.py \
     --service sandbox \
     --env shprod \
     --tag "$TAG" \
     --push
   # 输出：lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-api:sandbox-abc1234567
   ```

3. **为北京环境创建 Promote 分支**
   
   ```bash
   # 在本地创建 promote-sandbox-beijing-sandbox-abc12345 分支
   # 从 gitops 拉取最新代码
   
   # 投影 argocd/services/sandbox/beijing-sandbox/ 到该分支
   # 更新 sandbox-platform.env：
   #   SANDBOX_API_IMAGE=lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api:sandbox-abc1234567
   
   # Commit：
   git add argocd/services/sandbox/beijing-sandbox/
   git commit -m "pin sandbox images for beijing-sandbox at abc1234567"
   
   # 推送：
   git push -u origin promote-sandbox-beijing-sandbox-abc12345
   ```

4. **创建 GitLab MR**
   
   ```bash
   # 调用 scripts/gitops_merge_request.py
   # 参数：
   #   - source_branch: promote-sandbox-beijing-sandbox-abc12345
   #   - target_branch: gitops
   #   - title: "Promote sandbox for beijing-sandbox"
   #   - description: 包含部署信息
   
   # 返回 MR ID，如 #12345
   ```

5. **轮询等待 Commit Check 通过**
   
   ```bash
   # scripts/gitops_merge_request.py 中的轮询逻辑
   # 每 30 秒检查一次 MR 状态
   # 等待所有 commit check 绿灯
   ```

6. **自动合并 MR（仅北京）**
   
   ```bash
   # 当所有 check 通过：
   curl -X PUT "https://git.woa.com/api/v3/projects/1731878/merge_requests/12345/merge"
   
   # gitops 分支被更新
   ```

7. **Argo 自动同步（北京）**
   
   Argo 检测到 gitops 分支更新：
   - `root-beijing-sandbox` App 检查到 `argocd/apps/beijing-sandbox/` 变化
   - ApplicationSet 或 Leaf App 重新渲染清单
   - 检测到 `argocd/services/sandbox/beijing-sandbox/sandbox-platform.env` 变化
   - Kustomize 重新构建：ConfigMap 中 SANDBOX_API_IMAGE 更新
   - Argo 对比清单差异
   - 自动应用（因为 `syncPolicy.automated: true`）
   - 集群中 sandbox-api Deployment 被滚动更新

8. **部署完成**
   
   - 旧 Pod 被驱逐
   - 新镜像的 Pod 启动
   - Service 流量转移到新 Pod
   - 部署完成，通常 5-10 分钟

### 7.3 上海流程详细步骤

**步骤 1-3：同北京**

**步骤 4：CI 创建 MR，不自动合并**

```bash
REMOTE_URL="git@git.woa.com:wisp/mono2.git" \
GITOPS_BRANCH=gitops \
BUILD_TAG_OVERRIDE="sandbox-def5678901" \
bash scripts/build_and_promote_to_gitops.sh \
  sandbox \
  sandbox \
  shprod \          # 仅构建 shprod
  # 没有第四个参数 → 不自动投影任何环境
```

实际上，上海的推送不是通过 `build_and_promote_to_gitops.sh`，而是通过手动或另一个流程。

**或者通过手动 Promote 流程：**

1. **手动指定发布**
   
   ```bash
   # 在 CI 中手动改 PIPELINE_MODE=promote，SOURCE_SHA=abc123...
   ```

2. **CI 从指定 SHA 拉取镜像信息**
   
   ```bash
   bash scripts/promote_bundle_image_to_gitops.sh \
     sandbox \
     sandbox \
     shprod \
     abc1234567
   ```

3. **创建 Promote 分支和 MR**
   
   ```bash
   # 创建 promote-sandbox-shprod-abc12345 分支
   # 投影 argocd/services/sandbox/shprod/
   # 更新 sandbox-platform.env
   # 推送并创建 MR
   ```

4. **人工审批**
   
   - 运维/技术负责人 Review MR
   - 检查镜像版本、部署时间
   - Approve MR

5. **人工合并**
   
   - 负责人手动点击 Merge 按钮
   - gitops 分支被更新

6. **Argo 自动同步（上海）**
   
   - `root-shprod` App 检测到 gitops 变化
   - `sandbox-shprod` Leaf App 检测到 `argocd/services/sandbox/shprod/` 变化
   - Kustomize 重新构建
   - Argo 自动应用
   - 集群部署完成

### 7.4 关键时间线对比

| 阶段 | 北京 | 上海 |
|------|------|------|
| 代码提交到部署 | ~5-10 分钟 | 取决于审批 |
| 自动检查 | 自动，~2 分钟 | 自动，~2 分钟 |
| 人工审批 | 无 | 需要 |
| MR 合并 | 自动 | 手动 |
| Argo 同步 | 自动 | 自动 |
| 应用更新 | 自动 | 自动 |

### 7.5 发布失败处理

**如果 CI 构建失败：**
- 没有镜像推送
- 没有 MR 创建
- 开发者修复问题后重新 push
- CI 重新运行

**如果 Commit Check 失败（北京）：**
- MR 保持 Open 状态
- CI 不会自动合并
- 开发者修复问题
- 新 commit 推送到 promote 分支
- Check 重新运行

**如果部署后出现问题：**
- 可以快速 Rollback：revert 最后的 gitops commit
- 或者手动修改 -platform.env，改回旧镜像 URL
- Argo 自动同步回旧版本

### 7.6 完整流程示意图

```
Master 分支                     GitOps 分支                    集群
────────────────              ────────────────             ────────
代码修改
   ↓
git push master
   ↓
CI 触发                         
   ├─ 构建镜像 ──→ TCR Registry
   ├─ 创建 promote 分支 ────────→ promote-*
   ├─ 提交到 promote ───────────→ 更新 *-platform.env
   └─ 创建 MR ────────────────→ 指向 gitops
        │
        ├─【北京】
        │  ├─ 等待 Check ───────→ CI/CD Commit Check
        │  ├─ 自动合并 ────────→ gitops 分支更新
        │  └─ Argo 自动同步 ───→ 集群部署开始
        │
        └─【上海】
           ├─ 等待审批 ────────→ MR 在 GitLab 等待
           ├─ 人工 Merge ──────→ gitops 分支更新
           └─ Argo 自动同步 ───→ 集群部署开始
                                     │
                                     ├─ Kustomize build
                                     ├─ 对比差异
                                     ├─ 应用新清单
                                     └─ Pod 滚动更新
```

---

## 八、关键脚本和配置文件速查

| 功能 | 文件路径 | 用途 |
|------|--------|------|
| 元数据定义 | `scripts/release-bundles.yaml` | 定义每个服务的构建参数 |
| 镜像构建 | `scripts/build-release-image.py` | Docker 构建和推送 |
| 构建+投影 | `scripts/build_and_promote_to_gitops.sh` | 完整 CI 流程 |
| 手动投影 | `scripts/promote_bundle_image_to_gitops.sh` | 手动发布特定 SHA |
| 投影核心 | `scripts/pin_image_to_gitops.sh` | 投影和 MR 创建 |
| MR 管理 | `scripts/gitops_merge_request.py` | MR 创建、轮询、合并 |
| 环境初始化 | `.ci/init.sh` | CI 环境准备 |
| 北京 CI | `.ci/sandbox.yml` 等 | 每个服务的 CI 配置 |
| Argo 控制面 | `argocd/runtime/beijing-sandbox/` | 北京特殊的 runtime patch |
| Secret 启动 | `scripts/bootstrap_argocd_sops_age.sh` | AGE 密钥注入 |

---

## 九、常见问题和故障排除

### Q1：为什么 Argo 要指向 gitops，而不是 master？

**A：** 
- Master 是源代码分支，内容频繁变化
- GitOps 分支是稳定的、审核过的部署状态
- 分离职责，避免代码构建过程中的波动影响已部署环境

### Q2：修改代码后多久会部署？

**A：**
- **北京**：~5-10 分钟（自动流程）
- **上海**：取决于审批时间，通常需要人工干预

### Q3：如何快速 Rollback？

**A：**
1. 在 gitops 分支 revert 最后的 commit
2. 或手动修改 `-platform.env` 中的镜像 URL
3. Argo 自动同步回旧版本（通常 1-2 分钟）

### Q4：Secret 如何安全存储？

**A：**
- 使用 SOPS + AGE 加密存储在 Git
- AGE 私钥通过 Git 外方式注入集群
- 集群中 ksops 插件在部署时自动解密

### Q5：为什么北京和上海镜像仓库不同？

**A：**
- 北京 `lightclaw-bj8`：北京区域的 TCR
- 上海 `lightclaw-shprod`：上海区域的 TCR
- 各环境独立，镜像仓库与数据中心同区域

---

END
