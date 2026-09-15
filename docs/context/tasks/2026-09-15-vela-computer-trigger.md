---
id: vela-computer-trigger-20260915
type: task
scope: 修复候选制品流水线因Stream触发配置丢失而误跑无关MR。
triggers:
  - vela-computer trigger
  - Stream quoted on
  - 候选制品误触发
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - .ci/vela-computer.yml
  - .ci/runtime/tests/contract_tests/test_vela_computer_artifact.py
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
让Stream识别候选构建的master/vela-computer路径限制，不默认触发无关MR。
## non_goals
不修改项目级MR监听、安全门禁、制品构建步骤或生产部署。
## requirement_ids / requirement_refs / requirement_excerpt
用户明确要求将带引号on改为普通on，并修正契约测试。
## interface_refs / data_structure_refs
Stream V2 ScriptYmlUtils.formatYamlCustom只把行首on:映射为triggerOn；缺失会默认启用通配触发。
## history_context
current_design_refs：docs/engineering/domains/release-gitops.md。
relevant_evolution：MR4037无vela-computer变更，却触发候选#42；实际原始YAML带引号on。普通PyYAML结构校验未捕获此差异。
superseded_refs：仅按push.paths解释误触发的初步判断。
## acceptance
当前文件经Stream预处理保留push/manual、master、路径限制；带引号回归样例不能生成triggerOn。
## affected_paths
.ci/vela-computer.yml、对应契约测试及正式发布文档。
## required_context
service-ci与最近.ci/AGENTS.md。
## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| docs/context/project/services/ci.md | must_read | CI验证范围 |
| .ci/AGENTS.md | service | 源码与执行权限边界 |
## evidence
测试先在旧文件失败；修改on后3项聚焦测试通过。完整CI运行时门禁538项通过，含materialized runtime smoke、YAML和guards解析。
## risks
PyYAML会把普通on作为YAML1.1布尔值，测试先按Stream预处理再解析，避免为测试改坏生产语法。
## validation
聚焦unittest、check_ci_runtime.sh、文档/变更影响及diff检查；未声称线上触发已更新。
## decisions
仅修改入口拼写，测试覆盖真实预处理边界及旧拼写负例。
## scan_scope
候选流水线、契约测试及Stream V2官方源码；未读取凭据。
## scan_output
无额外扫描产物。
## handoff
隔离分支codex/vela-computer-trigger，未提交推送。
## checkpoint
源码修复完成，3项聚焦测试、538项完整CI运行时测试、文档/变更影响/diff检查通过。未提交推送，线上生效尚未验证。
