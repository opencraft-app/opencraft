---
id: desktop-interaction-git-delivery
type: task
scope: 将已验证桌面观看续期及控制意图整改提交推送并合入最新master，不部署。
triggers: ["desktop interaction git delivery", "桌面整改合入master", "desktop remediation push"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/plugins/cloud-desktop/src/controller.ts", "opencraft/apps/local-agent-host/src/desktop/local-desktop-service.ts"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.1.0
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
开始时远端master已在7b7afb30c之后增加9个提交，最新6061eb5c1；验证期间又增加网页标题与产品动态更新至4a8c4019f，均普通合并保留。当前dirty catalog和另一预览回执不属于本轮，保留原状；使用独立merge工作区，执行自己的npm ci，不借其他checkout的依赖或产物。
根Context门禁仍有已记录历史问题，不宣称全仓gate通过。Git集成不等于部署。
新增语音配置测试在与构建/typecheck并行时，固定50轮setImmediate等待请求的断言曾失败；单文件及整组串行复验通过，未修改该测试或语音实现。此结果不宣称该上游用例在任意负载下稳定。

## checkpoint / evidence / handoff
stage：源码提交、推送、合入master及远端验证完成；本回执只补文档，不改变已验证源码。
verified：源码commit为4fab073db391dbf8c88440ff55400d30e3b67124，已推送integrate/opencraft-preview-unified-20261006；合并6061eb5c1为38497be35，再合并4a8c4019f为4b677c23073c0165651e73fa696403b645b03eef。普通push成功，ls-remote确认master与integrate/opencraft-desktop-master-20261006均为4b677c230；merge-base确认源码commit及4a8c4019f均为其祖先。
merged_validation：桌面107项通过；Panel/Shell/workspace/语音/变更卡片相关69项串行通过；5个受影响workspace类型检查、boundaries、i18n、Web release构建通过。后续仅网页标题入口变更，补验3项标题测试、Web类型及release构建通过。documentation validator零错误、零失效一方链接；相对master的change-impact检查通过。
browser_evidence：/tmp/opencraft-desktop-ui-rkzrKx；真实Panel/controller/AppShell/RightPanel与当前完整生产CSS通过三主题、桌面/触屏、隐藏/重开/切tab、停止控制及迟到结果验证。仅媒体/授权边界合成，不代表真实本机输入或生产授权验收。
unverified：在线预览仍是原版本；真实控制、剪贴板及100%复刻Codex不在本轮Git验证结论内。
restore：未触碰在线服务；原工作区dirty catalog与既有预览回执继续保留，不提交。本回执后续普通推送，不强推或改写历史。
next_action：如需上线须另行明确授权，同时更新Host和Web；仅静态前端替换不能交付观看续期能力。
