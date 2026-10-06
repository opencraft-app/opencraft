---
id: desktop-interaction-git-delivery
type: task
scope: 将已验证桌面观看续期及控制意图整改提交推送并合入最新master，不部署。
triggers: ["desktop interaction git delivery", "桌面整改合入master", "desktop remediation push"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/plugins/cloud-desktop/src/controller.ts", "opencraft/apps/local-agent-host/src/desktop/local-desktop-service.ts"]
status: active
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids / requirement_refs / requirement_excerpt
unknown；用户明确要求“提交 推送 合入master”，仅交付已实现的桌面整改及配套诊断/设计/测试。

## non_goals
不替换或重启在线预览、不推送GitOps或GitHub镜像、不执行真实桌面输入、不提交既有预览替换回执及dirty catalog。

## interface_refs / data_structure_refs / history_context
current_design_refs：cloud-desktop-plugin的确认式观看续期与Panel驻留，platform-architecture、WSP-36、agent-gateway-runtime。
relevant_evolution：desktop-interaction-remediation已完成107项桌面测试、相关70项回归、类型/boundaries/i18n/Web构建及完整真实组件浏览器验证。
superseded_refs：旧五分钟退休、申请期间Cancel；此次Git授权替代此前实现阶段“不提交推送”的边界，不扩展为部署授权。

## acceptance / validation
仅明确目标文件进入commit；feature与远端master都包含源码commit；普通fast-forward push不覆盖远端更新。合并结果保留新语音模型设置与变更卡片，并通过相关测试/类型/构建与界面检查。

## affected_paths / required_context / context_receipt / scan_scope
已修改桌面插件、Host、本机协议、Panel/Web、相关测试、正式文档；新诊断/整改/本交付Task。
已读根/OpenCraft AGENTS、maintenance Skill及verification；router本轮无命中，随后有界核对remediation Task、邻接卡及i18n测试邻居。未读取或打印Git凭据，既有private文件仅供Git credential helper使用。

## decisions / risks
远端master已在7b7afb30c之后增加9个提交，最新6061eb5c1。当前dirty catalog和另一预览回执不属于本轮，保留原状；使用独立merge工作区，不借其他checkout的依赖或产物。
根Context门禁仍有已记录历史问题，不宣称全仓gate通过。Git集成不等于部署。

## checkpoint / evidence / handoff
stage：明确授权与变更范围核对完成，准备提交并合并验证。
verified：HEAD及feature远端均为7b7afb30c；已凭据helper成功fetch，master为6061eb5c1；实现阶段验证见remediation Task。
unverified：新commit/merge与远端回执。
restore：未触碰在线服务；既有未提交记录继续保留。
next_action：提交精确文件集合，在隔离工作区合并最新master并验证。
