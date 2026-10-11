---
id: desktop-input-policy
type: task
scope: 统一桌面观看与远端操作的滚动和触控所有权，检查手机键盘输入边界。
triggers: ["desktop input policy", "桌面触控输入整改", "desktop gesture ownership"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/plugins/cloud-desktop/src/rfb.ts"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids / requirement_refs / requirement_excerpt
unknown；用户确认优先统一滚动与触控输入策略，再验手机键盘。

## non_goals
不提交、推送、替换或重启预览；不操作用户真实桌面，不接TAT或修改授权，不复制Codex私有WebRTC，也不微调加载动画。

## history_context / interface_refs / data_structure_refs
current_design_refs：cloud-desktop-plugin、platform-architecture及design/invariants桌面条目。
relevant_evolution：3cefebe3e已交付观看续期、控制意图及Panel驻留。固定Codex 26.930.31428/build12913原始panel和input client将控制意图与确认分开；wheel限幅及100ms节流，但参考是Mac鼠标入口，不是官方手机手势证明。
superseded_refs：noVNC默认pinch会转成远端Ctrl+滚轮；不把观看缩放与远端页面缩放混用。

## acceptance / validation
观看手势不能发送远端输入；授权确认后单指点击/拖动才操作远端。捏合调整本地观看，不发Ctrl；双指滚动与鼠标wheel消费同一有界策略。取消/停止/失焦清除按键、指针和排队动作，不延迟复活。坐标从实际缩放后画面与留白取得。相关模型、真实decoder及触屏组件浏览器验收；手机系统键盘/IME实测与合成验证分开。

## affected_paths / context_receipt / scan_scope
仅cloud-desktop输入适配器、已固定并审核的noVNC扩展、相关测试/fixture与正式设计。已读根/OpenCraft AGENTS、maintenance Skill及verification、Task模板、design/README、platform-architecture相关入口、桌面专题；邻接frontend-runtime-openspec-i18n及cloud-desktop-rfb/novnc-events测试。Router query无命中，随后有界搜索桌面入口及相邻脚本；不修改参考原文件。

## decisions / risks
领域意图在插件，坐标/事件由Web输入adapter持有，RFB只编码，Host继续权威授权。RFB滚动只能表达离散步数，不能宣称完全复制Codex像素滚动。扩展以固定版本和源码hash验证，禁止运行时访问decoder私有字段。Web浏览器模拟不能证明iPhone系统软键盘。

## checkpoint / evidence / handoff
stage：源码整改与限定环境验证完成；没有提交、推送或部署，本 Task 退役为工作回执，长期权威已写回正式设计。
verified：基于3cefebe3e；本机version.json报20261006-master-3cefebe3e，不改变当前服务。新增统一wheel/双指离散滚动、局部缩放/平移、实际画面坐标转换；一次双指采样合并同帧事件，停止/授权交接取消采样、阻止旧手势在新授权复活；鼠标与触控交接不继承按键。显式手机键盘入口只在实际接管时可用，候选文字不发送，提交转Unicode键对；停止控制销毁原输入节点。

验收：桌面全套124 tests；插件/Web类型检查、i18n与边界检查、Web release构建。真实Chromium 390px触控viewport+当前Panel/CSS+固定noVNC1.5 decoder+合成RFB peer验证观看/接管捏合不写远端、滚轮、单指点击、快速双指滚动、实际editable聚焦、浏览器IME候选不发/提交一次、Enter/Backspace、停止销毁输入与关闭观看；Latin-1及extended clipboard两种配置。后端权威和画面peer均为合成，不是生产授权/真实桌面验收。当前生产CSS组件light/dark/custom、320/720px与实际Shell 390/1280px检查通过。

浏览器回执：`/tmp/opencraft-desktop-input-LBxFV0`（Latin-1）、`/tmp/opencraft-desktop-input-o0OTTM`（extended）含touch-viewport.png和editable-focus.png；`/tmp/opencraft-desktop-ui-6A6Fhv`含Panel/Shell视觉截图。临时回执不属于可复用源码，不保证跨机器保存。
最终鼠标/触控交接补强后再次执行真实decoder smoke通过，回执`/tmp/opencraft-desktop-input-GkDnZz`（Latin-1）。

正式设计：`opencraft/docs/cloud-desktop-plugin.md`、`opencraft/design/invariants.md`、`docs/engineering/domains/agent-gateway-runtime.md`记录观看/输入/授权边界、离散滚动限制与设备验收边界。组合事件依据W3C Input Events；Codex参考仅原始Mac客户端滚轮/控制锁定建模，不宣称其已有本实现的手机手势。

门禁回执：以所有已修改/未跟踪文件显式构成change set执行docs-impact通过（agent-gateway-runtime匹配，Owner review提示保留）；全仓documentation校验0 errors。Context校验当前6273 errors，本次修改的Task/正式设计路径0 errors；不能称Context全仓通过。`git diff --check`通过，发布构建只有原有分包体积/动态导入警告。

unverified：实际iPhone系统键盘（尤其系统中文IME、键盘遮挡/收起、锁屏回来）、真实桌面光标/应用滚动手感；当前预览不含本次未提交修改。Context全仓历史问题与本次变更分开记录，不能据有限验收宣称全仓门禁通过。
next_action：如用户批准替换预览，再用手机检查捏合与双指滚动区分、中文只提交一次、停止控制后键盘关闭且不再发送。对比Chromium回执查设备差异；不继续微调转圈。
