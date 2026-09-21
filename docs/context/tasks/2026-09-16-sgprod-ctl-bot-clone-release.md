## goal

将已在 master 修复的 CTL Bot 克隆缺失配置键处理发布到新加坡现网，并分别验证 GitOps、Argo 和运行态。

## non_goals

- 不重做 Bot 克隆实现，不创建或删除用户 Bot，不改用户实例配置。
- 不触发新的构建、数据库迁移或其他地域发布。

## requirement_refs

- 用户在确认新加坡 CTL 克隆失败根因后要求“行，提吧”；本轮沿现有生产 GitOps 候选执行发布。

## interface_refs

- `POST /v1/instances/{instance_id}/bots` 的 `create_mode=clone` 调用 Hermes Profile 创建。
- `argocd/services/ctl/sgprod/ctl-platform.env` 的 `CTL_IMAGE` 是镜像 pin；Argo app `ctl-sgprod` 手动同步。

## history_context

- `current_design_refs`: `docs/engineering/domains/release-gitops.md`、`argocd/services/ctl/sgprod/README.md`。
- `relevant_evolution`: `243afb60d` 为不存在的 `platforms` 或 `gateway.platforms` 键提供幂等清理；`68e543ede` 已把含该修复的 `84d85ec67a32` 构建镜像 pin 到 sgprod GitOps。

## acceptance

- GitOps 候选源码包含 `243afb60d`，Argo 仅投影已审查的 CTL image/deployed-at 差异。
- `ctl-sgprod` 达到预期 revision 且 `Synced / Healthy`，三个 Deployment Ready 且实际运行候选 digest。
- `ctl-api` 二进制包含缺失键处理，公开 Bot 列表只读请求仍成功。

## affected_paths

- `ctl/pkg/instance/bots.go`（已合入的修复，无本轮编辑）。
- `argocd/services/ctl/sgprod/ctl-platform.env`（已有 GitOps pin，无本轮编辑）。

## required_context

- `release-gitops`、`site-environment-routing`、`tapd-gongfeng-delivery`、`control-plane-ops`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/release-gitops.md` | 发布边界 | 区分源码、GitOps 与 Argo 状态 |
| `docs/context/domains/site-environment-routing.md` | 地域边界 | 限定为 sgprod |
| `docs/context/flows/tapd-gongfeng-delivery.md` | 交付门禁 | 不制造重复 MR |
| `docs/context/project/services/ctl.md` | 服务归属 | 核对 CTL 运行态 |
| `.ci/AGENTS.md`、`.ci/ctl.yml` | 构建流程 | 确认无需新构建 |
| `docs/context/project/adjacency/argocd-ci-secrets.md` | 交付邻接 | 核对 CI 与 manifest |
| `argocd/services/ctl/sgprod/README.md`、`argocd/services/ctl/sgprod/kustomization.yaml` | 部署真源 | 确认镜像 pin 消费者 |
| `ctl/AGENTS.md`、`ctl/pkg/instance/bots.go` | 服务实现 | 核对修复语义 |

## evidence

- 故障请求：2026-09-16 17:33:53 +08:00，CTL `POST /v1/instances/ins-a5083ca11a864760a1f3527a4689ad7f/bots` 为 500，trace `79eb476d-a3ac-4ea1-8e1e-c07cf91a495d`；旧二进制无 `Config key not set:` 缺失键处理。用户实例只读检查：`platforms` 存在，`gateway.platforms` 不存在。
- `origin/gitops@ed0980460` 中候选 pin 来自 `68e543ede`，镜像 `sha256:f0e925996a837347afb1240ae05fb3ee1347aa64e7df7ce39de60c4c01a0dffc`，source `84d85ec67a32` 含 `243afb60d`；已有 release gate 均 passed，`auto-sync=false`。
- 同步前 Argo `ctl-sgprod` 为 `OutOfSync / Healthy`；Argo diff 仅 ConfigMap 的 `CTL_IMAGE`、`CTL_DEPLOYED_AT` 和三个 CTL Deployment 的对应 image/redeploy-at。
- 2026-09-16 18:15 +08:00 手动执行 `argocd app sync ctl-sgprod --timeout 180`，Phase `Succeeded`；随后 `argocd app wait ctl-sgprod --sync --health --timeout 180` 返回 `Synced / Healthy`，revision `ed0980460717994bff609fa6fa10f0a4189fbe8d`。
- 三个 CTL Deployment 均为 1/1 Ready，运行候选 digest；`ctl-api` Pod `Running` 且 imageID 为同一 digest。新二进制检出 `Config key not set:` 处理逻辑；公开 Bot 列表 GET 为 200、`OK`、3 个 Bot。

## risks

- 本轮没有再克隆用户 Bot，因此真实克隆成功仍待用户主动验收；只读 GET 和二进制核查不能替代写入场景。
- 若需回滚，旧镜像会重新引入克隆失败；必须另行评估与授权，不自动回滚。

## validation

- `cd ctl && go test ./pkg/instance -run 'TestBuildHermesProfileCreateCommandClonesMainAndSanitizesChannels|TestHermesProfileConfigUnsetOnlyIgnoresMissingKey' -count=1`：通过。
- `argocd app wait ctl-sgprod --sync --health --timeout 180`：通过。
- `kubectl` 运行镜像与 Ready 状态、公开只读 GET：通过。

## decisions

- 已有正确 GitOps pin，故不触发缺 token 的新流水线、不创建重复 MR；只执行已审查差异的生产手动同步。

## scan_scope

- `.ci/ctl.yml`、`argocd/services/ctl/sgprod/`、`ctl/pkg/instance/bots.go`、Argo `ctl-sgprod` 和 `ctl` namespace。

## handoff

- 生产发布已完成并验证运行态；需用户在界面主动重试一次克隆以完成写入路径验收。不得用现有用户 Bot 做自动测试克隆。

## checkpoint

### stage

已完成发布及只读运行态验证；下一道门禁为用户触发真实克隆。

### verified

- GitOps、Argo、镜像 digest、修复字面量和 Bot 列表读取均已验证。

### unverified

- 真实克隆与回滚后果。

### discard

- “需重新构建或另提镜像 MR”的旧假设；已有候选镜像和 GitOps pin。

### restore

- Argo app `ctl-sgprod` revision `ed0980460`、目标 digest `f0e92599…`、修复提交 `243afb60d`。

### next_action

- 等用户在当前 OpenCraft 预览中主动克隆并核对列表；如失败，以新 request ID 查运行日志。
