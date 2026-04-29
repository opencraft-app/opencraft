# Mono2 GitOps 工作流快速参考

## 核心概念速记

### 分支模型
```
master              gitops
├─ 源代码           ├─ 部署清单
├─ CI 构建          ├─ Argo 追踪
└─ 源 K8s 定义      └─ Deploy-facing 配置
```

### 部署架构
```
Root App
├─ Beijing: root-beijing-sandbox (ApplicationSet 动态生成)
└─ Shanghai: root-shprod (显式 Application)
```

### 关键路径

| 步骤 | 文件/操作 | 说明 |
|------|--------|------|
| **源定义** | `sandbox/k8s/base/**` | 服务源 K8s 清单 |
| **元数据** | `scripts/release-bundles.yaml` | 构建参数（Dockerfile、镜像仓库等） |
| **镜像** | TCR Registry | 北京/上海不同仓库 |
| **部署** | `argocd/services/sandbox/<env>/` | Deploy-facing 清单 |
| **参数** | `*-platform.env` | **← 部署触发点** |
| **Argo** | `argocd/root/` + `argocd/apps/` | 应用定义 |

---

## 快速查询表

### 文件位置速查

```
argocd/
├── root/                           # Root App 定义
│   ├── beijing-sandbox.yaml        # 北京 Root App
│   └── shprod.yaml                 # 上海 Root App
├── apps/                           # Leaf App 定义
│   ├── beijing-sandbox/
│   │   ├── sandbox-family-appset.yaml
│   │   └── argocd-runtime.yaml
│   └── shprod/
│       ├── service-gateway.yaml
│       ├── sandbox.yaml
│       └── [其他服务...]
├── projects/                       # AppProject（权限）
│   ├── beijing-root.yaml
│   ├── shprod-root.yaml
│   └── shprod-service-gateway.yaml
├── services/                       # ★ Deploy-facing 部署清单 ★
│   ├── sandbox/
│   │   ├── beijing-sandbox/
│   │   │   ├── kustomization.yaml
│   │   │   ├── sandbox-platform.env   # ← 部署参数
│   │   │   └── ksops-secret-generator.yaml
│   │   ├── shprod/
│   │   │   └── sandbox-platform.env   # ← 部署参数
│   │   └── common/
│   │       └── kustomization.yaml     # ← Replacements 配置
│   └── [其他服务...]
├── secrets/                        # SOPS 加密 Secret
│   ├── beijing-sandbox/
│   │   └── *.sops.yaml
│   └── shprod/
│       └── *.sops.yaml
├── runtime/                        # 北京 Argo 控制面补丁
│   ├── argocd-cm.yaml
│   └── argocd-repo-server.yaml
└── catalogs/                       # ApplicationSet 数据源
    └── sandbox/
        ├── beijing-sandbox/
        │   └── *.yaml              # service, env, project, ...
        └── shprod/
            └── *.yaml
```

### 服务目录结构

```
<service>/
├── k8s/base/                    # 源 K8s 定义
│   └── kustomization.yaml
├── k8s/overlays/
│   ├── beijing-sandbox/         # 北京特定覆盖
│   └── shprod/                  # 上海特定覆盖
├── deploy/
│   └── Dockerfile
└── [代码...]
```

---

## 部署参数驱动机制

### 三层 Kustomize 结构

```
第一层：源定义
└─ sandbox/k8s/base/kustomization.yaml
   └─ resources: manifests.yaml

第二层：参数注入（Common 层）
└─ argocd/services/sandbox/common/kustomization.yaml
   ├─ resources: ../../../../sandbox/k8s/base
   └─ replacements: [100+ 个参数注入规则]

第三层：环境特定（Beijing/Shanghai 层）
└─ argocd/services/sandbox/beijing-sandbox/kustomization.yaml
   ├─ resources: ../common
   ├─ configMapGenerator: sandbox-platform.env
   └─ generators: ksops-secret-generator.yaml
```

### 参数更新流程

```
CI 更新 sandbox-platform.env
  ├─ SANDBOX_API_IMAGE=lightclaw-bj8.tencentcloudcr.com/sandbox-api:new-tag
  └─ Push to gitops 分支
      └─ Argo 检测变化
          ├─ Kustomize build
          │  ├─ 读取 sandbox-platform.env
          │  └─ 生成 ConfigMap
          ├─ replacements 注入
          │  └─ ConfigMap.SANDBOX_API_IMAGE → Deployment.image
          └─ 对比集群
              └─ 更新 Deployment (Pod 滚动更新)
```

---

## 镜像标记和位置

### 北京环境（Beijing-Sandbox）

