# CloudLadderGateway 手动晋级镜像凭据

## goal

修复 tkexgz 手动 `promote` 在镜像存在性门禁因缺少仓库凭据而失败的问题，并让 Stream 加载修复后的模板。

## non_goals

- 不创建、修改或输出凭据值。
- 不合并 GitOps MR，不同步 Argo，不调整服务路由。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求修复构建 #114 的失败；无外部需求单。
- 构建证据：`p-d1b229bd4a0644cd9ee0078cd5f92dcd` / `b-1503ab6a330746b1b2279467cdb33107`。
- 修复合入后构建 #115 仍使用 V218 的旧步骤定义；用户确认刷新流水线入口并提 MR。

## interface_refs / data_structure_refs

- `.ci/templates/service-release.yml` 的 `PIPELINE_MODE=promote` 手动发布步骤。
- `.ci/cloudladdergateway.yml` 的 `extends.parameters`；保持 `PRINT_RUNNER_DIAGNOSTICS=false`。
- `.ci/init.sh` 的 `ci_set_registry_credentials` 与镜像存在性门禁。
- 凭据仍通过 CI `settings` 注入，不写入源码或日志。

## history_context

- `current_design_refs`: `docs/context/domains/release-gitops.md`、`.ci/AGENTS.md`。
- `relevant_evolution`: 构建与 auto-pin 步骤已有凭据注入，手动晋级步骤遗漏。
- `relevant_evolution`: MR !5216 已合入 master，但构建 #115 仍是 V218，重复在同一凭据门禁失败；共享模板变更没有刷新该流水线实例。
- `superseded_refs`: 无。

## acceptance

- 手动晋级步骤与构建步骤收到相同的镜像仓库凭据变量。
- CloudLadderGateway 入口变化后，Stream 新建构建必须使用新于 V218 的模板快照。
- 对应契约测试、CI runtime 检查通过。
- 重新触发的发布必须另行确认；源码修复本身不代表发布完成。

## affected_paths

- `.ci/templates/service-release.yml`
- `.ci/cloudladdergateway.yml`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`

## required_context

- `release-gitops`、`commerce-trade-ops`、`service-cloudladdergateway`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/release-gitops.md@a527d0c13` | 发布边界 | 区分源码、MR 与实际发布 |
| `docs/context/project/services/trade.md@a527d0c13` | 路由关联 | 限制修复范围 |
| `docs/context/project/services/cloudladdergateway.md@a527d0c13` | 服务关联 | 确认服务边界 |
| `.ci/AGENTS.md@a527d0c13` | CI 操作规则 | 不操作生产凭据 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@a527d0c13` | CI 与 GitOps 邻接 | 核对模板、环境清单及测试 |
| `.ci/templates/service-release.yml@a527d0c13` | 运行契约 | 定位手动晋级缺失的 env |
| `.ci/init.sh@a527d0c13` | 凭据加载 | 确认目标环境使用 CSIGHUB 凭据 |
| `.ci/runtime/gates/image.py@a527d0c13` | 失败门禁 | 确认失败路径 |
| `docs/context/project/services/ci.md@0c4a75d3b` | CI 服务边界 | 区分定义变更与真实发布 |
| `docs/context/domains/agent-gateway-runtime.md@0c4a75d3b` | 代理服务边界 | 不改业务路由 |
| `.ci/README.md@0c4a75d3b` | Stream 模板验收 | 模板变化不触发业务流水线 |
| `.ci/cloudladdergateway.yml@0c4a75d3b` | 服务入口 | 定位可刷新模板的最小变更 |

## evidence

- 构建 #114 第 2 阶段失败，日志报告 `registry credentials for tkexgz are not configured`，并明确未创建 promote MR。
- `build` 和 `auto-pin` 步骤均注入 `CSIGHUB_USERNAME`、`CSIGHUB_PASSWORD`；`promote` 步骤未注入。
- 修复后发布契约测试 107 条通过；CI runtime 单测 663 条通过（4 条跳过），静态检查与 YAML 解析通过。
- 文档校验通过：0 个损坏的一方链接、0 条 warning。
- 构建 #115 检出 MR !5216 的合并提交，却仍使用 V218 且同样缺少 tkexgz 凭据；未创建 GitOps MR。
- CloudLadderGateway 入口刷新变更后，两条聚焦测试通过；CI runtime 663 条测试通过（4 条跳过），Stream YAML 解析和文档校验通过。

## risks

- 共享模板影响所有服务手动晋级；测试核对所有受支持仓库凭据与构建步骤一致。
- 若 CI settings 本身缺失，门禁仍应失败，不能绕过镜像存在性检查。
- 入口刷新是否使 Stream 重建模板实例必须以新构建的流水线版本核验；不能仅凭 MR 合入推断。

## validation

- 运行契约测试与 `.ci/runtime/check_ci_runtime.sh`。
- 重新触发前核对 CI 流水线版本和参数；触发需要用户确认。

## decisions

- 在手动晋级步骤注入现有 CI settings，不改凭据加载器或降低镜像门禁要求。
- 为刷新 Stream 模板实例，仅在 CloudLadderGateway 入口显式设置原本默认的 `PRINT_RUNNER_DIAGNOSTICS=false`，不打开诊断或扩大自动构建路径。

## scan_scope

- `.ci/templates/service-release.yml`、`.ci/cloudladdergateway.yml`、`.ci/init.sh`、`.ci/runtime/gates/image.py` 和相邻契约测试。

## scan_output

- 有界源码检查与构建 #114、#115 的失败摘要；未保存日志原文或凭据。

## handoff

- MR !5216 已合入；入口刷新工作位于独立工作区 `/tmp/mono-clgateway-promote-fix` 的 `codex/refresh-cloudladdergateway-stream-template` 分支。
- 用户已确认入口刷新变更的 commit、push、MR；MR 合并后仍需确认新流水线版本和重触发参数。不会自动合并或同步。

## checkpoint

- `stage`: 服务入口刷新变更验证通过，待提交并创建 MR。
- `verified`: MR !5216 已合入；构建 #115 使用旧 V218 快照并重现凭据失败。
- `unverified`: 入口变更合入后 Stream 是否生成新流水线版本、目标镜像可否成功校验、GitOps MR 是否创建。
- `discard`: 在 V218 上直接重复重试；已连续两次失败。
- `restore`: 从上述独立分支继续，保留原工作区未提交改动；构建 #115 的 ID 为 `b-8075d6e40bd24cc18fca30dafc64c5d8`。
- `next_action`: 提交、推送服务入口刷新变更，并创建到 master 的 MR。
