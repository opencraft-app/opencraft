---
name: deploy-beijing-sandbox
description: Use when deploying or updating services to the Beijing sandbox test environment (tke-bj8). Triggered by "部署测试环境", "发布到北京", "更新测试环境", "deploy beijing sandbox", "推测试环境", or when pushing changes to lightclaw.pages.dev for testing.
---

# Deploy Beijing Sandbox SOP

将 mono2 仓库的变更部署到北京测试环境（tke-bj8 集群）。手动部署路径，绕过 ArgoCD 和 GitOps——**不碰 master、不碰 gitops 分支、不碰生产**。

## 铁律

1. **不合 master**，不推 gitops 分支
2. **不碰上海/新加坡/任何生产环境**
3. **先暂停 ArgoCD**，再手动部署
4. **凭据从 `~/.lightclaw/credentials.env` 读**，不硬编码、不提交
5. **只改北京**（cls-8gnhos9p / tke-bj8）
6. 部署完**必须验证**，不验证不算完成

## 凭据与工具

| 资源 | 值 / 路径 |
|------|----------|
| 凭据文件 | `~/.lightclaw/credentials.env` |
| 本地仓库 | `/Users/shawnmy/code/mono2` |
| sshpass | `/opt/homebrew/bin/sshpass` |
| crane | `/opt/homebrew/bin/crane` |
| DevCloud SSH | `root@9.208.245.238 -p 36000` |
| 远端 kubeconfig | `/etc/lightclaw-ci/kubeconfig_beijing_sandbox` |
| TCR 仓库 | `lightclaw-bj8.tencentcloudcr.com` |
| DB Host | `10.15.224.4:3306` |
| DB Name | `ctl` |
| Redis | `10.15.231.163:6379` |
| 测试前端 | `https://lightclaw.pages.dev/` |

**SSH 调用模板**（所有 DevCloud 远程命令）：

```bash
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 root@9.208.245.238 "<command>"
```

## 部署步骤

### Step 0: 判断要部署什么

```bash
git branch --show-current
git diff --name-only HEAD~1
```

| 改动路径 | 需要部署 | 说明 |
|---------|---------|------|
| `ctl/**` | ctl 镜像 | `ctl/Dockerfile` |
| `workers/**` | workers 镜像 | `workers/Dockerfile` |
| `ctl/migrations/**` | 跑 DB 迁移 | — |
| `argocd/services/service-gateway/**` | service-gateway config | 通常不需要重建镜像 |
| `frontend/**` | 前端 | 走 Cloudflare Pages，用 wrangler |

### Step 1: 暂停 ArgoCD（关键！）

ArgoCD 会对比 gitops 分支自动同步。不停的话你手动 `kubectl set image` 后几分钟就被覆盖。

```bash
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   kubectl --kubeconfig \"\$K\" -n argocd get application -o jsonpath='{range .items[*]}{.metadata.name}{\"\\n\"}{end}' 2>/dev/null; \
   echo apps-listed"
```

对涉及的应用暂停自动同步：

```bash
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   kubectl --kubeconfig \"\$K\" -n argocd patch application <app-name> --type=merge -p '{\"spec\":{\"syncPolicy\":null}}' 2>/dev/null; \
   echo argocd-paused"
```

**不确定要不要停？那就停。**

### Step 2: 本地构建 Docker 镜像

**在本地 Mac 上构建**，不在 DevCloud 上构建。

```bash
cd /Users/shawnmy/code/mono2
BUILD_TAG="<purpose>-$(date +%Y%m%d)"

# 按需构建（只构建有改动的服务）
docker build -t lightclaw-bj8.tencentcloudcr.com/lightclaw/ctl:$BUILD_TAG -f ctl/Dockerfile ctl/
docker build -t lightclaw-bj8.tencentcloudcr.com/lightclaw/workers:$BUILD_TAG -f workers/Dockerfile workers/
```

### Step 3: 用 crane 推送镜像到 TCR

**从本地 Mac 用 crane 推送**，不用 DevCloud 的 docker push。

```bash
source ~/.lightclaw/credentials.env

# 用腾讯云 API 密钥登录 TCR
crane auth login $TCR_REGISTRY \
  -u $TENCENT_SECRET_ID \
  -p $TENCENT_SECRET_KEY

# 推送镜像
crane pushctl() {
  # crane 没有直接 push 本地镜像的方法，用 docker save + crane push
  docker save lightclaw-bj8.tencentcloudcr.com/lightclaw/ctl:$BUILD_TAG | \
    crane push - lightclaw-bj8.tencentcloudcr.com/lightclaw/ctl:$BUILD_TAG
  docker save lightclaw-bj8.tencentcloudcr.com/lightclaw/workers:$BUILD_TAG | \
    crane push - lightclaw-bj8.tencentcloudcr.com/lightclaw/workers:$BUILD_TAG
}

# 或者更简单的方式：docker push（如果已 crane auth login 则 docker push 也能用）
docker push lightclaw-bj8.tencentcloudcr.com/lightclaw/ctl:$BUILD_TAG
docker push lightclaw-bj8.tencentcloudcr.com/lightclaw/workers:$BUILD_TAG
```