```
Registry: lightclaw-bj8.tencentcloudcr.com
Service: lightclaw/sandbox-api
Tag: bj8-20260420-vpcshard-7912627d

完整 URL:
lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api:bj8-20260420-vpcshard-7912627d

存储位置:
argocd/services/sandbox/beijing-sandbox/sandbox-platform.env
SANDBOX_API_IMAGE=lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api:bj8-...
```

### 上海环境（Shanghai-Prod）

```
Registry: lightclaw-shprod.tencentcloudcr.com
Service: lightclaw/sandbox-api
Tag: shprod-20260424-null-divergence-9da9f73

完整 URL:
lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-api:shprod-20260424-...

存储位置:
argocd/services/sandbox/shprod/sandbox-platform.env
SANDBOX_API_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/sandbox-api:shprod-...
```

---

## CI 流程对比

### 北京（自动发布）

```
1. 开发者 push master
   ↓
2. CI 构建镜像 (beijing-sandbox + shprod)
   ↓
3. 投影到 promote-* 分支
   ↓
4. 创建 MR 到 gitops
   ↓
5. ⏳ 等待 Commit Check (~2 分钟)
   ↓
6. ✓ 自动合并 MR
   ↓
7. 🔄 Argo 自动同步 (~1-2 分钟)
   ↓
8. ✅ 部署完成 (总计 ~5-10 分钟)
```

**入口脚本：** `.ci/sandbox.yml`

```yaml
jobs.release.steps:
  - build-and-promote-beijing:
      bash scripts/build_and_promote_to_gitops.sh \
        sandbox \
        sandbox \
        beijing-sandbox,shprod \   # 构建两个环境
        beijing-sandbox            # 自动投影北京
```

### 上海（手动发布）

```
1. 开发者 push master (或手动触发 CI)
   ↓
2. CI 构建镜像 (shprod only)
   ↓
3. 投影到 promote-* 分支
   ↓
4. 创建 MR 到 gitops
   ↓
5. ⏳ 等待人工审批
   ↓
6. 👤 运维 Review + Approve
   ↓
7. 👤 运维 Merge MR
   ↓
8. 🔄 Argo 自动同步
   ↓
9. ✅ 部署完成
```

**入口脚本：** 手动 `PIPELINE_MODE=promote`

```bash
bash scripts/promote_bundle_image_to_gitops.sh \
  sandbox \
  sandbox \
  shprod \
  SOURCE_SHA
```

---

## Secret 管理

### 加密架构

```
Tencent Cloud SSM (长期真源)
  ↓
.secret/ (源文件，本地)
  ↓
SOPS + AGE 加密
  ↓
git 存储: argocd/secrets/<env>/*.sops.yaml
  ↓
部署时：
  ├─ Argo 触发 Kustomize
  ├─ ksops 插件
  ├─ sops CLI
  ├─ AGE 私钥 (集群内注入)
  ├─ 解密 Secret
  └─ 创建 K8s Secret
```

### 文件位置

```
加密文件：
argocd/secrets/beijing-sandbox/*.sops.yaml
argocd/secrets/shprod/*.sops.yaml

生成器配置：
argocd/services/<service>/<env>/ksops-secret-generator.yaml

内容示例：
apiVersion: viaduct.ai/v1
kind: ksops
metadata:
  name: sandbox-runtime-secrets
files:
  - ../../../secrets/shprod/sandbox-runtime-secrets.sops.yaml
```

---

## 快速操作指南

### 修改源代码后发布到北京

```bash
# 1. 修改源代码（如 sandbox/ 目录）
vim sandbox/cmd/main.go

# 2. 提交并推送
git add sandbox/
git commit -m "feature: xxx"
git push origin master

# 3. CI 自动触发
# - .ci/sandbox.yml 检测 on.push.paths 匹配
# - 自动构建镜像、投影、合并、部署
# - 5-10 分钟后完成

# 4. 验证部署
kubectl -n sandbox get deployment sandbox-api
# 看到新镜像已部署
```

### 手动投影到上海

```bash
# 1. 查找要发布的 commit SHA
git log --oneline master | head -10

# 2. 手动触发 CI（设置变量）
# PIPELINE_MODE=promote
# TARGET_ENV=shprod
# SOURCE_SHA=abc1234567

# 3. CI 执行投影、创建 MR

# 4. 运维审批并合并 MR

# 5. Argo 自动同步
```

### 修改环境参数

```bash
# 比如修改上海的 Redis 地址

# 1. 编辑参数文件
vim argocd/services/sandbox/shprod/sandbox-platform.env
# SANDBOX_REDIS_ADDR=10.15.192.115:6379

# 2. 提交
git add argocd/services/sandbox/shprod/sandbox-platform.env
git commit -m "chore: update sandbox redis addr"
git push origin gitops

# 3. Argo 自动同步
# - Kustomize 读到参数变化
# - ConfigMap 更新
# - Deployment Pod 重启（读新环境变量）
```

