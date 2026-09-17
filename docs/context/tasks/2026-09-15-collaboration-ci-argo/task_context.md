---
id: collaboration-ci-argo-2026-09-15
type: task
scope: Collaboration 北京镜像构建、数据库门禁与 Argo 候选交付接线。
triggers: ["collaboration ci argo", "collaboration delivery", "collaboration beijing release"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - .ci/collaboration.yml
  - .ci/runtime/bundles/collaboration.bundle
  - argocd/services/collaboration
  - docs/engineering/domains/release-gitops.md
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-15
revision: 0.2.0
precedence: task
derived: false
---

# Collaboration CI / Argo

## goal
接入现有发布契约，完成 Collaboration 北京镜像 CI、bundle、DB gate 与 Argo 候选源码闭环。

## non_goals
- 不发布、审批、更新 live 或 gitops 分支、创建数据库/Secret。
- 不改 OpenAPI/已发布 migration，不开放 Computer、Tasks、Reminders。
- 不改 OpenCraft / vela-computer 交付，不扩散到上海/新加坡/Playground。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前用户：“Collaboration：仍缺 CI/Argo 接线，搞啊”。
- 基础源来自 MR !4012，合入 master 提交 5beee0cf。

## interface_refs / data_structure_refs
- .ci/templates/service-release.yml 与 .ci/runtime/contracts/release_plan.py。
- DB gate 使用 native service-command verifier；迁移/校验只挂 DSN Secret 文件。
- sandbox-family 只扫描 active catalogs；candidates 不生成 Application。

## history_context
- current_design_refs: docs/engineering/domains/release-gitops.md、argocd/README.md。
- relevant_evolution: MR !4012 只带源 Deployment/Service 与一次性 migration 模板，未接 CI/Argo。
- superseded_refs: collaboration/deploy/k8s 历史 Canary，不作为北京部署入口。

## acceptance
- 北京独立 CI/bundle、guard/materialize 注册完整，其他环境不可构建。
- 缺 active catalog/SOPS/平台参数时阻断晋级；基础资源先于迁移/应用。
- native DB Job argv 不含 DSN 值，不启动 shell，不使用别域的 migration table。
- fixture Kustomize 完整替换平台值、只包含一个 Deployment/Service，不含 migration Job。

## affected_paths
- .ci/collaboration.yml、.ci/guards.manifest、.ci/runtime、argocd/services/collaboration。
- argocd/catalogs/candidates/beijing-sandbox、scripts/ssm_manifest.collaboration.beijing-sandbox.yaml。
- collaboration/catalog-info.yaml、collaboration/k8s/README.md、正式 release-gitops 设计。

## required_context
release-gitops、service-ci、site-environment-routing、service-collaboration。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| docs/context/domains/release-gitops.md@2.0.0 | 发布身份 | master/gitops 分离，禁止凭源码宣称发布 |
| docs/context/project/services/ci.md@2.1.0 | CI 入口 | runtime gate 与凭据边界 |
| docs/context/domains/site-environment-routing.md@2.0.0 | 北京范围 | 不扩散其他环境 |
| docs/context/project/services/collaboration.md@1.0.0 | 服务所有权 | slim runtime 与身份互斥 |
| .ci/AGENTS.md | CI 约束 | 不输出或修改凭据 |
| collaboration/AGENTS.md | DB 契约 | 不改已发布迁移/生成物 |
| argocd/README.md、argocd/apps/beijing-sandbox/README.md | AppSet 规则 | 候选先不注册 active app，禁止手写 leaf |
| docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0 | 邻接 | 核对 referral.bundle、北京组合层与 DB runner |
| docs/engineering/domains/release-gitops.md | 正式设计 | 回写 source/build/foundation/migration/runtime 边界 |
| docs/context/project/services/frontend.md@2.1.0、frontend/AGENTS.md | MR !4021 后续 CI 修复 | 保持业务源码不变，仅修复隔离复制 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0 | 前端邻接 | 核对相邻 release contract 测试 |

## evidence
- source branch feat/collaboration-ci-argo 基于 master 5beee0cf，初始 worktree 干净。
- native verifier RED 缺 database_env；migration RED 缺 spec/首发无 SQL；activation RED 未拒绝缺文件。

## risks
- 缺 DB/IM/Secret 不能直接启动 workload；候选隔离 + 必填输入 gate。
- 首次发布最新 diff 不含 migrations；always_run_migration 幂等迁移 + 候选镜像 native verify。

## validation
- CI runtime 全套、目标服务 guard、文档与 docs-impact、Kustomize fixture。
- 目标交付 tests 9 项与 native verifier 25 项通过；完整 CI runtime 520 项与物化 runtime smoke 通过。
- Collaboration guard 已通过 Go test/vet、迁移发布锁、OpenAPI compatibility、TDSQL verify 和 base render。
- 文档 validator 0 errors/0 warnings/0 broken links；Context generator 仍有833条既有全仓错误，本 Pack 无错误。
- Context tests 26项中4项失败；在干净 origin/master 临时 worktree 上复验得到完全相同的4项失败，无新增失败。
- Context audit tests 33项通过；审计发现命令完成，但成熟度评估为 needs_agent_review / not_assessed，不当作完整审核通过。

## decisions
- CI 默认北京-only build，不 auto-pin、不创建生产 promote。
- foundation 与 runtime 描述同一个 Application 的不同 sourcePath，不能同时 active。

## scan_scope
.ci/runtime/contracts、gates、harness_ci、argocd/services/referral 与 collaboration。

## scan_output
测试与摘要见本 Pack 的 evidence，不保存解密材料。

## handoff
源码接线完成，用户已确认继续提交/推送；SSM/DB/IM 真实值和首次发布仍需另行授权。

## checkpoint
- stage: 已获用户确认 commit/push；下一道门禁为 MR 评审。
- verified: 520 CI tests、Collaboration guard、docs-impact、文档校验、Kustomize fixture、限定范围凭证扫描通过。
- unverified: 真正 KSOPS Secret 未导出，逻辑库/账号/DSN 与 IM runtime 值未准备，未做 live 渲染/构建/部署。
- discard: 不用历史 Canary 镜像/IM 参数填补北京配置；不把 candidate 当 active app。
- restore: feat/collaboration-ci-argo；所有修改属于本任务，master/gitops/live 未改变。
- next_action: 提交并推送独立源码分支；后续先交付 foundation，再迁移/校验并激活 runtime。

## MR !4021 后续：前端隔离依赖复制

- 用户授权：“好的，搞起来”，修复并提交到同一 MR；不合并、不部署。
- 受影响路径：frontend/checks/guard.sh、test_release_bundle_contracts.py、正式 release-gitops 设计。
- RED：真实 tar fixture 明确失败于缺少 ../shared/lightvela-agent-core/package.json。
- 实现：补齐共享包源码，排除 node_modules/dist；遍历所有 file: 依赖验证布局和源码。
- GREEN：3项前端guard契约测试通过；完整CI runtime为521项，物化smoke/YAML/shell均通过。
- 实际隔离验证：macOS Node26.7.0/pnpm10.32.1，frozen install成功、类型检查174 current/0 new、i18n通过，前端125项测试与CN/global构建/静态导出/SEO均通过。
- 首次本地调用漏传GUARD_REPO_ROOT导致1项stash测试失败；按changed_guards.py注入仓库根目录后125项全通过，不改源码掩盖调用差异。
- 文档与docs-impact通过；Context26项仍为4个既有失败，audit tests33项通过；audit发现为needs_agent_review/not_assessed，不作为完整审核。
- !4021已合入master 1e20fd3b5；修复改用fix/frontend-guard-local-dependencies后续分支，不能追加到已合MR。下一步commit/push；新MR和Linux CI结果待确认，未合并、未发布。

## 两步可信 guard 自修复

- 用户追加授权：“mr 合入”，并确认两步方案后要求“继续”；仅源码合入，不部署。
- !4022/#5623失败：runner从origin/master提取旧frontend guard，临时目录仍缺共享包，exit254；不绕过可信ref或fallback。
- 第一步!4023：仅3个.CI文件新增修正的可信入口、registry和真实复制测试；522项runtime/smoke通过，远端必要检查与评审通过，已合入master。
- 第二步!4022：frontend入口仅转发到.CI实现，复制回归集中到guard_tests，新增参数/环境/退出码转发测试并将新脚本纳入shell检查。
- 阅读依据沿用CI/frontend/release/site Packs与两个服务AGENTS；邻接argocd-ci-secrets核对mr-placeholder.yml及changed_guards.py。
- RED：转发测试期望新guard退出23，旧独立实现退出1；GREEN为3项guard测试、2项前端契约测试、523项runtime/smoke/shell/YAML、文档校验通过。
- 下一步：推送!4022收敛变更，使用修正后的可信guard，等待必要检查后合入master；不部署。

## MR !4225 live 激活：IM identity key 编码修复

- `gitops@94a1c591` 已把 active catalog 切到 runtime 和候选镜像 `e568ceff…`；live ApplicationSet
  因全局 `applicationsSync=create-only` 不更新既有 child，限定把 Collaboration leaf sourcePath
  对齐到 GitOps desired state 后开始自动同步，不改全局 135 个应用策略。
- Deployment 两个 Pod 均因 `CONFIG_INVALID` 退出：SSM/SOPS 的 `im-identity.key` 为 64 字符 hex，
  runtime 按 Base64 解码为 48 字节，而契约要求恰好 32 字节。live 已回退到 foundation 并恢复
  `Synced/Healthy`；DB、SSM、migration 与 readiness 结果保留。
- 决策：不手工生成或替换 identity material。bootstrap 新建时把 32-byte generator 输出规范化为
  Base64；重入时将已知 64-hex 旧形态无损转换为同一原始 32 字节的 Base64，未知非法形态 fail closed。
- context receipt：读取 `docs/context/project/services/collaboration.md@1.0.0`、
  `docs/context/project/services/infra-pulumi.md@1.0.0`、`infra_pulumi/AGENTS.md`、
  `infra_pulumi/README.md`、`collaboration/AGENTS.md` 与 `collaboration/docs/README.md`。
- RED：新 Secret 的 identity key 解码为 48 bytes；旧 64-hex 不触发 update；非法值被接受。
  GREEN：聚焦测试与 race、完整 `infra_pulumi` test/vet/build、文档校验、docs-impact、diff check
  和限定变更 secret scan 通过。Pulumi preview 完成编译和静态资源规划后因本地缺腾讯云凭据停在
  cluster endpoint 查询；未执行 apply，属于环境阻塞而非本次 bootstrap 行为失败。
- 下一步：完成验证后等待 commit/push/MR 明确授权；源码合入后重跑受控 Runtime bootstrap，
  由 bootstrap 更新 SSM/SOPS，再重新激活 runtime，不直接编辑 Secret。
