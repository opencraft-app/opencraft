# CloudLadderGateway 手动晋级镜像凭据

## goal

修复 tkexgz 手动 `promote` 在镜像存在性门禁因缺少仓库凭据而失败的问题。

## non_goals

- 不创建、修改或输出凭据值。
- 不合并 GitOps MR，不同步 Argo，不调整服务路由。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求修复构建 #114 的失败；无外部需求单。
- 构建证据：`p-d1b229bd4a0644cd9ee0078cd5f92dcd` / `b-1503ab6a330746b1b2279467cdb33107`。

## interface_refs / data_structure_refs

- `.ci/templates/service-release.yml` 的 `PIPELINE_MODE=promote` 手动发布步骤。
- `.ci/init.sh` 的 `ci_set_registry_credentials` 与镜像存在性门禁。
- 凭据仍通过 CI `settings` 注入，不写入源码或日志。

## history_context

- `current_design_refs`: `docs/context/domains/release-gitops.md`、`.ci/AGENTS.md`。
- `relevant_evolution`: 构建与 auto-pin 步骤已有凭据注入，手动晋级步骤遗漏。
- `superseded_refs`: 无。

## acceptance

- 手动晋级步骤与构建步骤收到相同的镜像仓库凭据变量。
- 对应契约测试、CI runtime 检查通过。
- 重新触发的发布必须另行确认；源码修复本身不代表发布完成。

## affected_paths

- `.ci/templates/service-release.yml`
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

## evidence

- 构建 #114 第 2 阶段失败，日志报告 `registry credentials for tkexgz are not configured`，并明确未创建 promote MR。
- `build` 和 `auto-pin` 步骤均注入 `CSIGHUB_USERNAME`、`CSIGHUB_PASSWORD`；`promote` 步骤未注入。
- 修复后发布契约测试 107 条通过；CI runtime 单测 663 条通过（4 条跳过），静态检查与 YAML 解析通过。
- 文档校验通过：0 个损坏的一方链接、0 条 warning。

## risks

- 共享模板影响所有服务手动晋级；测试核对所有受支持仓库凭据与构建步骤一致。
- 若 CI settings 本身缺失，门禁仍应失败，不能绕过镜像存在性检查。

## validation

- 运行契约测试与 `.ci/runtime/check_ci_runtime.sh`。
- 重新触发前核对 CI 流水线版本和参数；触发需要用户确认。

## decisions

- 在手动晋级步骤注入现有 CI settings，不改凭据加载器或降低镜像门禁要求。

## scan_scope

- `.ci/templates/service-release.yml`、`.ci/init.sh`、`.ci/runtime/gates/image.py` 和相邻契约测试。

## scan_output

- 有界源码检查与构建 #114 的失败摘要；未保存日志原文或凭据。

## handoff

- 代码已在独立本地工作区 `/tmp/mono-clgateway-promote-fix` 的 `codex/fix-clgateway-manual-promote-credentials` 分支验证。
- 用户已确认 commit、push、MR；修复进入 master 后，重触发需再次核对流水线参数。不会自动合并或同步。

## checkpoint

- `stage`: 本地修复与验证完成，准备提交并创建 MR。
- `verified`: 手动晋级缺少 registry env；107 条契约测试和 CI runtime 全量门禁通过。
- `unverified`: 更新后的流水线是否已被 Stream 加载、目标镜像可否成功校验、GitOps MR 是否创建。
- `discard`: 构建 #114 的重复重试方案；未修复前重试会重现同一失败。
- `restore`: 从上述独立分支继续，保留原工作区未提交改动；构建 #114 的 URL 与失败原因见本文件。
- `next_action`: 提交、推送并创建到 master 的 MR。
