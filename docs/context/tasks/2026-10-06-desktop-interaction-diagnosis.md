---
id: desktop-interaction-diagnosis
type: task
scope: 只读对照本地固定 Codex 参考与 OpenCraft 桌面操作链路，区分呈现差异、安全不变量和待验证缺陷。
triggers: ["desktop interaction diagnosis", "云桌面交互差异分析", "desktop control intent comparison"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/plugins/cloud-desktop/src/controller.ts", "opencraft/apps/local-agent-host/src/desktop/local-desktop-service.ts"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal
解释用户所述云桌面交互与 Codex 差距，给出所有权层面的整改边界。

## non_goals
不修改产品行为、不构建替换、不重启、不提交推送、不操纵真实桌面或用户输入。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；本轮用户“深入再分析”，不是实施授权。

## interface_refs / data_structure_refs
DesktopViewController、DesktopControlLease、DesktopWireSession、HostDesktopBackend、LocalDesktopService；参考固定 Codex 26.930.31428/build 12913 原始 cloud desktop panel 与 input client。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、opencraft/design/README.md。
relevant_evolution：desktop-panel-motion 只承诺加载图形及 compact outline 状态，不等于完整交互复制。
superseded_refs：不执行恢复参考目录，不将其 Mac renderer 当成手机线上事实。

## acceptance / validation
用当前调用链确认差异；隔离合成诊断只替换外部边界，不测试真实输入。检查停止、迟到授权、连接过期、失焦和恢复分类。

## affected_paths / scan_scope
只创建本分析回执；扫描桌面插件、本机 Host 桌面、Workbench 面板及相邻聚焦测试；参考仅原始 panel、input client 和 app-initial 精确注册片段。

## required_context / context_receipt
已全文读取根/OpenCraft AGENTS、maintenance Skill 与 verification、Task 模板、frontend-runtime-openspec-i18n 邻接、design/README；检查相邻 host-desktop-backend 和 session-wire 测试。
Router query opencraft cloud desktop interaction ownership codex panel control focus recovery 没有匹配，随后有界精确检索。首次默认 node 不在 PATH、noVNC core 路径不存在，改用本 checkout 工具链与实际 lib 入口，不借其他工作树依赖。

## evidence / decisions
参考拆分用户控制意图与实际 control/locked；现有 UI 投影申请状态为 Cancel，授权后才呈现 Stop controlling。
现有停止路径先撤销本地输入再释放远端 grant；该安全语义必须保留。失焦释放在两方都存在，不将其误报为 OpenCraft 独有差异。
本机观看 credential 固定五分钟；前后端定时释放，客户端先触发时归类 retired，而恢复仅接受 retryable transport。需隔离验证端到端分支。
本机明确 clipboardAvailable=false；不能声称已有 Codex 剪贴板体验。noVNC pinch 是远端 Ctrl+滚轮，不是本地观看缩放。
右面板只渲染当前 active tab，隐藏后卸载；桌面 View 持有连接，控制生命周期不独立于渲染驻留。参考共享 Shell 的驻留策略须另查，不据 panel 推断全局。

## validation_receipt
本 checkout Node/tsx 运行 cloud-desktop-session-wire、cloud-desktop-plugin、cloud-desktop-rfb、host-desktop-backend 四份聚焦测试：60/60 通过。现有测试没有覆盖正常观看五分钟的组合生命周期。
额外隔离诊断使用真实 HostDesktopBackend、DesktopViewController、session-wire，外部 Host credential 和媒体替身；推进合成时间到 300000ms 后 ready -> failed，wire termination=retired，再推进 10000ms 仍 attachCount=1，无自动恢复。未打开真实桌面、未读取真实授权值或发送输入。该证据验证客户端计时器先结束的路径，不保证实际前后端定时器竞争总以相同顺序发生。
正式 cloud-desktop-plugin 已明确五分钟观看过期；缺失的是续接闭环，而不是偶然票据字段错误。授权撤销和用户关闭不能被归类为网络恢复。
noVNC 原始 wheel 累计阈值生成离散滚轮步骤，pinch 发送 Ctrl+滚轮；Codex 固定原始 client 则裁剪增量并节流 wheel。传输类型不同不意味着等比包含/留白坐标不可能一致。

## risks / handoff
源码与隔离诊断不等于本轮用户设备复现；Codex 是固定 Mac renderer 参考，不是官方手机交互或当前线上版本证明。参考共享 Shell 的所有 tab 驻留策略未完整复核，不声称其一定保活观看。
建议依次整改控制意图投影、观看授权续接、独立输入策略与平台几何；保持服务端确认前禁止输入、停止先断输入、迟到授权释放、重连不自动控制。
只记录本 Task，不改产品、不构建替换、不重启、不提交推送。保留已有预览交付回执及 dirty catalog。

## checkpoint
stage：只读分析和隔离组合诊断完成。
verified：固定参考注册/panel/input client、本机 Host 五分钟观看约束、客户端退休分类、控制清理顺序、剪贴板能力缺失、noVNC 手势语义。
unverified：用户当前设备具体视觉差异、官方 Mac 配对运行、原生输入性能、共享参考 Shell 全部驻留策略。
discard：不把不同传输直接归因为 UI 差距，不把 blur 释放误报为独有缺陷，不将全部断开自动重试或删除授权检查。
restore：没有产品变更；无需切换/回滚在线服务。
next_action：等待用户明确实施授权，按完整输入序列整改并补端到端验收。
failure_receipt：原始参考根 README 路径、猜测的 preview config 路径与旧 Shell scss 路径未命中；停止该扩展检索，不将路径失败包装成运行时故障。