**注意**：`crane auth login` 之后再 `docker push` 也能工作，因为 crane 和 docker 共享 `~/.docker/config.json` 的 auth 配置。如果 docker push 报 auth 错误，确认 `crane auth login` 成功后再重试。

### Step 4: 跑 DB 迁移（如有新迁移文件）

```bash
# 在本地看有哪些迁移文件
ls ctl/migrations/0000*.up.sql | sort | tail -5
```

如有新迁移，在 DevCloud 上创建临时 MySQL pod 执行：

```bash
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "set -e; K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   kubectl --kubeconfig \"\$K\" -n ctl delete pod mysql-schema-patch --ignore-not-found 2>/dev/null; \
   kubectl --kubeconfig \"\$K\" -n ctl run mysql-schema-patch --image=mysql:8.0 --restart=Never --command -- sleep 300 2>/dev/null; \
   kubectl --kubeconfig \"\$K\" -n ctl wait --for=condition=Ready pod/mysql-schema-patch --timeout=60s 2>/dev/null; \
   echo mysql-pod-ready"

# 执行迁移 SQL（把 <SQL> 换成实际迁移内容，一次一条）
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   kubectl --kubeconfig \"\$K\" -n ctl exec mysql-schema-patch -- \
   mysql -h 10.15.224.4 -P 3306 -u root -p${DB_PASS} ctl -e \"<SQL>\" 2>&1; \
   echo migration-done"

# 验证迁移
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   kubectl --kubeconfig \"\$K\" -n ctl exec mysql-schema-patch -- \
   mysql -N -h 10.15.224.4 -P 3306 -u root -p${DB_PASS} ctl -e 'DESCRIBE <table>' 2>/dev/null"

# 清理临时 pod（必须！）
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   kubectl --kubeconfig \"\$K\" -n ctl delete pod mysql-schema-patch --ignore-not-found 2>/dev/null; \
   echo mysql-pod-cleaned"
```

**MySQL 8.0 注意**：不支持 `ADD COLUMN IF NOT EXISTS`，用 `ADD COLUMN`，"Duplicate column" 当成功。

### Step 5: 同步配置到 DevCloud（如需更新 env 或 config）

如果需要更新 K8s ConfigMap 或 env（如 service-gateway 配置变更），先把文件传到 DevCloud：

```bash
git archive --format=tar HEAD -- argocd/ ctl/migrations/ | \
  source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  'cd /root/code/mono2 && tar xpf - && echo archive-extracted'
```

### Step 6: 滚动更新

**在 DevCloud 上执行 kubectl 命令**（本地没有 kubeconfig）：

```bash
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o ServerAliveInterval=15 root@9.208.245.238 \
  "set -e; K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   TAG=$BUILD_TAG; \
   kubectl --kubeconfig \"\$K\" -n ctl set image deployment/ctl-api-cloudbase api=lightclaw-bj8.tencentcloudcr.com/lightclaw/ctl:\$TAG; \
   kubectl --kubeconfig \"\$K\" -n temporal-workers set image deployment/website-deployer website-deployer=lightclaw-bj8.tencentcloudcr.com/lightclaw/workers:\$TAG; \
   kubectl --kubeconfig \"\$K\" -n ctl rollout status deployment/ctl-api-cloudbase --timeout=120s; \
   kubectl --kubeconfig \"\$K\" -n temporal-workers rollout status deployment/website-deployer --timeout=120s; \
   echo rollout-complete"
```

如需更新环境变量（如 CLOUDBASE 配置）：

```bash
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   kubectl --kubeconfig \"\$K\" -n ctl set env deployment/ctl-api-cloudbase <KEY>=<VALUE>; \
   kubectl --kubeconfig \"\$K\" -n temporal-workers set env deployment/website-deployer <KEY>=<VALUE>; \
   echo env-updated"
```

**顺序**：先 `set env`（如有），再 `set image`。`set env` 会自动触发滚动重启。

### Step 7: 验证部署

```bash
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   echo 'ctl-api:'; kubectl --kubeconfig \"\$K\" -n ctl get deploy ctl-api-cloudbase -o jsonpath='{.spec.template.spec.containers[0].image} {.status.readyReplicas}/{.status.replicas}'; echo; \
   echo 'worker:'; kubectl --kubeconfig \"\$K\" -n temporal-workers get deploy website-deployer -o jsonpath='{.spec.template.spec.containers[0].image} {.status.readyReplicas}/{.status.replicas}'; echo; \
   echo 'gateway:'; kubectl --kubeconfig \"\$K\" -n lightclaw-gateway get deploy service-gateway -o jsonpath='{.spec.template.spec.containers[0].image} {.status.readyReplicas}/{.status.replicas}'; echo; \
   echo 'pods:'; kubectl --kubeconfig \"\$K\" -n ctl get pods 2>/dev/null | tail -3; \
   kubectl --kubeconfig \"\$K\" -n temporal-workers get pods 2>/dev/null | tail -3; \
   echo verify-done"
```

