# ctl K8s Layout

`ctl` 的正式发布形态已经统一为 `Kustomize`：

- `ctl/k8s/base/`
  - `ctl` 的基础工作负载清单
  - 包含 `ctl-api` / `ctl-service` / `ctl-bypass`
  - 包含 `ctl-runtime` 的 CLS LogConfig
- `ctl/k8s/overlays/<env>/`
  - 环境 overlay
  - 发布时会在 `generated/` 下生成本地输入文件

标准发布入口：

```bash
cd ctl
ENV=shprod ./scripts/deploy-k8s.sh
```

如果是测试环境日常发版，且改动只涉及 `ctl` 代码或 `ctl/assets/souls/` 静态模板，推荐直接在仓库根目录执行：

```bash
ENV=beijing-sandbox bash ctl/scripts/deploy-k8s.sh release
```

这条命令会：

1. 读取 `deploy/envs/<env>/platform.env`
2. 读取 `.secret/ctl/test.env`
3. 渲染 `ctl/conf/test/*`
4. 在 `ctl/k8s/overlays/<env>/generated/` 下生成 Kustomize 输入
5. 执行 `kubectl apply -k ctl/k8s/overlays/<env>`

`release` 还会顺带构建并推送 `ctl` 镜像，并自动处理测试环境 TCR 登录与 `ctl-base` fallback。

SOUL 模板管理：

- 预设模板源文件放在 `ctl/assets/souls/`
- 发布时通过 overlay 里的 `ctl-soul-templates` ConfigMap 挂载到 Pod 内 `/etc/ctl/souls`
- `GET /v1/soul-templates` 返回当前可用模板的 `id/name/description` 列表，供前端动态拉取
- `POST /v1/instances` 可通过 `soul_template_id` 选择模板，`ctl` 会在创建实例时写入 `~/.openclaw/workspace/SOUL.md`

约束：

- 不再使用 `ctl/k8s/manifests.yaml`
- 不再使用 `ctl/k8s/cls-logconfig.yaml`
- 不再使用 `ctl/scripts/deploy-test.sh`
- `generated/` 目录是本地生成物，不提交 Git
