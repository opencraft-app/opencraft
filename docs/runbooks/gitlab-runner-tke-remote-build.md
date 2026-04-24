# GitLab Runner on TKE for Remote Builds

这份 runbook 定义香港控制面上推荐的远程构建形态：

- GitLab Runner 跑在香港 TKE
- runner 使用 `kubernetes executor`
- 镜像构建使用 `kaniko`
- GitOps pin 由 CI 回写 `argocd/services/<service>/<env>/*-platform.env`
- Argo CD 继续只负责同步，不负责构建

## Why

当前仓库正式发布已经是 GitOps + Argo 模型，但镜像构建仍然常常依赖本地：

- 开发者本地 `docker build && docker push`
- 再手工修改 image pin

这会带来几个问题：

- 构建环境不可复现
- 本地凭据暴露面大
- 多集群 / 多 TCR 容易手工选错目标仓库
- 很难审计

目标链路应当统一为：

```text
push / manual pipeline
  -> runner pod on TKE
  -> kaniko build + push target TCR
  -> CI 回写 GitOps image pin
  -> Argo CD sync
```

## Current Repo Contract

相关文件：

- `.gitlab-ci.yml`
- `.gitlab/ci/gitops-remote-build.yml`
- `scripts/release-bundles.yaml`
- `scripts/resolve_release_bundle.py`
- `scripts/update_image_pin.py`

多环境多 TCR 不是例外，而是主路径。  
镜像仓由 `scripts/release-bundles.yaml` 按 `service + env` 解析，不允许在 CI 里硬编码。

## Variables

### Build Variables

- `BUILD_SERVICE`
- `BUILD_ENV`
- `BUILD_TAG`

构建元数据由 CI 自动解析：

- `BUILD_DOCKERFILE`
- `BUILD_CONTEXT`
- `BUILD_IMAGE_REPO`
- `BUILD_IMAGE`

### Auth Variables

- `DOCKER_AUTH_CONFIG`
  - 推荐设为 protected masked variable
  - 内容是标准 Docker config JSON
  - 需要覆盖目标环境对应的 TCR

- `BOT_GITLAB_TOKEN`
  - 用于回写 GitOps pin
  - 推荐设为 protected masked variable

### Optional Pin Variables

- `PIN_GITOPS_REPO_URL`
  - 默认回写当前项目
- `PIN_GITOPS_BRANCH`
  - 默认回写当前项目默认分支
- `PIN_OPEN_MR`
  - 默认 `1`

建议：

- `beijing-sandbox` 使用 `root/mono-source:master`
- `shprod` 使用 `root/mono-source:master`

## Recommended Runner Layout

推荐在香港集群新建独立 namespace，例如 `gitlab-runner`。

runner 建议：

- executor: `kubernetes`
- replicas / concurrent:
  - 起步 `concurrent = 4`
- 不开启 privileged
- 构建镜像统一走 `kaniko`

推荐标签：

- `hk`
- `tke`
- `kaniko`
- `gitops`

这样后续可以让特定 job 只跑在香港控制面。

## Example Runner Config

以下是示意配置，不包含真实 token：

```toml
concurrent = 4

[[runners]]
  name = "hk-tke-kaniko"
  url = "https://code.lightclaw.tech"
  token = "__REPLACE_ME__"
  executor = "kubernetes"

  [runners.kubernetes]
    namespace = "gitlab-runner"
    image = "alpine:3.20"
    poll_timeout = 600
    cpu_request = "500m"
    memory_request = "512Mi"
    cpu_limit = "2"
    memory_limit = "4Gi"
    service_cpu_request = "100m"
    service_memory_request = "128Mi"
    helper_cpu_request = "100m"
    helper_memory_request = "128Mi"
```

## Runner Installation Notes

可以使用 GitLab 官方 Helm Chart 部署 runner。

至少要准备：

1. 香港集群 kube access
2. runner registration token
3. `gitlab-runner` namespace
4. runner service account / RBAC

如果 job 需要直接访问集群 API，不建议复用 runner pod 的 Kubernetes 权限。  
发布 / 运维相关动作仍然优先通过：

- GitOps 提交
- 独立 kubeconfig / 专用变量

## Pipeline Usage

### 1. Resolve Build Metadata

`gitops-remote-build-prepare`

作用：

- 解析 `service + env + tag`
- 从 `scripts/release-bundles.yaml` 得到：
  - Dockerfile
  - build context
  - image repo
  - full image ref

### 2. Remote Build

`gitops-remote-build`

作用：

- 使用 `kaniko` 构建镜像
- 推送到目标环境自己的 TCR
- 输出 `.tmp/image.digest`

### 3. GitOps Pin

`gitops-image-pin`

作用：

- 修改 `argocd/services/<service>/<env>/*-platform.env`
- 更新：
  - `<PREFIX>_IMAGE`
  - `<PREFIX>_DEPLOYED_AT`
- 提交到目标 GitLab repo

## Environment Mapping

当前环境仓库边界建议如下：

- `beijing-sandbox`
  - build target repo: env 对应北京 TCR
  - pin target repo: `root/mono-source`
  - pin target branch: `master`

- `shprod`
  - build target repo: env 对应上海 TCR
  - pin target repo: `root/mono-source`
  - pin target branch: `master`

如果后续某个环境迁移到 deploy-only repo，只调整 pin repo / branch，不改构建协议。

## Promotion Guidance

不要把 promotion 理解为“直接引用另一个环境的 TCR 镜像”。

正确策略二选一：

1. 在目标环境重新构建
2. 按 digest 复制到目标环境自己的 TCR

然后再更新目标环境的 GitOps pin。

## Known Gaps

当前仓库内已补的是 CI 协议和脚本骨架，不包括：

- 香港 TKE 上 runner 的实际安装
- TCR 凭据注入
- GitLab protected variables / protected environments 创建
- promotion by digest 的独立 job

这些属于平台落地步骤，需要在可访问香港集群与 GitLab 管理面的执行环境里完成。
