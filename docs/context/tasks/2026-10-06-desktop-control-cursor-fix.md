---
id: desktop-control-cursor-fix
type: task
scope: 本地控制光标随确认输入授权退出，观看媒体与面板活动保持独立。
triggers: ["desktop control cursor fix", "接管光标授权修复", "stop controlling cursor"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/scripts/patch-novnc-desktop-events.mjs", "opencraft/plugins/cloud-desktop/src/rfb.ts"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids / requirement_refs / requirement_excerpt
unknown；用户批准实现原版对照后的取消接管光标修复。

## non_goals
不提交、推送、部署、重启；不改后端授权协议，不操作真实远端桌面；不删除画面自身的远端光标像素，不关闭媒体/Host/Chat；保留已有未提交输入与呈现修复，不合并远端分支。

## history_context / interface_refs / data_structure_refs
current_design_refs：cloud-desktop-plugin Ownership/Composition、platform-architecture desktop residency、design/invariants。
relevant_evolution：desktop-stop-cursor-review记录原版26.930.31428/build12913的实际Panel/client；Stop解绑输入、视频保留，未发现单独光标覆盖层。desktop-cursor-lifetime只覆盖active=false；当前viewOnly仍不撤销noVNC cursor attachment。
superseded_refs：observing时mouseover可绘制光标的旧smoke预期不再是目标行为。

## acceptance / validation
观看、申请中、取消/停止/撤权/失焦后，无body模拟光标也无远端cursor URI；原生普通鼠标恢复auto。只有确认授权后才可绘制，迟到形状/旧mouseover不能复活。媒体DOM、连接及本地观看手势保持；重新展开不恢复控制/光标。覆盖触屏与URI分支、初始隐藏连接、迟到授权、反复接管/停止以及关闭。

## context_receipt / scan_scope / affected_paths
已读根/OpenCraft AGENTS、maintenance Skill/verification、Task模板、adjacency/frontend-runtime-openspec-i18n，检查相邻novnc-desktop-events.test及真实rfb fixture/smoke；读取正式桌面专题和design入口、上一轮原版对照Task。Router query cloud desktop control cursor grant 取消接管光标 修复无匹配；有界精确搜索cloud-desktop rfb/controller/patch及固定noVNC cursor实现，未全仓扫参考。
受影响：reviewed noVNC patch、对应tests/smoke/fixture及正式设计。

## decisions / risks / checkpoint / handoff
stage：源码、浏览器回归及构建验证完成；当前服务未替换。
decision：viewOnly已经是媒体适配层对精确有效输入lease的投影；decoder复用该投影与surface active联合决定光标attach/detach，不增加第二份控制布尔值。一个内部同步入口负责connect、viewOnly和active变化，不以Stop冒充隐藏。decode仍保留最新形状；无资格时不向Cursor.change写入，恢复本地auto cursor。
risks：不能以此证明视频内容里远端自身的光标被删除，或代替后端独占输入授权；需要真实浏览器分别验证fallback/URI。
negative_control：原安装的surface-activity版本在真实Panel/noVNC ready观察态即挂载一个body cursor canvas，新增观察态断言失败1!=0；确认旧问题可复现，不靠改expected制造通过。
implementation：reviewed decoder统一在connect、viewOnly及surface-active变化时同步Cursor attachment；无资格立即hide/detach/auto，符合资格才attach/refresh，重复确认保留已挂载对象。渲染队列继续解码最新形状，不在无资格状态下Cursor.change。升级脚本使用带方法上下文的唯一锚点，修复首次验证发现的重复逆向替换歧义；原始哈希、完整代次及幂等校验通过。
verification：test:cloud-desktop 132/132；plugin-cloud-desktop与workbench-web typecheck、check:boundaries、build:web:release及git diff --check通过。Web build ID 20261006064045-2308f6d431b1；只在当前checkout构建，不是运行中服务的版本。
browser_receipt：实际Panel+provider/session-wire+已安装noVNC 1.5，仅peer/authority为合成；legacy和extended clipboard两次通过，产物分别/tmp/opencraft-desktop-input-pkIvCF和/tmp/opencraft-desktop-input-r7MVvZ。覆盖observe、requesting、取消后迟到grant、Stop、revoke、焦点离开、hide/reopen、late shape/mouseover、初始隐藏、三次触屏/URI接管-停止，媒体DOM与观看连接保持；原手势、IME及粘贴回归保留。未发送真实远端输入。
documentation_receipt：正式cloud-desktop-plugin、platform-architecture及design/invariants同步；docs-impact对实际modified/untracked集合通过，documentation validator 0错误。完整context validator有6273条原有历史错误，本Task 0错误；没有顺带修治理基线。
next_action：本轮不替换预览、重启、提交或合并；待用户授权交付后在iPhone实机验证。远端画面本身携带的光标像素不属于本地覆盖层修复范围。maintenance Skill促使光标复用现有输入授权与表面活动投影，保留观看而不增加界面开关或关闭连接。
