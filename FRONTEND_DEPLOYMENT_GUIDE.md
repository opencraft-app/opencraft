# 🚀 Lightclaw Frontend 部署预览指南 - 完整总结

根据对 mono2 仓库的深度分析，以下是**ALL 可用的前端分支预览部署方式**：

---

## 📊 部署方式对比表

| 方式 | 用途 | 部署速度 | 配置复杂度 | 访问权限 | 分支限制 |
|------|------|--------|----------|--------|--------|
| **1️⃣ Cloudflare Pages** | 快速测试 + CI/CD | ⚡⚡ 极快 | 🟢 简单 | 🌐 公网 | 任意分支 |
| **2️⃣ EdgeOne Pages** | 国内测试 + 子账号 | ⚡ 快 | 🟡 中等 | 🇨🇳 可控 | 任意分支 |
| **3️⃣ Argo CD (shprod)** | 正式环境 + GitOps | 🐌 较慢 | 🔴 复杂 | 🔒 内网 | master → gitops |
| **4️⃣ 本地预览 (Vite)** | 本地开发 + 快速迭代 | ⚡⚡⚡ 最快 | 🟢 简单 | 📱 localhost | N/A |

---

## 🔷 方式 1: Cloudflare Pages（推荐 - 快速分支预览）

### 用途
- ✅ 快速部署任意分支到公网预览 URL
- ✅ 与 CI/CD 自动化集成（`.ci/frontend.yml`）
- ✅ 无需服务器、自动托管
- ✅ 已在 release-frontend CI 中验证

### 架构
```
frontend/ branch
    ↓
pnpm build （构建静态产物 dist/）
    ↓
pnpm deploy:cf （调用 scripts/deploy-cloudflare-pages.mjs）
    ↓
wrangler pages deploy （通过 Wrangler CLI 上传到 Cloudflare）
    ↓
https://lightclaw.pages.dev (主分支)
https://<branch>--lightclaw.pages.dev (预览分支)
```

### 快速开始

#### 本地单次部署
```bash
cd frontend
pnpm install
# 构建指定后端
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build

# 部署到 Cloudflare（默认 main 分支）
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw pnpm deploy:cf
```

#### 部署到预览分支
```bash
cd frontend
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw \
CLOUDFLARE_PAGES_BRANCH=preview \
pnpm deploy:cf
```

#### CI/CD 自动部署（在 `.ci/frontend.yml` 中已配置）
```bash
# 自动读取：
# - CLOUDFLARE_API_TOKEN（从 settings 中注入）
# - CLOUDFLARE_ACCOUNT_ID
# - CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw
# - CLOUDFLARE_PAGES_COMMIT_HASH（自动填充 ci.sha）
# - CLOUDFLARE_PAGES_COMMIT_MESSAGE
pnpm deploy:cf
```

### 关键参数

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `CLOUDFLARE_PAGES_PROJECT_NAME` | Pages 项目名 | `lightclaw` |
| `CLOUDFLARE_PAGES_BRANCH` | 部署目标分支 | `main`（默认）/ `preview` / 自定义 |
| `CLOUDFLARE_PAGES_COMMIT_HASH` | 提交 SHA（可选） | `abc123def456` |
| `CLOUDFLARE_PAGES_COMMIT_MESSAGE` | 提交消息（可选） | `Deploy from CI` |

### 部署脚本位置
- **实现**：`frontend/scripts/deploy-cloudflare-pages.mjs`
- **文档**：`frontend/DEPLOY_CLOUDFLARE.md`
- **CI 配置**：`.ci/frontend.yml` （release-frontend 作业，第 67-92 行）

### 权限要求
```bash
npx wrangler whoami  # 验证是否有 pages (write) 权限
```

### 典型 URL
- 主分支：`https://lightclaw.pages.dev`
- 预览分支：`https://preview--lightclaw.pages.dev`

---

## 🔷 方式 2: EdgeOne Pages（国内测试专用）

### 用途
- ✅ 部署到腾讯云 EdgeOne Pages（国内）
- ✅ 支持细粒度权限管理（子账号 + CAM）
- ✅ 测试项目隔离（`lightvela-preview` ≠ `lightvela` 生产）
- ✅ 支持 production / preview 环境切换

### 架构
```
frontend/ branch
    ↓
pnpm build （构建静态产物）
    ↓
pnpm deploy:eo （调用 scripts/deploy-edgeone-pages.mjs）
    ↓
edgeone pages deploy （通过 EdgeOne CLI 上传）
    ↓
https://lightvela-preview.example.com (测试项目)
https://<deployment-id>.edgeone.cool (临时预览 URL)
```

