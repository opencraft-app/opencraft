## goal
准备北京测试环境 CTL 的渠道聊天记录只读接口开关，以便在更新 CTL 镜像后做真实账号验收。

## non_goals
- 不启用 shprod、sgprod 或其他环境，不修改数据读取逻辑。
- 不合并 MR、不执行镜像晋级或 Argo 发布。

## requirement_refs
- 渠道聊天记录首版 PRD：`wiki/prd-docs/2026-10-09-channel-chat-history-console.md`。
- 前置 CTL MR !5147、!5154 已合入 `master`；北京网关 MR !5166 已合入 `gitops`。

## interface_refs
- `ctl/main/api/server.go` 的 `CHANNEL_HISTORY_ENABLED` 默认关闭门禁。
- `argocd/services/ctl/beijing-sandbox/kustomization.yaml` 的 `ctl-api` 环境变量 patch。

## history_context
- current_design_refs：`docs/engineering/domains/agent-gateway-runtime.md`、`docs/engineering/domains/release-gitops.md`。
- relevant_evolution：`origin/gitops` 的北京 CTL 镜像 pin 时间早于 !5147、!5154，单独放行网关路径不能证明接口可用。

## acceptance
- 只在北京 `ctl-api` Deployment 设置 `CHANNEL_HISTORY_ENABLED=true`；其他环境与 CTL 工作负载不受影响。
- 配置通过 YAML 解析、目标与重复项检查、变更影响门禁；CTL 渠道记录聚焦测试通过。
- MR 目标 `master`，合并后仍须由 CTL release 流程将含接口的镜像与配置晋级到 `gitops`，并检查 Argo revision/image、`Synced/Healthy` 及真实账号越权拒绝。

## affected_paths
- `argocd/services/ctl/beijing-sandbox/kustomization.yaml`
- `docs/engineering/domains/release-gitops.md`
- 本 Task Pack。

## required_context
- agent-gateway-runtime、control-plane-ops、site-environment-routing、release-gitops、service-ctl、service-sandbox。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | API 所有权 | 保持 CTL 与网关边界 |
| `docs/context/project/services/ctl.md@2.1.0` | CTL 授权 | 只读接口在 CTL 执行 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 环境边界 | 限定北京测试环境 |
| `docs/context/domains/release-gitops.md@2.0.0` | 发布证据 | 不把 MR 当部署 |
| `docs/context/project/services/sandbox.md@1.0.0` | 测试环境 | 不修改 Sandbox 池 |
| `ctl/AGENTS.md` | CTL 门禁 | 运行聚焦测试 |
| `sandbox/AGENTS.md` | Sandbox 邻接 | 避免变更实例池 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | GitOps 邻接 | 检查 bundle 与配置，不读取 Secret |

## evidence
- !5166 合并提交 `7ea00c934`；`origin/gitops` 北京 Service Gateway 已有两条 GET 白名单。
- 当前 `origin/gitops` 北京 CTL image pin 为 2026-10-09，早于 CTL 前置 MR；运行态尚未验证。
- `master` 与 `gitops` 的北京 CTL 配置除镜像 pin 和时间外无差异。

## risks
- 合并到 `master` 会触发 CTL 构建/北京自动晋级流程；合并前须审核目标 Hermes schema、数据范围和账号授权。开关仅设置在 `ctl-api`，可通过移除此 patch 回滚。
- 内网直连 CTL 依赖身份头信任边界；北京实测须确认网关外无不可信直连，并用两个账号做跨实例拒绝验证。

## validation
- Ruby YAML 解析：`CHANNEL_HISTORY_ENABLED=true` 仅在北京 `ctl-api` patch 出现一次；shprod、sgprod CTL 未增加此开关。
- `CGO_ENABLED=0 go test ./pkg/instance ./main/api -run 'TestReadChannelHistory|TestChannelHistory' -count=1`：通过。
- `CGO_ENABLED=0 go vet ./pkg/instance ./main/api`：通过。
- `validate_documentation.py --repo . --format json`：0 条 broken first-party links。
- `git diff --check`：通过。`.ci/runtime/commands/validate_gitops_static.py` 和 `validate_gitops_kustomize.py` 本机因缺 PyYAML 未启动；YAML 结构由 Ruby 解析，完整 GitOps 发布门禁仍以 CI 为准。

## decisions
- 以独立 master MR 保存北京环境配置源，避免后续 CTL promote 从 master 投影时覆盖直接写入 `gitops` 的开关。

## scan_scope
- `argocd/services/ctl/beijing-sandbox/`、`.ci/ctl.yml`、`.ci/runtime/bundles/ctl.bundle`、`ctl/main/api/server.go`。

## scan_output
- 精确检索确认开关只被 `ctl-api` 路由读取，CTL bundle 包含北京配置，master CI 自动构建并 pin 北京镜像。

## handoff
- 待提交独立 MR；不合并、不部署。需确认 CTL 新镜像、Argo 状态和真实权限验收后再判断可用性。
