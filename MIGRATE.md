# GitOps Migration Notes

这份文档沉淀本仓从旧 deploy-only 仓切到新 GitOps 真源时的最小可执行做法。

## 目标

把环境从：

- 旧仓：`https://code.lightclaw.tech/root/mono.git`

迁到：

- 新仓：`https://code.lightclaw.tech/root/mono-source.git`

并保持：

- `path` 不变
- 环境内各服务的 namespace / destination 不变

## 通用步骤

1. 准备新仓
   - 新建 GitLab 仓库。
   - 把源仓完整历史推过去。
   - 如果 `git push` 报 `HTTP 413`，先做仓库历史瘦身，再重试。

2. 瘦身历史
   - 优先清理明确不该入仓的历史垃圾：
     - `.omx/`
     - `.tmp/`
     - `**/node_modules/`
     - 编译产物和本地二进制
   - 可先在镜像副本里验证效果，再决定是否在当前仓做历史重写。
   - 本次实践里，主仓 `.git` 从约 `684M` 缩到约 `77M` 后，推送新仓成功。

3. 给 Argo 加 repo 凭据
   - 先把新仓加入 Argo repositories。
   - 确认 `connectionState.status == Successful`。

4. 处理 AppProject 白名单
   - 子应用切新 repo 前，相关 `AppProject.spec.sourceRepos` 必须先放开新仓。
   - 如果旧 Project 更新困难，先新建专用 Project 过渡。

5. 切 root app / 子 app
   - root app 先切到新仓。
   - 子 app 批量切到新仓，必要时换到新的 Project。
   - 只改：
     - `project`
     - `repoURL`
     - `targetRevision`
   - 不改 `path`。

6. 强校验
   - 每批切换后至少确认：
     - `spec.source.repoURL`
     - `spec.source.targetRevision`
     - `status.sync.status`
     - `status.health.status`
   - 前端还要确认：
     - 公网 `index.html` asset hash
     - live image tag

## 保护分支

新仓首次导入完整历史时，不要直接用：

- `git push --mirror`

到受保护默认分支。

更稳的做法：

1. 临时取消新仓默认分支保护，或允许 force push。
2. 只推需要的分支。
3. 导入完成后再恢复保护规则。

## 北京环境切换实践

### 已验证可行

北京环境以下应用已切到：

- `repoURL: https://code.lightclaw.tech/root/mono-source.git`
- `targetRevision: master`

包括：

- `root-beijing-sandbox`
- `admin-gateway-beijing-sandbox`
- `ai-gateway-beijing-sandbox`
- `ctl-beijing-sandbox`
- `gateway-dashboard-beijing-sandbox`
- `lightclaw-auth-beijing-sandbox`
- `nextgen-dashboard-beijing-sandbox`
- `payment-beijing-sandbox`
- `sandbox-beijing-sandbox`
- `service-gateway-beijing-sandbox`
- `session-beijing-sandbox`
- `subscription-beijing-sandbox`

### 北京环境的关键坑

#### 1. 不能只切 repoURL

切换前必须先 diff：

- 新仓 `mono-source/master`
- 旧仓 `root/mono:main`

重点看：

- `argocd/apps/beijing-sandbox/*.yaml`
- `argocd/root/beijing-sandbox.yaml`
- `argocd/services/*/beijing-sandbox/*`

本次实践里，旧 deploy-only 仓对北京环境其实有多处更老：

- `ai-gateway` image pin 更老
- `ctl` image pin 更老
- `gateway-dashboard` image pin 更老
- `sandbox` 在旧仓甚至不完整

#### 2. sandbox 的 migration job 不能删

北京 `sandbox` overlay 里如果保留：

- `delete-migration-job.yaml`

会导致新 schema 所需表不创建，`sandbox-api` 启动报：

- `sandbox schema missing tables ...; run sandbox migrations first`

#### 3. migrate image replacement 必须单独配

不要让：

- `SANDBOX_MIGRATE_IMAGE`

误替换到：

- `Deployment/sandbox-api`

正确做法：

- `SANDBOX_API_IMAGE` -> `sandbox-api`
- `SANDBOX_WORKER_IMAGE` -> `sandbox-worker` / `sandbox-worker-sharded`
- `SANDBOX_MIGRATE_IMAGE` -> migration Job

