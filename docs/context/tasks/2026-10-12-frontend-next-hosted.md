---
id: frontend-next-hosted-20261012
type: task
scope: 新增使用平台公共构建机的 frontend-next 制品构建流水线。
triggers: ["frontend-next hosted"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - .ci/frontend-next.yml
  - .ci/runtime/commands/build_frontend_next_artifacts.sh
status: active
reviewed_at: 2026-10-12
review_due: 2027-01-12
revision: 1.0.0
precedence: task
derived: true
---

## goal
新增独立 frontend-next 流水线，在平台公共构建机上构建和归档 frontend 静态制品。

## non_goals
不替换原 frontend 流水线，不触发真实构建、不发布站点、不创建资源或改凭据。用户已明确授权本任务提交 MR 并合入 master；真实构建待具体参数确认。

## requirement_refs
用户要求“用平台提供的机器”，并提出“可以新做一个frontend-next流水线”，随后确认“提交 MR 并合入 master”。

## interface_refs / data_structure_refs
Stream YAML v2 jobs.runs-on（self-hosted=false、pool-name=docker）；frontend build:release-artifacts 的四组合矩阵、固定源码SHA、OCI归档/回读验证；settings.TCR_SHPROD_PASSWORD 到 REGISTRY_PASSWORD 的注入。

## history_context
- current_design_refs：docs/engineering/domains/release-gitops.md；.ci/README.md；.ci/frontend.yml。
- relevant_evolution：现 frontend 绑定 cn-pool 自建机，但核心 artifact 构建使用 Node/pnpm/ORAS；Docker/GitOps与站点发布不是本次候选流水线依赖。
- superseded_refs：无。

## acceptance
新增独立手动入口使用公共 Docker 构建池；在当前完整checkout SHA构建嵌入工作台后构建静态artifact；缺少凭据与源码不匹配时在下载前失败；不输出凭据；CI runtime及文档门禁通过。
实际平台资源与网络仍需首次真实构建验收。

## affected_paths
.ci/frontend-next.yml；.ci/runtime/commands/build_frontend_next_artifacts.sh；相应测试、syntax/materialize注册；.ci/docs/README.md；正式发布设计。

## required_context
release-gitops、service-ci、根与.ci AGENTS、devops-pipeline技能。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、.ci/AGENTS.md | 授权和真源边界 | 区分定义、提交与真实构建/发布 |
| docs/context/domains/release-gitops.md | 路由must_read | 制品构建不等于发布 |
| docs/context/project/services/ci.md | 路由must_read | 加载本地runtime验证 |
| .agents/skills/devops-pipeline/SKILL.md | 流水线技能 | 实际启动须展示参数并确认 |
| docs/context/project/adjacency/argocd-ci-secrets.md | 相邻发布责任 | 检查既有artifact测试与GitOps分离 |
| .ci/README.md、.ci/docs/README.md | Stream入口 | job级runs-on及说明位置 |
| frontend/AGENTS.md | 构建门禁 | 保留build:release-artifacts自身检查 |
| docs/context/tasks/TASK-TEMPLATE.md | 状态契约 | 保存本次证据与交接 |

## evidence
首个路由query frontend CI build platform hosted machine instead dedicated build agent无匹配，按.ci/frontend.yml重新路由命中release-gitops/service-ci。
从蓝盾一方上游源码 StreamDispatchUtils.kt 的公共Docker分派分支核对pool-name=docker且self-hosted=false，省略container时使用平台默认镜像。取证通过既有远程桥；本地外网/浏览器查询不可用，未访问蓝盾API，当前环境没有BK_CI_ACCESS_TOKEN。
独立工作树 /data/mono2-frontend-next-hosted-20261012，base 1a75b3205f。

## risks
平台默认镜像的基础命令、glibc、内存及出口尚未真实验收；bootstrap版本与既有流程一致，不依赖自建机路径。凭据未注入直接失败。手动入口独立排队，可删除候选定义回滚；既有同源码制品遵守reuse策略，不声称跨环境内容完全一致。

## validation
12项本次入口与runner约束聚焦测试通过（缺凭据前置失败、SHA绑定、工作台先于frontend、公共手动入口以及旧runner约束）。shell语法、文档、影响、runtime物化smoke检查通过。
完整runtime门禁运行667项测试：与本次无关的网站后端source render测试有4个子断言失败，在干净base工作树复现相同4个失败；不能宣称完整门禁通过。未实际触发平台构建。

## decisions
新增手动候选而不切换已有发布；保留四组合默认矩阵与现有不可变artifact仓库契约。首次可将矩阵缩小到单组合；正式发布仍走现有专用入口。

## scan_scope
.ci/frontend.yml、init.sh、runtime测试与materialize清单；frontend artifact构建/归档脚本。公共上游只读取YAML分派相关文件，commit 67a7662f9cf8aad4af5ad42426df1ad44937e904。

## scan_output
/data/ops/frontend-next-hosted-20261012/upstream-runson.txt；runtime-check.log。

## handoff
实现已完成审阅准备，用户已授权提交 MR 并合入 master。真实平台首次构建需再展示branch/SHA/矩阵与流水线ID；本次不声明平台已跑通。