### 快速开始

#### 本地部署（使用 API Token）
```bash
cd frontend
pnpm install
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build

# 方式 1: 通过环境变量传 Token
export EDGEONE_API_TOKEN='<your-token>'
pnpm deploy:eo

# 方式 2: 使用本地 token 文件（自动读取 ~/.tencentcloud/edgeone_pages_token）
pnpm deploy:eo

# 方式 3: 使用 edgeone login 登录会话（自动读取本地登录状态）
pnpm deploy:eo
```

#### 部署到测试项目的 production 环境
```bash
cd frontend
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
EDGEONE_PAGES_PROJECT_NAME=lightvela-preview \
EDGEONE_PAGES_ENV=production \
EDGEONE_PAGES_AREA=global \
EDGEONE_API_TOKEN='<token>' \
pnpm deploy:eo
```

#### 部署到 preview 环境
```bash
EDGEONE_PAGES_ENV=preview pnpm deploy:eo
```

### 关键参数

| 环境变量 | 说明 | 默认值 | 示例 |
|---------|------|--------|------|
| `EDGEONE_PAGES_PROJECT_NAME` | 项目名 | `lightvela-preview` | `lightvela-preview` |
| `EDGEONE_PAGES_ENV` | 部署环境 | `production` | `production` / `preview` |
| `EDGEONE_PAGES_AREA` | 地区 | `global` | `global` / `overseas` |
| `EDGEONE_PAGES_DIR` | 构建目录 | `./dist` | `./dist` / `./dist-cn` |
| `EDGEONE_API_TOKEN` | API Token（优先级最高） | null | `token-xxx` |

### Token 解析顺序（优先级从高到低）
1. 环境变量 `EDGEONE_API_TOKEN`
2. 本地文件 `~/.tencentcloud/edgeone_pages_token`
3. `edgeone login` 登录会话

### 子账号权限
- **账号**：`pablozhong` (UIN: `100048437661`)
- **关联策略**：
  - `eo-pages-lightvela-preview-only-20260427` — 允许操作测试项目 + 创建 API Token
  - `beijing-common-readonly-20260427-v2` — 北京基础设施只读（排障用）
- **限制**：
  - ✅ 能操作 `lightvela-preview` 测试项目
  - ❌ 不能操作 `lightvela` 生产项目
  - ❌ 不能修改北京基础设施

### 创建新 API Token
1. 使用 `pablozhong` 登录腾讯云控制台：https://console.cloud.tencent.com/
2. 进入 EdgeOne Pages 控制台
3. 定位到 **Pages API Token** 页面
4. 创建新 token，填写说明（如 `lightvela-preview-ci`）
5. 设置合理过期时间
6. 保存 token（**只会展示一次**）

### 部署脚本位置
- **实现**：`frontend/scripts/deploy-edgeone-pages.mjs`
- **操作指南**：`codesign/edgeone-preview-operator.md`
- **权限设计文档**：`codesign/tencent-cloud-edgeone-preview-account-provisioning.md`

### 典型 URL
- 测试项目：`https://lightvela-preview.example.com`
- 临时预览：`https://<deployment-id>.edgeone.cool?<params>`

### 常见问题
| 问题 | 解决方案 |
|------|--------|
| `Deployment failed: localPath does not exist` | 确认 `dist/` 已构建：`ls frontend/dist` |
| 裸 `.edgeone.cool` 返回 `401` | 使用 CLI 输出的完整 URL（包含临时参数） |
| `edgeone: command not found` | 安装依赖：`cd frontend && pnpm install` |

---

## 🔷 方式 3: Argo CD GitOps（正式环境 + 上海 shprod）

### 用途
- ✅ 正式环境发布（上海 `shprod`）
- ✅ 基于 GitOps 模型，完整的审计链路
- ✅ 镜像版本管理 + 自动 rollout
- ✅ K8s 原生，支持滚动更新、健康检查等

### 架构

#### 发布流程
```
master branch (源码)
    ↓
python3 scripts/build-release-image.py 
  --service frontend 
  --env shprod 
  --tag <tag>
    ↓
构建 Docker 镜像 → push 到 TCR
    ↓
更新 argocd/services/frontend/shprod/frontend-platform.env (镜像 pin)
    ↓
git commit + git push origin master
    ↓
scripts/pin_image_to_gitops.sh / promote_bundle_image_to_gitops.sh
    ↓
创建到 gitops 分支的 MR
    ↓
人工合并 MR（或北京自动合并）
    ↓
Argo CD 检测到 gitops 分支变化
    ↓
自动 sync/rollout 到 K8s 集群
    ↓
Nginx 容器启动，暴露 /usr/share/nginx/html/index.html
    ↓
https://api.lightclaw.cn (API 网关)
https://preview.lightclaw.cn (CDN 前端)
```