#### 4. Job 是 immutable 的

如果旧 migration Job 已经带着错误镜像创建出来，普通 sync 不一定能修复。

更稳的做法：

- 直接换一个新 Job 名称，例如：
  - `sandbox-db-migrate-v3`

让 Argo 创建全新 Job。

#### 5. dirty migration state

本次北京 sandbox 数据库实际卡在：

- `Dirty database version 3`

直接 `migrate up` 会失败。

通过调试 Job 确认后，实际恢复步骤是：

1. `migrate force 4`
2. `migrate up`

这样成功跑通了：

- `000005_vpc_shard_foundation`

#### 6. Debug Job 会拖低 Argo 健康状态

手工创建的调试 Job（如 `sandbox-db-migrate-debug`）如果失败，会继续出现在应用资源树里，把 app 状态拖成 `Degraded`。

排障结束后要及时删除。

## 建议的迁移顺序

1. 新仓可用
2. Argo repo 凭据可用
3. AppProject 白名单放开
4. root app 切换
5. 子 app 批量切换
6. 重点服务人工验收
7. 清理 debug 资源
8. 再考虑删除旧仓对应文件

## 迁移完成后的必要清场步骤

环境切到新仓并不等于迁移结束。必须执行一次“旧链条清场”，否则后续仍然容易误改旧真源。

### 清场前提

只有在下面条件全部满足后，才允许删除旧链条：

1. 该环境所有 live `Application` 都已经指向新仓
2. 所有 live `Application` 都已经达到 `Synced`
3. 所有关键应用都已经达到 `Healthy`
4. 新仓已完成至少一次真实变更收敛
5. 排障期间创建的 debug Job / debug 资源已经清理

### 必做清场动作

#### 1. 删除 Argo 里的旧 AppProject

如果迁移过程中创建了新的过渡 Project（例如：

- `shprod-frontend`
- `beijing-root-mono`
- `beijing-sandbox-mono`

），那么旧 Project 在 live app 全部切走后必须删除，避免继续被误用。

例如北京环境完成切换后，应删除：

- `beijing-root`
- `beijing-sandbox`

保留：

- `beijing-root-mono`
- `beijing-sandbox-mono`

#### 2. 删除旧 deploy-only 仓里的环境文件

旧仓不再是该环境的运行真源后，必须把对应环境的 deploy-facing 文件删除，避免出现“双真源残留”。

例如北京环境切完后，旧仓里应删除：

- `argocd/apps/beijing-sandbox/*`
- `argocd/root/beijing-sandbox.yaml`
- `argocd/projects/beijing-root.yaml`
- `argocd/projects/beijing-sandbox.yaml`
- `argocd/services/*/beijing-sandbox/*`

这一步的目的不是“整理目录”，而是强制切断旧仓对该环境的控制面语义。

#### 3. 回扫 live 引用

清场后必须再次回扫 live app，确认：

- 不再有 app 指向旧仓
- 不再有 app 使用旧 Project
- root app 和子 app 的 repo / revision / path 都一致落在新链条上

### 北京环境经验

北京环境完成切换后，执行了下面这些清场动作：

1. 确认所有 `*-beijing-sandbox` 和 `root-beijing-sandbox` 都切到：
   - `https://code.lightclaw.tech/root/mono-source.git`
   - `master`
2. 删除 Argo 里的旧 Project：
   - `beijing-root`
   - `beijing-sandbox`
3. 删除旧仓 `root/mono:main` 里的北京链条文件

最终结果是：

- 北京环境 live 应用全部只依赖 `mono-source/master`
- 旧 deploy-only 仓不再承载北京环境控制面

### 遵循指南

- 不要在 live app 仍引用旧仓时提前删旧文件
- 不要只删除 app 定义，忘记删除 `root app` / `AppProject`
- 不要保留“以后可能还会用到”的旧环境文件，Git 历史已经足够做审计
- 清场动作必须在迁移 runbook 中视为**必要步骤**，而不是可选优化

## 不要做的事

- 不要一边切仓一边顺手删旧 deploy-facing 文件
- 不要在未确认 schema 状态时盲目 `migrate force`
- 不要把 migrate 镜像和 API/worker 镜像 replacement 混在一起
- 不要在首次导入完整历史时直接对受保护分支 `--mirror`
