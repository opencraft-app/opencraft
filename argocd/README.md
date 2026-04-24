# Argo CD Layout

这个目录是 mono 仓库里的 **唯一 deploy-facing 入口**。  
服务源码目录只保留 source-facing 语义；环境级 `AppProject`、root app、子 `Application`、runtime patch 和 `*.sops.yaml`
都在这里收口。

## 先说当前状态

### 北京测试环境

北京已经切到一套新的 Argo CD 控制面，当前 live 链路是：

- Git repo:
  - `git@git.woa.com:wisp/mono2.git`
- root app:
  - `root-beijing-sandbox`
- runtime app:
  - `argocd-runtime-beijing-sandbox`
- projects:
  - `beijing-argocd-runtime`
  - `beijing-root`
  - `beijing-sandbox`
- cluster name:
  - `beijing-sandbox`

这条链路的含义是：

1. `root-beijing-sandbox` 负责扫描 `argocd/apps/beijing-sandbox/`
2. `argocd-runtime-beijing-sandbox` 负责把当前这套 Argo CD 自己的 runtime patch 管起来
3. 北京 leaf apps 全部从 `mono2/gitops` 拉取 deploy-facing 清单
4. 运行时敏感值仍通过 `sops-age` + `ksops` 解密，不把私钥明文放进 Git

### 上海正式环境

上海当前也已经切到这套新的 Argo CD 控制面，当前 live 链路是：

- Git repo:
  - `git@git.woa.com:wisp/mono2.git`
- publish branch:
  - `gitops`
- root app:
  - `root-shprod`
- projects:
  - `shprod-root`
  - `shprod-admin-gateway`
  - `shprod-ai-gateway`
  - `shprod-ctl`
  - `shprod-frontend`
  - `shprod-gateway-dashboard`
  - `shprod-lightclaw-auth`
  - `shprod-payment`
  - `shprod-sandbox`
  - `shprod-service-gateway`
  - `shprod-subscription`
- cluster name:
  - `shprod`

上海当前的特殊点：

- 还没有收敛成单一 `shprod` leaf project
- 当前先沿用按服务拆分的 cutover project 模式
- 旧 Argo 上的 `root-shprod` / shprod leaf apps / shprod projects 已经删除

当前旧 Argo 剩余承载的内容只包括：

- `root-nanjing-test`
- `skillhub-api-nanjing-test`
- `gitlab-argocd-sample`

## 这几个目录分别干什么

- `projects/`
  - 环境级 `AppProject`
- `root/`
  - 环境级 root app
- `apps/<env>/`
  - 该环境下的 leaf `Application`
- `runtime/<env>/`
  - Argo CD 控制面运行时补丁
  - 当前北京这里主要管理 `argocd-cm` 和 `argocd-repo-server`
- `services/<service>/<env>/`
  - deploy-facing 组合层
  - 这里拼 source-facing `k8s/base`、平台参数、`*.sops.yaml`
- `secrets/<env>/`
  - 经过 `sops` 加密的 deploy-facing Secret artifact

## 北京为什么多了 `runtime/`

北京这套新 Argo CD 不是开箱即用就能跑本仓清单。  
本仓的 deploy-facing 服务目录依赖：

- `ksops`
- `sops-age`
- `kustomize --enable-alpha-plugins --enable-exec`

所以北京必须额外管理一层控制面运行时配置：

- `argocd/runtime/beijing-sandbox/argocd-cm.yaml`
  - 打开 `kustomize.buildOptions`
- `argocd/runtime/beijing-sandbox/argocd-repo-server.yaml`
  - 给 `argocd-repo-server` 注入 `ksops`
  - 挂载 `sops-age`
  - 配置 `KUSTOMIZE_PLUGIN_HOME`

这层现在由 `argocd-runtime-beijing-sandbox` 自己同步，避免重装后还要手工 patch repo-server。

## 北京重建 / 接管顺序

如果要在一套新的 Argo CD 上恢复北京环境，顺序固定如下：

1. 准备 repo 凭据
   - `git.woa.com` 的 repo creds
   - `mono2` repository object
2. 注入 `sops-age`
   - 这是 Git 外的唯一必需前置 Secret
   - 用：
     - [bootstrap_argocd_sops_age.sh](../scripts/bootstrap_argocd_sops_age.sh)
3. 注册北京目标集群
   - cluster name 必须叫 `beijing-sandbox`
4. apply 北京 projects
   - `beijing-argocd-runtime`
   - `beijing-root`
   - `beijing-sandbox`
5. apply `root-beijing-sandbox`
6. 等 root app 自动创建：
   - `argocd-runtime-beijing-sandbox`
   - 所有北京 leaf apps
7. 验证：
   - root app `Synced/Healthy`
   - runtime app `Synced/Healthy`
   - 北京 leaf apps 全部 `Synced/Healthy`
   - 上海 leaf apps 全部 `Synced/Healthy`

## `sops-age` 为什么还要 Git 外注入

`sops-age` 里放的是 age 私钥。  
这类私钥不应该明文进 Git，也不应该伪装成普通 deploy-facing 资产。

所以当前约定是：

- Git 管：
  - `argocd/runtime/beijing-sandbox/*`
  - repo-server 如何消费 `sops-age`
- Git 外注入：
  - `argocd` namespace 里的 `sops-age` Secret 本身

标准入口：

```bash
KUBECONFIG_PATH=/path/to/argocd-control-plane.kubeconfig \
  bash scripts/bootstrap_argocd_sops_age.sh
```

## 分支模型

当前 `mono2` 使用：

- `master`
  - 源码 / CI 构建入口
- `gitops`
  - Argo 实际跟踪的发布分支

当前约束：

- CI 只在 `master` 上构建镜像
- deploy-facing image pin 只允许写回 `gitops`
- Argo `Application.spec.source.targetRevision` 统一指向 `gitops`

## 现在改北京时应该改哪里

- 改北京 root / project / app 关系：
  - `argocd/root/beijing-sandbox.yaml`
  - `argocd/projects/beijing-*.yaml`
  - `argocd/apps/beijing-sandbox/*.yaml`
- 改北京服务 deploy-facing 资产：
  - `argocd/services/<service>/beijing-sandbox/`
  - `argocd/secrets/beijing-sandbox/*.sops.yaml`
- 改北京 Argo 控制面运行时：
  - `argocd/runtime/beijing-sandbox/`

不要再做这些事：

- 不要在服务目录里保留“正式 apply 入口”
- 不要把 `.secret/*` 当成 Argo 运行时必须读取的 Git 内容
- 不要手工改 live repo-server 作为长期方案
- 不要再引入 `beijing-root-mono` / `beijing-sandbox-mono` 旧命名

## 关联文档

- [Beijing Sandbox Apps](apps/beijing-sandbox/README.md)
- [Beijing Argo Runtime](runtime/beijing-sandbox/README.md)
- [GitOps Platform Standard](../docs/runbooks/gitops-platform-standard.md)
- [Root Mono Governance](../docs/runbooks/gitops-root-mono-governance.md)
- [GitOps Release Contract](../docs/runbooks/gitops-release-contract.md)
- [GitLab Group Naming Contract](GROUP-NAMING.md)
