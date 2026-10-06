---
id: desktop-panel-motion
type: task
scope: 对齐固定 Codex 参考的桌面加载图标与紧凑按钮反馈，不改控制权和在线预览。
triggers: ["desktop panel motion", "桌面加载动效", "紧凑按钮反馈"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/packages/design-system-web/src/progress.tsx", "opencraft/packages/design-system/src/panel-controls.web.scss", "opencraft/scripts/smoke-desktop-panel-ui.ts"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
用户“开搞”授权实现上轮提出的桌面面板视觉/动效对齐。

## non_goals
不重启或替换预览，不提交推送，不改后端、授权、媒体、控制激活或 OS 桌面；不引入参考中没有的淡入缩放。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；用户希望 UI 动效接近本地 Codex 参考，保持上一轮停止控制修复。

## interface_refs / data_structure_refs
纯 Design System progress 拥有矢量数据；design-system-web/progress 拥有 SVG DOM 与 Document timeline 相位，CSS adapter 拥有 motion preference；compact-action 拥有即时主题状态；DesktopPanel 仅投影连接状态。

## history_context
current_design_refs：cloud-desktop-plugin Panel presentation、design/invariants 的共享控件与触控所有权。
relevant_evolution：desktop-control-activation 与 desktop-action-web-preview 已实现并接入预览；新 motion 不改变该命令模型。
superseded_refs：800ms 缺口 CSS 圆环不是参考 Spinner；类名相似与功能验收不是逐帧像素证明。

## acceptance / validation
参考版本为 Codex 26.930.31428/build 12913；原始 panel 的 FE=cli、共享 tli 图形、app-shared CSS 的 spin 2s steps(60,end)、outline 状态有确切来源。共享 primitive 单测与 typecheck、当前 CSS 构建、真实组件帧采样/减少动态效果/主题/触控/稳定几何与停止控制回归均通过。

## affected_paths / scan_scope
只改 design-system progress/panel-controls/empty-state/tokens/package、design-system-web adapter、Workspace lock/声明、Workbench 紧凑按钮规则、桌面呈现消费、边界门禁、聚焦测试与正式设计。不扩大为所有按钮样式重写。

## required_context / context_receipt
根/OpenCraft AGENTS、maintenance Skill 与 verification 全文；Router query desktop panel motion codex spinner outline controls 无匹配后有界搜索 progress-ring/panel-controls；design/README、Task 模板、frontend-runtime-openspec-i18n 邻接；相邻 smoke-desktop-panel-ui/fixture 和 cloud-desktop-plugin 的 Panel presentation。上轮已核对参考 intake，原始共享 JS/CSS 本轮直接读取。

## evidence / decisions
参考 Spinner 为 24px 盒内 16px 环（r=7, stroke=2）、0.3 底环及 270° 前景，全局 Document timeline 同相；两秒60步。compact outline 无 transition/active scale，disabled opacity=0.4，hover 消费 primary ghost。本产品触控时不粘 hover、44px 命中区保留；连接反馈与控制文字仍直接切换。当前在线 build 为 desktop-action-634fcdab5，本轮不切换。

## checkpoint
stage：源码与隔离真实组件验收完成；未接入在线预览。
verified：参考原始入口与具体 motion 样式；29项桌面/progress与13项共享控件/焦点/输入方式测试通过（progress重复，不累计为独立42项）。Web/纯设计系统/插件/Web adapter typecheck、平台边界与最终 release Web 构建通过。最终浏览器 隔离浏览器验收目录，三主题×720/320共六组通过；包含24px嵌套SVG与继承色、同相/中间帧/减少动态效果动态开关、即时hover/触摸按住、44px目标、中英文稳定几何与null-blur/键盘停止控制。已人工查看上一份相同实现截图 隔离浏览器验收目录 的连接与本机工具栏，不以蓝色测试画布冒充真实桌面。
unverified：Mac/用户 iPhone 同屏逐帧比较、原生输入与真实授权链路（本轮未改）；在线尚为旧Web，不能宣称用户已看到新动效。
discard：不按猜测添加动画，不把相近 token 当成像素等同。
restore：保留本工作树全部既有 dirty 改动，只补本轮边界。
next_action：按用户下一次授权，将限定改动基于当时实际在线包接入；不能用落后的工作树完整 dist 覆盖新 SSH/侧栏变更。

failure_receipt：纯 design-system 引入 React 被门禁拒绝，已拆为纯 geometry 与 design-system-web adapter，并增加新 adapter 边界检查；未放宽旧规则。一次 npm 验证误在 mono2 根执行，已在 opencraft 重跑。默认 Playwright 不在当前依赖中，显式指定现有工具后预检报缺少 libgbm/libasound；按已记录 Linux 验收前置条件加载隔离工具库，不跳过预检。

browser_failure_receipt：真实组件发现空态 descendant svg 规则错误放大/灰化嵌套 Spinner；按参考原始 EmptyState 的 direct-child 契约修复。采样最初直接改 CSS animation 实例，使其成为脚本 owner，现改为复制当前 CSS KeyframeEffect 在真实 DOM 上采样后 cancel，不干扰原动画。另实测同相 startTime 写入本身使 CSS 删除不足以停止，Web adapter 显式监听 reduced-motion 并取消，重新开启后 CSS 创建并同相。首次触屏按住夹具在 CDP detach 后把粗指针模拟重置，引发44→24差异；改为页面关闭时统一回收专属 session，不改产品密度规则。

validation_receipt：全局 reduced-motion 规则把 duration 写为0.01ms，故断言 transition-property=none 而非无效duration字面值；主题探针自身禁止transition，避免测到旧色的中间样本。未降低产品几何或帧采样约束。Context单测27项仍4项既有失败，audit单测33项通过，audit discovery完成但未评估；全仓catalog既有错误不当作本任务新增。正式边界补充在 cloud-desktop-plugin、platform-architecture、design/invariants 与映射 agent-gateway-runtime。

subsequent_delivery：用户后续明确授权重启，已由 [desktop-motion-preview-restart](2026-10-05-desktop-motion-preview-restart.md) 基于当前634在线基线接入，并独立监督重启成功。在线 build 20261005-desktop-motion-634fcdab5，新 PID 3721545；2026-10-06 重连核对进程、runtime SHA、健康与版本。上述“未接入”保留为本源码任务完成时的历史状态，不代表当前运行状态。