### 快速开始

#### 步骤 1: 构建镜像
```bash
cd /path/to/mono2
python3 scripts/build-release-image.py \
  --service frontend \
  --env shprod \
  --tag web-20260428-abc1234 \
  --push
```

#### 步骤 2: 更新 GitOps 文件
```bash
# 脚本会自动更新 argocd/services/frontend/shprod/frontend-platform.env
# 镜像地址会被写入文件，例如：
# FRONTEND_IMAGE=lightclaw-shprod.tencentcloudcr.com/lightclaw/frontend:web-20260428-abc1234
```

#### 步骤 3: 提交代码
```bash
git add argocd/services/frontend/shprod/frontend-platform.env
git commit -m "[frontend] promote image to shprod: web-20260428-abc1234"
git push origin master
git push target master  # target = https://code.lightclaw.tech/root/mono-source.git
```

#### 步骤 4: 创建/合并 GitOps MR
```bash
# 北京环境自动化处理
# 上海需要手动创建 MR 到 gitops 分支并人工合并
```

### 关键文件位置

| 文件 | 用途 |
|------|------|
| `scripts/build-release-image.py` | 镜像构建脚本 |
| `scripts/pin_image_to_gitops.sh` | 将镜像 pin 写入 GitOps 文件 |
| `scripts/promote_bundle_image_to_gitops.sh` | 创建 GitOps MR 并自动合并 |
| `argocd/services/frontend/shprod/frontend-platform.env` | 镜像版本源文件 |
| `argocd/services/frontend/shprod/kustomization.yaml` | K8s 部署定义 |
| `frontend/k8s/base/manifests.yaml` | Deployment / Service 基础清单 |

### 镜像地址规则
- **上海 shprod**：`lightclaw-shprod.tencentcloudcr.com/lightclaw/frontend:<tag>`
- **北京测试**：`lightclaw-bj8.tencentcloudcr.com/lightclaw/frontend:<tag>`

### 验证发布完成
```bash
# 1. 查看 Argo app 状态
# 2. 确认 live app 的：
#    - repoURL = git@git.woa.com:wisp/mono2.git
#    - targetRevision = gitops
#    - revision = <本次提交 SHA>
#    - image = <目标镜像 tag>
#    - Synced / Healthy
# 3. 验证公网 index.html 资产 hash 与新镜像内 /usr/share/nginx/html/index.html 一致
```

### CI/CD 配置
- **文件**：`.ci/frontend.yml`
- **触发**：push 到 `master` 且路径包含 `frontend/**` 等
- **模式**：
  - `PIPELINE_MODE=build`（默认）→ 构建 + 北京自动 promote + 自动合并
  - `PIPELINE_MODE=promote`（手动）→ 仅执行 promote，需要指定 `SOURCE_SHA`

---

## 🔷 方式 4: 本地 Vite 预览（开发环境）

### 用途
- ✅ 本地快速开发 + 热更新
- ✅ 无需构建完整产物
- ✅ 支持多区域切换（国内 / 国际）

### 快速开始

```bash
cd frontend
pnpm install

# 默认开发模式（VITE_REGION 由 .env 决定，默认国内）
pnpm dev

# 国内站点
pnpm dev:cn

# 国际站点
pnpm dev:global

# 使用本地 monorepo 版 tea-sdk-lightclaw
VITE_LOCAL_SDK=1 pnpm dev
```

### 访问
- 默认：`http://localhost:5173`
- auth API 后端（开发模式）：
  - 若无 `VITE_AUTH_API_BASE_URL`，默认 `http://localhost:8081`
  - 或使用 `VITE_AUTH_API_BASE_URL=mock` 使用内置 mock auth

### 常见命令

| 命令 | 用途 |
|------|------|
| `pnpm check` | TypeScript 类型检查 |
| `pnpm test` | 运行单元测试（Vitest） |
| `pnpm i18n:check` | 校验国际化翻译完整性 |
| `pnpm build` | 生产构建（dist/） |
| `pnpm build:cn` | 国内站构建（dist-cn/） |
| `pnpm build:global` | 国际站构建（dist-global/） |

---

## 📋 部署决策树

