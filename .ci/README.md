# Stream CI Layout

当前 `mono2` 采用：

- `master`
  - 源码变更与镜像构建入口
- `gitops`
  - Argo CD 实际跟踪的发布分支

当前分支模型的目标是：

- `master` 上构建镜像
- 北京测试环境自动回写 `gitops`
- 上海正式环境手动 promote 到 `gitops`

当前 `.ci/*.yml` 不再依赖 `ci.event == 'push' / 'manual'` 来分流。
已改为：

- 默认 `PIPELINE_MODE=build`
  - 运行构建
  - 北京自动 promote
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
- 自动 promote 只改北京目录
- 手动 promote 只改指定环境目录

当前已经验证成功的关键点：

- `targetRevision` 从 `master` 切到 `gitops` 后，北京/上海 live app 仍然 `Synced / Healthy`
- `env` 自有构建池上的 Linux 机器可以通过 SSH 免密 push `mono2`
- `scripts/pin_image_to_gitops.sh` / `scripts/promote_bundle_image_to_gitops.sh` 能承载 GitOps pin 写回
- service 级 YAML 可以继续使用蓝盾 v2.0 的 `jobs.runs-on + steps` 结构

## Successful Experience

### 1. 分支职责必须拆开

- `master` 只负责代码和镜像构建
- `gitops` 只负责 deploy-facing image pin
- 不要让 Argo 继续盯 `master`

### 2. Monorepo 下不要用一个大 YAML 自动决定 service

当前仓库是 monorepo。  
如果只有一份流水线 YAML，push 到 `master` 时无法稳定判断到底该构建哪个 service。

已验证更稳的方式是：

- 每个 service 一份 `.ci/*.yml`
- 用 `on.push.paths` 只监听自己的目录和共用脚本

### 3. 共享镜像要在 promote 阶段一起 pin

`service-gateway` 和 `admin-gateway` 复用同一镜像。  
这类情况不要复制出两套 build 逻辑，而是在 promote 时一次性更新多个 pin target。

当前实现方式：

- `service-gateway.yml`
  - 自动 / 手动 promote 时同时更新：
    - `service-gateway`
    - `admin-gateway`

### 4. SSH 写回比 HTTP token 更适合当前环境

当前这套 Stream 运行在自有构建池 `env` 的 Linux 机器上。  
已验证更适合的方式是：

- 使用构建机已有的 SSH 免密推送能力
- 直接 push `git@git.woa.com:wisp/mono2.git`

而不是：

- 再引入额外的 Git HTTP token

### 5. `runs-on` 要放在 job 级

蓝盾 v2.0 文档明确说明：

- 当需要指定构建环境时，应使用 `jobs.<job>.runs-on`

不要假设顶层 `steps` 省略 job 后还能稳定支持所有 `runs-on` 配置。  
当前 service 级 YAML 全部统一为：

- `jobs.release.runs-on.self-hosted: true`
- `jobs.release.runs-on.pool-name: env`
- `PIPELINE_MODE`
  - 默认值 `build`
  - 手动 promote 时改成 `promote`

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

### 7. 不要在 `DockerBuildAndPushImage` 的 `targetTicketId` 里直接引用 `settings.*`

这次已经验证过：

- `targetTicketId: ${{ settings.TCR_BEIJING_SANDBOX_TICKET }}`

会被插件当成原字符串传给凭据接口，而不是先展开。

当前稳定写法是：

- 先在 `variables` 里定义
  - `TCR_BEIJING_TICKET_ID`
  - `TCR_SHPROD_TICKET_ID`
- 由它们的 `value` 去引用 `settings.*`
- `targetTicketId` 再引用 `variables.*`

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

### 镜像推送失败

优先检查：

- `TCR_BEIJING_SANDBOX_TICKET`
- `TCR_SHPROD_TICKET`
- 蓝盾凭据 Key 是否对应正确环境的 TCR 账户

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

- `TCR_BEIJING_SANDBOX_TICKET`
  - 北京镜像推送凭据 Key
- `TCR_SHPROD_TICKET`
  - 上海镜像推送凭据 Key

另外要求：

- 自有构建池 `env` 上的机器必须已经具备对 `git@git.woa.com:wisp/mono2.git` 的 SSH 免密推送能力
- 构建机上的 git committer 身份必须与该 SSH 票据对应的工蜂账号匹配

## Shared Scripts

- `scripts/update_image_pin.py`
  - 只更新 `argocd/services/<service>/<env>/*-platform.env`
- `scripts/pin_image_to_gitops.sh`
  - 把指定镜像 pin 到 `gitops` 分支
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
