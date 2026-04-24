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

## Service Pipelines

当前已接入 service 级 Stream YAML：

- `ai-gateway.yaml.yml`
- `ctl.yaml.yml`
- `frontend.yaml.yml`
- `gateway-dashboard.yaml.yml`
- `lightclaw-auth.yaml.yml`
- `nextgen-dashboard.yaml.yml`
- `payment.yaml.yml`
- `service-gateway.yaml.yml`
- `subscription.yaml.yml`

说明：

- `service-gateway.yaml.yml` 会同时更新：
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
