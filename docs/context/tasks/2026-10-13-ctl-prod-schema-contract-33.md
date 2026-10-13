## goal
修复 CTL #421 上海 DB 预检把目标版本固定在 32 导致 current=33 被阻断的问题。

## non_goals
- 不修改数据库、生产 GitOps、部署或发布审批；用户后续已确认提交、推送与创建 MR。

## requirement_refs / requirement_excerpt
- 用户提供 #421 Stream 链接及 RunScript 日志，要求“看看怎么修复”。

## interface_refs / data_structure_refs
- `.ci/runtime/bundles/ctl.bundle` 的 expected_migration_version_by_env。
- `gates/db_contract_verifier.py::expected_migration_version` 优先读取环境 override。
- `harness_ci/prod_db_migration.py::decide_migration` 保留 dirty/超前阻断。

## history_context
- current_design_refs: docs/engineering/domains/release-gitops.md。
- relevant_evolution: 357477660c 将两区目标更新到 32；3d2319ed58 新增 migration33 但未更新环境目标。
- 8254f726 已含 migration33，本问题不是源码文件缺失。

## acceptance
- 两区目标均为 33；current=33/clean 跳过，32/clean 要求迁移，34 或 dirty 阻断。
- CI runtime 门禁与 change-impact 检查通过。

## affected_paths
- .ci/runtime/bundles/ctl.bundle
- .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py
- docs/engineering/domains/release-gitops.md

## context_receipt
- 已读根 AGENTS、ctl/AGENTS、.ci/AGENTS、site-environment-routing、ctl/ci 服务 Context、release-gitops Domain、argocd-ci-secrets adjacency、Task 模板与历史 CTL 发布 Task。
- 已检查同服务的 migration33、contract 测试与 ctl/k8s/base/manifests.yaml。
- 外部 lightclaw-website-test-ops Skill 及 remote-credential-access/access-and-credentials/production-readonly 引用用于只读现场核查。

## evidence
- 基线 origin/master=b53371b4538a42944d5a6d187bf812aeb4d8ff69。
- 用户日志 current=33/expected=32/dirty=false；两次上传文件的执行时间与源 SHA 相同，不能据此认定是不同重试记录。
- 两区 ctl-api/ctl-service 当前 digest 均为 3795ff17e66698d9df34702ed248000e5c6dc227ce331fb5e4cd8e33eab2349a。
- 现场 API Pod 无 mysql 客户端、固定 ctl-migrate Job 不存在；未新建生产 Job。新加坡 DB 当前版本未独立确认。

## risks
- sgprod 若落后于 33，下一次正常发布仍会要求审核 pending SQL；源码配置修复不授权生产迁移。
- 旧构建运行旧 checkout；修复合入后需使用包含修复的来源运行新构建。

## validation
- 完整 CI runtime 门禁通过（671 tests，4 skipped）：shell/Python、生产手动 sync、bundle 生成、单测、materialized runtime smoke、YAML 与 diff。
- contract suite 单独运行 107 tests 通过；change-impact 检查通过。
- 完整门禁日志保存于 /data/ctl-prod-schema-contract-33-check-20261013.log。

## decisions
- 维持环境显式版本政策，只把两区目标推进到已存在的 migration33，不移除 override、不放宽 dirty/超前判断。

## handoff
- 隔离工作树已准备源码修复，验证通过。用户已明确确认 commit/push/MR，继续交付修复到 master 的待审 MR；不自动合并或发布。
