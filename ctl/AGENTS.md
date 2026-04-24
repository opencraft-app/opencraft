# CTL Agent Rules

`ctl` 的目标发布模型已经改成：

- source-facing:
  - `ctl/k8s/base/`
  - `ctl/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/ctl/<env>/`（后续纳管时）
  - `argocd/apps/<env>/ctl.yaml`（后续纳管时）

正式发布目标只认 `Argo CD`。  
这轮先删除了 service-local 正式 `apply / release`，并建立 `shprod` skeleton；live deploy-facing wiring 仍待后续纳管。

## 保留能力

- 镜像构建：
  - `python3 scripts/build-release-image.py --service ctl --env <env> --tag <tag>`
- 本地开发配置渲染：
  - `ctl/scripts/render-secrets.sh`

## 构建约束

- `ctl` 必须保持为 **源码构建型镜像**：
  - `ctl/Dockerfile` 在镜像构建阶段直接编译 `main/api`、`main/service`、`main/bypass`
  - 不允许再依赖预编译的 `ctl/bin/*` 作为正式发布输入
- `make build` 只服务于本地运行 / 手工调试：
  - 正式镜像发布不应再因为漏跑 `make build` 而吃到旧二进制

## 约束

- `generated/` 是本地生成物，不提交 Git
- `ctl` 的 DB init / migration 要保留为显式能力，但不放回服务级正式发布脚本
- UTC 时间语义保持不变