所有 workload 应显示新镜像 tag 且 `N/N` ready。如有 pod 不 Ready，看日志：

```bash
kubectl --kubeconfig "$K" -n ctl logs <pod-name> --tail=50
kubectl --kubeconfig "$K" -n temporal-workers logs <pod-name> --tail=50
```

### Step 8: 前端部署（如前端有改动）

前端部署到 Cloudflare Pages，用 wrangler：

```bash
cd /Users/shawnmy/code/mono2/frontend

# 构建前端
pnpm install && pnpm build

# 部署到 Cloudflare Pages
source ~/.lightclaw/credentials.env
CLOUDFLARE_API_TOKEN=$(ssh -p 36000 root@9.208.245.238 'cat /etc/lightclaw-ci/cloudflare_api_token' 2>/dev/null) \
  npx wrangler pages deploy dist --project-name=lightclaw
```

**注意**：Cloudflare API Token 在 DevCloud 的 `/etc/lightclaw-ci/cloudflare_api_token`。

### Step 9: 恢复或保持 ArgoCD 暂停

如果 gitops 分支没有你的改动（因为不合 master），恢复 ArgoCD 会覆盖你的手动改动。所以要么：
1. 把改动推到 gitops 分支（但不合 master）
2. 或者不恢复 ArgoCD，等测试完再说

恢复 ArgoCD：

```bash
source ~/.lightclaw/credentials.env && SSHPASS="${DEVCLOUD_PASS}" sshpass -e ssh -p 36000 \
  -o StrictHostKeyChecking=accept-new root@9.208.245.238 \
  "K=/etc/lightclaw-ci/kubeconfig_beijing_sandbox; \
   kubectl --kubeconfig \"\$K\" -n argocd patch application <app-name> --type=merge -p '{\"spec\":{\"syncPolicy\":{\"automated\":{\"prune\":true,\"selfHeal\":true}}}}'; \
   echo argocd-restored"
```

## 完整部署顺序（全量）

1. 暂停 ArgoCD（Step 1）
2. 本地 docker build（Step 2）
3. crane auth login + docker push 到 TCR（Step 3）
4. 跑 DB 迁移（Step 4，如有）
5. 滚动更新 kubectl set image + rollout（Step 6）
6. 更新 env（Step 6 env 部分，如有）
7. 验证（Step 7）
8. 前端部署（Step 8，如有）
9. 恢复或保持 ArgoCD 暂停（Step 9）

## 常见错误和排障

| 问题 | 原因 | 解决 |
|------|------|------|
| 部署后几分钟自动回滚 | ArgoCD 自动同步覆盖 | **先暂停 ArgoCD**（Step 1） |
| docker push 报 auth 错误 | 没登录 TCR | `crane auth login $TCR_REGISTRY -u $TENCENT_SECRET_ID -p $TENCENT_SECRET_KEY` |
| `Permission denied` SSH | 用错机器或没用 sshpass | 只用 `root@9.208.245.238 -p 36000`，用 sshpass |
| Docker build 失败 | go.mod/go.sum 不同步 | 确保本地仓库最新 |
| `ALTER TABLE ADD COLUMN IF NOT EXISTS` 失败 | MySQL 8.0 不支持 | 用 `ADD COLUMN`，"Duplicate column" 当成功 |
| Rollout 卡在旧 pod | Pod 没优雅终止 | `kubectl delete pod <old-pod>` |
| `kubectl: command not found` | 连错机器 | DevCloud 才有 kubectl，本地没有 |
| 删站 500 错误 | 迁移没跑全，缺列 | 检查 `operation_generation`、`attempt` 等列 |
| 前端页面没变化 | Cloudflare 缓存 | 硬刷新 `Cmd+Shift+R` |
| 前端 API 到错环境 | hostname 路由 | `lightclaw.pages.dev` → `https://lightclaw.tech` |

## 禁止事项

- **禁止**合入 master 或推 gitops 分支
- **禁止**用 `mingyuxiao@21.214.48.147` 部署——没有 kubectl
- **禁止**用 CI 节点 `9.135.92.56`——SSH 不通
- **禁止**推 feature 分支触发 CI pipeline
- **禁止**本地 `kubectl apply`——本地没有 kubeconfig
- **禁止**留 `mysql-schema-patch` pod 不删
- **禁止**把凭据写进仓库或 skill 文件
- **禁止**不验证就宣布部署完成
- **禁止**用 DevCloud 做 docker build——在本地 Mac 构建，用 crane 推

## 上次成功部署记录（2026-07-31 / 2026-08-02）

1. 本地 Mac `docker build` ctl 和 workers 镜像
2. `crane auth login` TCR + `docker push` 推送镜像
3. DevCloud 上创建临时 MySQL pod 跑迁移 000028-000038
4. DevCloud 上 `kubectl set image` + `rollout status` 更新 ctl-api-cloudbase 和 website-deployer
5. `wrangler pages deploy` 部署前端到 Cloudflare Pages
6. TAT 注入 Skill 到 Hermes 测试机器
7. 验证：API 200、前端渲染正常、站点可访问
