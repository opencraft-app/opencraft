---
id: desktop-cursor-lifetime
type: task
scope: 收起云桌面后触屏模拟光标不得残留在聊天页面。
triggers: ["desktop cursor lifetime", "云桌面鼠标残留", "desktop hidden cursor overlay"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/plugins/cloud-desktop/src/viewer.ts", "opencraft/scripts/patch-novnc-desktop-events.mjs"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids / requirement_refs / requirement_excerpt
unknown；用户截图：桌面面板收起后，模拟鼠标仍显示在聊天正文上。修复同一桌面呈现的光标生命周期。

## non_goals
不提交、推送、部署、重启；不终止远端桌面、Chat或后台观看连接；不操作用户真实桌面；保留此前尚未提交的输入策略和焦点/组词修复。

## history_context / interface_refs / data_structure_refs
current_design_refs：cloud-desktop-plugin Ownership/Composition、platform-architecture desktop residency、design/invariants。
relevant_evolution：HEAD 3cefebe3e。while-tab-open保留媒体，active=false撤销输入但DesktopSurface缺少呈现活动接口。固定noVNC1.5.0触屏fallback将fixed/z-index65535光标Canvas挂到document.body，靠mouseover/mouseleave更新显隐；viewOnly/blur不detach光标。光标生命周期长于面板活动状态，符合截图残留路径。
superseded_refs：输入已经撤销不能证明body覆盖光标已撤销。

## acceptance / validation
真实当前Panel+noVNC在touch context移动已绘制光标后，active=false无需mouseleave即可移除覆盖光标；观看连接/媒体DOM保持，隐藏期间晚到cursor shape不能复活；重新展开不抢焦点、不恢复控制，下一次合法移动可显示新光标；关闭/卸载不留下body光标。覆盖隐藏中连接、快速显隐及桌面URI cursor分支，验证相关类型/测试和真实浏览器。

## affected_paths / context_receipt / scan_scope
bounded exact search：cloud-desktop controller/index/rfb/viewer及固定noVNC lib/rfb、lib/util/cursor、相关tests、rfb smoke/fixture。Router query cloud desktop cursor panel hidden 云桌面鼠标收起后残留 无匹配，已记录后只扩到固定依赖的光标入口。
已读根/OpenCraft AGENTS、maintenance Skill/verification、Task模板、adjacency/frontend-runtime-openspec-i18n及相邻novnc-desktop-events.test、design/README、cloud-desktop-plugin Ownership/Composition、platform-architecture桌面专题。相邻fixtures和生成patch一起验证，不手改node_modules真源。

## decisions / risks / checkpoint / handoff
stage：限定修复及验证完成，未替换运行中的预览。
decision：Shell仍只输出active，Controller传给Surface；noVNC reviewed public port拥有其光标attach/detach，不在Shell查找/隐藏全页canvas，不凭DOM尺寸猜生命周期。隐藏保留解码和最新cursor形状，但撤销overlay及监听器；重新展开只恢复观察呈现。
checkpoint：实际当前Panel/noVNC在触屏context回归原实现失败，inactive后body光标count仍1，证明并非只有截图猜测。已补必需Surface.setActive接口和reviewed decoder的cursor attach/detach，隐藏晚到形状不复活。连接首次发生在隐藏状态同样不得attach；重新展开刷新最新形状并等待新pointer事件。代码安装只接受完整已审查代次并校验原始哈希，不直接编辑依赖真源，不查找/隐藏全页Canvas。

test_refinements：重开时真实鼠标仍停在媒体上会主动生成合法mouseover，不能误判为旧光标复活；测试把物理hover停在聊天区域，再发明确的mouseover到媒体并保持收起后无mouseleave。managed adapter会阻止compatibility mousemove抵达decoder，因此positive control须用仍属于cursor的mouseover，并同时断言实际cursor尺寸和computed visibility，而非沿用此前点击残留的visible状态。初始隐藏模型断言排除就绪通知的额外disableInput，两个旧合成Surface更新必需接口。

validation：桌面测试131/131通过；插件/Web类型检查、Web release构建、边界检查通过。实际noVNC+Panel+Vela wire的触屏/桌面URI光标回归通过，证据/tmp/opencraft-desktop-input-cBCyWQ：无mouseleave收起、隐藏形状更新、重新显示最新形状、媒体DOM与连接保留、首次隐藏连接、三次触屏/桌面显隐和关闭/卸载无覆盖层。实际Panel/Shell浅深及扩展主题、320/720和390/1280布局回归通过，证据/tmp/opencraft-desktop-ui-IpNRzz。
verification_limits：真实浏览器和实际decoder，但媒体/后端权威边界是合成对端；不是用户正在运行的预览或iPhone实机验收。未操作真实远端桌面，未提交、推送、部署、重启。
formal_design：cloud-desktop-plugin Ownership/Composition、platform-architecture desktop residency及design/invariants同步区分观看连接、呈现活动、模拟光标与输入授权生命周期。
documentation_gates：正式文档校验0错误；按全部修改及未跟踪文件显式集合执行docs-impact通过；Task触发词按Context schema补齐后再验。全仓原有Context历史错误不属于本次范围。
next_action：若用户要求，再单独接入运行预览并验收手机；本Task无未完成源码项。