### 更新 Secret

```bash
# 1. 在本地编辑（需要 sops 和 AGE）
sops argocd/secrets/shprod/sandbox-runtime-secrets.sops.yaml

# 2. 提交
git add argocd/secrets/shprod/sandbox-runtime-secrets.sops.yaml
git commit -m "chore: rotate secret"
git push origin gitops

# 3. Argo 自动同步
# - ksops 解密新 Secret
# - K8s Secret 更新
# - Pod 重启（读新 Secret）
```

---

## 故障排查速查表

| 问题 | 原因 | 解决方案 |
|------|------|--------|
| Argo App OutOfSync | 清单与集群不一致 | git pull gitops; 检查参数文件 |
| Argo App Unhealthy | Pod 启动失败 | kubectl describe pod; 检查镜像存在性 |
| 镜像构建失败 | TCR 认证、网络等 | 检查 TCR_*_PASSWORD 设置 |
| MR 无法合并 | Commit Check 失败 | 查看 MR 中的 check 详情 |
| Secret 解密失败 | AGE 私钥丢失 | 重新运行 bootstrap_argocd_sops_age.sh |
| 北京自动合并不工作 | 轮询超时、MR ID 错误 | 查看 CI 日志中的 gitops_merge_request.py 输出 |

---

## 相关命令速查

### Git 相关

```bash
# 查看当前分支
git branch

# 切换到 gitops 分支
git checkout gitops

# 查看 gitops 最新提交
git log --oneline gitops -10

# 查看 gitops 与 master 的差异
git diff master gitops

# 查看特定文件的历史
git log --oneline argocd/services/sandbox/shprod/sandbox-platform.env

# 查看 promote-* 分支
git branch -a | grep promote
```

### Kustomize 相关

```bash
# 验证 Kustomize 构建
cd argocd/services/sandbox/shprod
kustomize build . --enable-alpha-plugins

# 查看具体参数注入
kustomize build . | grep SANDBOX_API_IMAGE
```

### Argo 相关

```bash
# 查看 Root App 状态（北京）
argocd app get root-beijing-sandbox

# 查看 Leaf App 状态
argocd app get sandbox-beijing-sandbox

# 手动同步
argocd app sync sandbox-beijing-sandbox

# 查看 App 历史
argocd app history sandbox-beijing-sandbox
```

### 其他

```bash
# 测试 SOPS 解密
sops -d argocd/secrets/shprod/sandbox-runtime-secrets.sops.yaml

# 查看 CI 构建日志
# 在 Stream CI 控制台中找到对应流水线查看
```

---

## 关键环境变量和配置

### CI Settings（Stream 平台配置）

```
TCR_BEIJING_PASSWORD       # 北京 TCR 推送密码
TCR_SHPROD_PASSWORD        # 上海 TCR 推送密码
GIT_WOA_PRIVATE_TOKEN      # GitLab API Token（MR 操作）
CLOUDFLARE_API_TOKEN       # Frontend 发布用
CLOUDFLARE_ACCOUNT_ID      # Frontend 发布用
```

### 构建机本地文件（优先级更高）

```
/etc/lightclaw-ci/tcr_beijing_password
/etc/lightclaw-ci/tcr_shprod_password
/etc/lightclaw-ci/git_woa_private_token
```

### 运行时环境变量

```
REPO_ROOT                  # 仓库根路径（自动设置）
REMOTE_URL                 # Git 远程地址（默认 origin）
GITOPS_BRANCH              # 发布分支（默认 gitops）
BUILD_TAG_OVERRIDE         # 镜像标记覆盖
PIPELINE_MODE              # build or promote
TARGET_ENV                 # 目标环境（promote 模式）
SOURCE_SHA                 # 源 commit（promote 模式）
```

---

## 权限和访问控制

### GitLab Group 映射

```
mono-release-groups/
├── mono-beijing-sandbox-release       # 可 sync 北京
├── mono-beijing-sandbox-readonly      # 只读北京
├── mono-shprod-release                # 可 sync 上海
└── mono-shprod-readonly               # 只读上海
```

### Argo AppProject 限制

```
Project: shprod-service-gateway
├── sourceRepos: git@git.woa.com:wisp/mono2.git
├── destinations: lightclaw-gateway@shprod
└── resources: 所有 Group/Kind
```

---

## 常用链接

| 项目 | URL |
|------|-----|
| Git 仓库 | git@git.woa.com:wisp/mono2.git |
| GitLab Web | https://git.woa.com/wisp/mono2 |
| Argo Beijing | http://9.208.245.238:32059 |
| Argo Shanghai | [See README.md] |
| TCR Beijing | lightclaw-bj8.tencentcloudcr.com |
| TCR Shanghai | lightclaw-shprod.tencentcloudcr.com |

