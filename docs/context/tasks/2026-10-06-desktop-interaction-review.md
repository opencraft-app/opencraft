---
id: desktop-interaction-review
type: task
scope: 只读复核云桌面交互与固定Codex参考的差距，区分已复现漏洞、已知能力差异与待实机验证。
triggers: ["desktop interaction review", "云桌面交互差距复核", "desktop focus composition review"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/plugins/cloud-desktop/src/controller.ts", "opencraft/plugins/cloud-desktop/src/pointer-input.ts", "opencraft/plugins/cloud-desktop/src/text-input.ts"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids / requirement_refs / requirement_excerpt
unknown；用户要求“再深入看看交互建模的差距”。分析上一轮未提交的输入改造，不实现整改或替换服务。

## non_goals
不改业务源码、参考原文件或正式设计，不提交、推送、部署；不向用户真实桌面发送输入，不宣称Chromium等同iPhone实机或官方Codex运行结果。

## history_context / interface_refs / data_structure_refs
current_design_refs：cloud-desktop-plugin、design/invariants；参考/data/codex-new/codex-26.930.31428-12913原始panel-da547d640131.js与src-51803043763e.js。
relevant_evolution：当前HEAD3cefebe3e，上一轮本地未提交的统一手势/键盘策略已通过124 tests，但其验证未覆盖同授权下的输入目标切换。
superseded_refs：上一轮测试通过只表示限定序列通过，不作为完整交互或手机系统键盘正确性证明。

## acceptance / validation
直接读原始参考及当前调用链；用真实Panel/浏览器与真实文字adapter证伪焦点、组合输入顺序。外部授权/画面边界用合成替身；不得把当前implemented policy直接当expected。

## affected_paths / context_receipt / scan_scope
本轮仅增加此诊断回执。已完整读取根/OpenCraft AGENTS、maintenance Skill与verification、Task模板、design/README、cloud-desktop-plugin相关章节、adjacency/frontend-runtime-openspec-i18n；邻居为实际插件测试、panel/rfb fixtures及smoke。
Router query：opencraft desktop interaction control focus gesture keyboard reference codex input policy，无匹配；随后有界查询cloud-desktop src/tests及固定原始Codex两个模块。不存在的README/测试/gateway入口先由rg --files校正，不扫描整个参考图谱。视觉Viewport精确搜索限定当前Web src的ts/tsx/scss，无相关接口消费命中。

## evidence / checkpoint
1. 固定Codex参考：点击Take先focus(video)，先记录控制意图；control/locked确认后才挂输入监听；panel focusout/window blur释放。当前controller在lease返回后才focus；Panel仅监听自身focusout/window blur/hidden，无独立外部输入意图取消。
2. 真实Chromium390px触控viewport、当前生产CSS、真实Panel/controller、合成持有的grant：普通tap按钮聚焦BUTTON；转焦点到外部INPUT后授权返回，保持observing，release=1。只改变初始激活方式为focusless原生element.click()（控制变量，不是Safari实测）：pending期间焦点BODY；再focus外部INPUT并resolvegrant，最终CANVAS/controlling，release=0。证明没有焦点进入的请求无法仅凭focusout建模离开意图。
3. 真实文字adapter+Chromium CDP Input.imeSetComposition形成“中”候选；按当前touch处理顺序pointerdown阻止默认focus，pointerup先表示远端点击B、再canvas.focus。事件记录：compositionstart/input(insertCompositionText) -> remoteClickB -> compositionend(中) -> blur；实际sendKey得到16797229（Unicode中），此时远端目标标记已B。媒体点击与服务器目标边界为替身；浏览器组合事件、adapter提交与焦点是真实的。当前valid仅检查alive+control lease，没有typing transaction/target切换栅栏。
4. 已知策略：接管后单指移动必为左键拖动，双指平移必为远端scroll；缩放后没有独立本地平移意图或Fit入口。长按/contextmenu被阻止，未提供手机右键及组合键入口。重连重建pointer owner会回到fitView；隐藏Panel驻留保留画面。以上是当前功能选择/缺口，不声称Codex已有对应手机手势。
5. 键盘：CodexGuacamole将Meta映射XK_Meta_L，再平台映射为Control；noVNC DOM Meta先为Super，Mac/iOS分支变Alt。当前只有Cmd/Ctrl+V被插件显式消费，其他快捷键不是同一用户意图策略；尚未Mac/iPhone硬件键盘实测。
6. 手机geometry：仅font-size16/preventScroll/ResizeObserver，不含visualViewport/软键盘遮挡策略；键盘入口只有show，无打开/关闭投影。不能由Chromiumeditable focus推断手机可视区域完整。
7. 恢复：visibilitychange仅隐藏时release；恢复可见无主动探测。wire通过socket close/error或临近过期renew确认失联（5分钟授权前30秒发renew，10秒响应上限），无输入/画面活动探测。没有新帧也可能只是静态桌面，不能用帧静止判断网。Codex该固定模块同样不含完整手机前台探测，不作为其优势声称。

## decisions / risks / handoff
分析完成，无业务代码或当前服务变更。优先修两个证实的交互缺陷，再补设备几何与可用输入；不继续微调旋转。
候选最小模型：控制意图由controller持有；View/平台adapter拥有当前交互焦点，Take同步请求focus但不提前enable输入，离开取消待确认意图；同一grant内再有短命typing/composition事务，远端点击或键盘关闭必须先对原目标提交/取消候选再改变远端目标。观看缩放/平移是View偏好，不冒充控制授权。手机可视区域交给平台/Shell几何源，插件消费；媒体健康探测独立于Chat和输入授权，恢复只回观看。
未验收：iPhone真实焦点规则/软键盘/空文本退格、真实远端应用、Mac快捷键、生产断网与重连。下一步须用户批准整改；已复现序列应进入回归，再进行手机设备验证。
