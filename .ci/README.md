# Stream CI Layout

当前 `mono2` 采用：

- `master`
  - 源码变更与镜像构建入口
- `gitops`
  - Argo CD 实际跟踪的发布分支

当前分支模型的目标是：

- `master` 上构建镜像
- 北京测试环境自动把 `master@SHA` 的发布子集投影到 `gitops`，创建 MR 并自动合并
- 上海正式环境手动 promote 到 `gitops` 的 MR，并人工合并

当前 `.ci/*.yml` 不再依赖 `ci.event == 'push' / 'manual'` 来分流。
已改为：

- 默认 `PIPELINE_MODE=build`
  - 运行构建
  - 北京自动 promote MR + auto-merge
- 手动把 `PIPELINE_MODE` 改成 `promote`
  - 只执行 `promote-manual`
  - 需要同时提供 `SOURCE_SHA`

## Verified Working Setup

这套模式已经实际验证通过：

- `master`
  - 保留源码和 CI 配置
- `gitops`
  - 作为 Argo CD 的唯一 live 发布分支
- 北京 / 上海当前 live Argo app 都已经盯住 `gitops`
- `master` 上新增 service 级 Stream YAML
- 自动 promote 为北京创建 MR 并自动合并
- 手动 promote 为指定环境创建 MR

当前已经验证成功的关键点：

- `targetRevision` 从 `master` 切到 `gitops` 后，北京/上海 live app 仍然 `Synced / Healthy`
- `env` 自有构建池上的 Linux 机器可以通过 SSH 免密 push `mono2`
- `scripts/pin_image_to_gitops.sh` / `scripts/promote_bundle_image_to_gitops.sh` 能承载 GitOps 发布子集投影和 image pin 写回
- `scripts/gitops_merge_request.py` 负责创建 / 复用 MR，并在北京环境轮询后自动合并
- service 级 YAML 可以继续使用蓝盾 v2.0 的 `jobs.runs-on + steps` 结构

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

### 3. 共享镜像要在 promote 阶段一起 pin

`service-gateway` 和 `admin-gateway` 复用同一镜像。  
这类情况不要复制出两套 build 逻辑，而是在 promote 时一次性投影多个 publish target，并更新多个 pin target。

当前实现方式：

- `service-gateway.yml`
  - 自动 / 手动 promote 时同时投影并更新：
    - `service-gateway`
    - `admin-gateway`
  - `on.push.paths` 同时监听：
    - `service-gateway/**`
    - `admin-gateway/**`

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

因此每条流水线都加了 `debug-context` step，会直接打印：

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
- 调 `scripts/build_and_promote_to_gitops.sh`
- 底层走 `scripts/build-release-image.py --push`
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
- kubectl 自举
- Cloudflare 本地票据读取

当前推荐模式是：

```bash
source .ci/init.sh
ci_init_repo_root
```

再继续：

- `bash scripts/...`
- 或 `cd "$REPO_ROOT/frontend"` 这类子目录操作

如果当前链路还需要前端或集群工具，再补：

```bash
ci_ensure_node
ci_ensure_pnpm
ci_ensure_kubectl
```

不要把这些环境依赖继续散落到每条 YAML 或 Python 脚本里分别维护；优先加到 `.ci/init.sh`，然后由流水线 source 它。

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

## Service Pipelines

当前已接入 service 级 Stream YAML：

- `ai-gateway.yml`
- `ctl.yml`
- `frontend.yml`
- `gateway-dashboard.yml`
- `lightclaw-auth.yml`
- `nextgen-dashboard.yml`
- `payment.yml`
- `service-gateway.yml`
- `subscription.yml`

说明：

- `service-gateway.yml` 会同时更新：
  - `service-gateway`
  - `admin-gateway`
- `lightclaw-auth.yaml.yml` 对应的 build bundle 是：
  - `user-auth`
  - 但 GitOps pin target 是 `lightclaw-auth`

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
  `release-frontend` 会优先读取这两个本地文件，缺失时再回落到 Stream settings

## Shared Scripts

- `scripts/update_image_pin.py`
  - 只更新 `argocd/services/<service>/<env>/*-platform.env`
- `scripts/release_bundle_lib.py`
  - 解析 release bundle 元数据和模式化 `publish_paths`
- `scripts/project_release_bundle.py`
  - 把 bundle 在 `master@SHA` 上的发布子集投影到 `gitops` promote 分支
- `scripts/pin_image_to_gitops.sh`
  - 先把发布子集投影到 promote 分支，再更新镜像 pin，并创建 / 复用进入 `gitops` 的 MR
- `scripts/gitops_merge_request.py`
  - 创建 / 复用 GitOps MR
  - 北京环境等待 commit check 成功后自动合并
- `scripts/gitops_cleanup_source_branch.py`
  - 在 `promote-*` 分支自己的检查流水线结束后轮询 merged MR
  - 北京 auto-merge 成功后再显式删除 `promote-*` 源分支
- `scripts/promote_bundle_image_to_gitops.sh`
  - 按 `bundle service + env + source sha` 解析镜像并 promote 到 `gitops`

## Current Gaps

以下服务还没有接入这一版自动化：

- `sandbox`
  - 仍使用特殊镜像构建链路，不走 `build-release-image.py`
- `session`
  - 当前没有完整的 release bundle 定义
- `frontend-ds`
  - 当前只保留 skeleton，不在 live app 范围内

这几类后续要接入，需要先补：

- 明确的构建入口
- release bundle 元数据
- 对应环境的 image pin 约定