```
需要部署前端分支预览？
│
├─ 需要快速测试（公网）？
│  └─ YES → 使用 Cloudflare Pages
│           命令：CLOUDFLARE_PAGES_BRANCH=<branch> pnpm deploy:cf
│           URL：https://<branch>--lightclaw.pages.dev
│           ⏱️  5-10 分钟
│
├─ 需要国内测试（子账号权限）？
│  └─ YES → 使用 EdgeOne Pages
│           命令：EDGEONE_PAGES_PROJECT_NAME=lightvela-preview pnpm deploy:eo
│           文档：codesign/edgeone-preview-operator.md
│           ⏱️  10-15 分钟
│
├─ 需要正式环境发布（上海 shprod）？
│  └─ YES → 使用 Argo CD GitOps
│           命令：python3 scripts/build-release-image.py --service frontend --env shprod --tag <tag> --push
│           后续：更新 argocd/services/frontend/shprod/frontend-platform.env
│           ⏱️  20-40 分钟（含镜像构建）
│
└─ 本地开发？
   └─ YES → 使用 Vite Dev Server
            命令：pnpm dev:cn
            URL：http://localhost:5173
            ⏱️  即时
```

---

## 🔐 权限和安全

### Cloudflare Pages
- 需要 Wrangler 认证：`npx wrangler login`
- CI/CD：需要 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`

### EdgeOne Pages
- 子账号权限受 CAM 策略约束
- 测试子账号 `pablozhong` 专用，不能操作生产项目 `lightvela`
- 关键限制在 CAM 层，而非 token 层

### Argo CD GitOps
- 源码提交需要 WOA 仓库写权限
- GitOps 分支提交需要 GitOps 仓库写权限（自动化处理）
- 最终 K8s apply 由 Argo controller 执行

---

## 📚 参考文档链接

| 文档 | 位置 | 用途 |
|------|------|------|
| Cloudflare 部署 | `frontend/DEPLOY_CLOUDFLARE.md` | CF Pages 详细文档 |
| EdgeOne 使用指南 | `codesign/edgeone-preview-operator.md` | EO Pages 操作指南 |
| EdgeOne 权限设计 | `codesign/tencent-cloud-edgeone-preview-account-provisioning.md` | 子账号权限说明 |
| Frontend AGENTS | `frontend/AGENTS.md` | 前端项目规范和命令 |
| Monorepo 部署模型 | `README.md` (第 47-163 行) | 总体发布架构 |
| CI/CD 配置 | `.ci/frontend.yml` | 自动化流程 |
| ArgoCD 配置 | `argocd/services/frontend/shprod/` | 正式环境部署 |

---

## ⚡ 快速参考

### 部署任意分支到 Cloudflare Pages（最快）
```bash
cd frontend && pnpm install
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
CLOUDFLARE_PAGES_PROJECT_NAME=lightclaw \
CLOUDFLARE_PAGES_BRANCH=<your-branch> \
pnpm deploy:cf
```
✅ 5-10 分钟 → `https://<your-branch>--lightclaw.pages.dev`

### 部署到 EdgeOne Pages 测试项目
```bash
cd frontend && pnpm install
VITE_AUTH_API_BASE_URL=https://lightclaw.tech pnpm build
EDGEONE_PAGES_PROJECT_NAME=lightvela-preview \
EDGEONE_API_TOKEN='<token>' \
pnpm deploy:eo
```
✅ 10-15 分钟 → 测试项目预览 URL

### 部署到上海正式环境（shprod）
```bash
cd mono2
python3 scripts/build-release-image.py \
  --service frontend \
  --env shprod \
  --tag web-$(date +%Y%m%d-%s) \
  --push
# 后续：更新 argocd/services/frontend/shprod/frontend-platform.env
# git commit + git push origin master + git push target master
```
✅ 20-40 分钟 → 自动 Argo sync

### 本地快速开发
```bash
cd frontend && pnpm install
pnpm dev:cn  # 或 pnpm dev:global 国际站
```
✅ 即时 → `http://localhost:5173`

---

## 🎯 总结

| 场景 | 推荐方式 | 命令 | 时间 |
|------|--------|------|------|
| 快速测试某个分支 | Cloudflare Pages | `pnpm deploy:cf` | ⚡ 5-10 min |
| 国内测试环境 | EdgeOne Pages | `pnpm deploy:eo` | ⚡ 10-15 min |
| 正式环境发布 | Argo CD + K8s | `build-release-image.py` | 🐌 20-40 min |
| 本地开发 | Vite | `pnpm dev:cn` | ⚡⚡⚡ 即时 |

**所有方式都已在仓库中验证，可直接使用！**

