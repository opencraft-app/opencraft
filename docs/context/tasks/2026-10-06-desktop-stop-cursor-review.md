---
id: desktop-stop-cursor-review
type: task
scope: 对照原版Codex分析取消接管后模拟鼠标仍绘制的归属差异。
triggers: ["desktop stop cursor review", "取消接管光标", "Codex control cursor ownership"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/plugins/cloud-desktop/src/rfb.ts", "opencraft/scripts/patch-novnc-desktop-events.mjs", "opencraft/docs/cloud-desktop-plugin.md"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids / requirement_refs / requirement_excerpt
unknown；用户请求核对原版Codex取消接管的鼠标绘制行为。本轮只读分析，不实施新的行为或部署。

## non_goals
不修改源码、参考文件、正式行为契约；不提交/推送/替换预览/重启；不操作真实桌面。媒体像素中是否包含服务器光标不从客户端代码推断。

## history_context / interface_refs / data_structure_refs
current_design_refs：cloud-desktop-plugin Ownership/Composition及desktop-cursor-lifetime Task。
relevant_evolution：上一轮只修active=false的body fallback cursor回收；停止接管但active=true仍有独立路径。当前RFB disableInput设置viewOnly、clearClipboard、focusOnClick=false和blur，不改光标attachment。noVNC Cursor监听与viewOnly独立。
superseded_refs：仅修面板隐藏不能宣称已覆盖控制授权退出。

## context_receipt / scan_scope / evidence
读取根/OpenCraft AGENTS和maintenance Skill、上一轮verification、adjacency及Task模板；本轮重新读cloud-desktop-plugin媒体/focus段和相关源码。Router query cloud desktop stop control cursor Codex 原版取消接管鼠标绘制无匹配；有界搜索current controller/rfb/patch、固定noVNC util/cursor，以及原版两个实际模块，没有扩扫恢复源码。
参考入口：/data/codex-new/codex-26.930.31428-12913/README.md确认原始ASAR extraction（非Wakaru），版本26.930.31428/build12913。原版panel-da547d640131.js直接导入src-51803043763e.js；本轮计算SHA-256，摘要前12位分别655f4b954cd3及42c6b4ec9356（完整值留在命令回执，不在Task正文重复）。
原版panel约byte3266：清理函数调用setKeyEventSource(null)/setMouseEventSource(null)，Stop同步清除控制意图、解绑，再发送OBSERVE release；modechange仅确认control且旧意图仍有效时绑定输入。client约byte15195：setMouseEventSource(null)移除mousemove/mousedown/mouseup/wheel及contextmenu监听；约byte11590：sendData仍按mode CONTROL门禁。video renderer约byte6083持续渲染video/srcObject，两模块无cursor、canvas或createElement实现；此特定面板链路没有单独模拟光标覆盖层，不能泛化成整个Codex应用无Canvas。
当前smoke在observing时显式mouseover后仍断言fallback overlay可见，亦说明上一轮验证的是active生命周期，不是新的控制光标规则。

## decisions / risks / validation / handoff
conclusion：原版继续观看并解绑本地输入，没有本项目的noVNC本地控制光标覆盖层。我们应分别建模媒体/可见性、有效控制授权、本地控制光标；建议绘制资格为active且已确认的有效lease，Stop/取消/撤权/失焦同步退出绘制，等待授权不画。停止控制不能伪装成surface inactive，否则Take焦点与观看手势也被阻断。远端画面内容属于媒体，不按本地grant修改像素。
validation：原始两个模块的真实import、render、Stop、modechange、监听解绑与发送门禁静态确认；没有原版Mac运行或服务器编码光标的实测，不声称停止后视频里的所有光标一定消失。
next_action：用户批准后再修光标的控制授权投影及观察/申请/控制/退出/迟到形状回归；本轮仅保存分析回执。
