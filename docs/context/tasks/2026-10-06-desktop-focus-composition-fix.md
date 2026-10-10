---
id: desktop-focus-composition-fix
type: task
scope: 修复桌面接管的迟到焦点与同授权内中文组词目标切换。
triggers: ["desktop focus composition fix", "桌面焦点输入事务修复", "desktop composition handoff"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/plugins/cloud-desktop/src/controller.ts", "opencraft/plugins/cloud-desktop/src/text-input.ts"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids / requirement_refs / requirement_excerpt
unknown；用户批准修复上一轮已复现的两处交互缺陷。

## non_goals
不提交、推送、部署或重启；不操作用户真实桌面，不扩展成手机右键/组合键、几何或健康探测项目；保留已有未提交滚动/触控/键盘实现。

## history_context / interface_refs / data_structure_refs
current_design_refs：cloud-desktop-plugin、design/invariants；诊断见2026-10-06-desktop-interaction-review。
relevant_evolution：HEAD3cefebe3e，上一轮统一手势改造未提交。Codex原始26.930.31428/build12913：Take先聚焦、control/locked后绑定输入。已复现无焦点激活->聊天->迟到授权抢回焦点，以及compositionend在远端点击后导致候选写入新位置。
superseded_refs：只覆盖新旧授权交接的124tests不是同授权下输入事务正确性证据。

## acceptance / validation
Take同步获取当前Panel内焦点但不启用输入；失败或离开不启动/不接受迟到授权，确认不再抢焦点。远端点击/拖动/粘贴前，原文字事务先在原目标结束；不能交接的迟到候选取消，不进入新目标。旧输入DOM不能在同一授权的后继事务复活。焦点交接不得误释放仍有效的接管；候选提交不能重复。
模型、真实Panel与实际noVNC+浏览器IME验证。手机OS与真实后端仍单独验收。

## affected_paths / context_receipt / scan_scope
cloud-desktop controller、Panel、文字/指针/RFB adapter、相关测试/smoke与正式设计。已读根/OpenCraft AGENTS、maintenance Skill及verification、Task模板、已有诊断和专题、design/README及adjacency/frontend-runtime-openspec-i18n；检查邻居plugin/pointer/text/rfb tests与两个真实浏览器smoke。
Router query desktop focus composition review 修复桌面接管与中文输入事务 无匹配；有界精确搜索实际入口及相邻测试，未扩大到全仓参考图谱。

## decisions / risks / checkpoint / handoff
stage：两处已复现缺陷修复完成。控制意图由controller持有，平台仅提供页面可见、窗口聚焦和当前Panel焦点归属的只读判断；后端继续唯一授权。Take同步聚焦但不启用输入，请求和确认都检查焦点资格；迟到确认不会再次聚焦，并释放无效授权。文字adapter持有短命输入DOM与组合事务；在改变远端目标前交接焦点，同步平台确认在旧目标发送，不能同步确认的候选退休。单纯观看捏合、鼠标悬停和双指滚动不改变文字目标。交接期间重入撤销会阻止首个旧指针包；退休DOM不能复活同授权内的新输入事务。

validation：桌面测试129/129通过；插件及Web类型检查、Web release构建、边界检查、git diff --check通过。真实Chromium的当前Panel/Shell在浅色、深色、扩展主题及窄屏通过，证据/tmp/opencraft-desktop-ui-CfQcEv；无焦点按钮激活后转去聊天，迟到授权释放且焦点留在聊天。实际noVNC解码器与浏览器IME的合成对端验证通过，Latin-1证据/tmp/opencraft-desktop-input-7j9kL6，扩展剪贴板证据/tmp/opencraft-desktop-input-vc31Zf。中文“文”的键包down/up先于pointer down/up，旧节点迟到事件被拒绝，同授权新节点仍可正常输入。扩展剪贴板验证早于最终只读页面焦点条件调整，最终Panel测试与Latin-1链路已重验。

verification_limits：合成媒体/授权对端，不是用户真实桌面或真实后端验收。未验证iPhone系统是否同步产生compositionend；策略是同步确认则提交旧目标，否则取消候选，禁止写入新目标。浏览器smoke曾因“文”的期望keysym十进制值写错失败，修正测试值后通过，实际包顺序不变。

formal_design：cloud-desktop-plugin.md、design/invariants.md与agent-gateway-runtime Domain同步记录焦点资格、授权与输入事务的不同生命周期。
documentation_gates：正式文档校验0错误，按全部已修改及未跟踪文件显式集合执行的docs-impact通过。全仓Context校验仍有6273条历史错误，本轮三个desktop Task无错误；未修改无关历史文档。
next_action：无需继续本Task的实现；若用户要求更新预览，再单独执行部署与手机验收。本轮未提交、推送、替换预览或重启。
