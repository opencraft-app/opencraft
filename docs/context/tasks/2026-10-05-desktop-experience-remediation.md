---
id: desktop-experience-remediation
type: task
scope: 修正桌面首帧、焦点、剪贴板及反馈与验收边界。
triggers: ["桌面首帧", "desktop clipboard", "桌面体验整改"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.1.0
precedence: task
derived: false
---

## goal
整改已确认的 Codex 桌面体验差距，保持后端授权、产品插件和通用媒体所有权。

## non_goals
不重启/替换当前预览，不公开本机端口，不创建云资源，不补生产用户授权或原生控制 executor；不宣称 Mac 逐像素或手机实机验收。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；用户在差距分析后要求“整改”。

## interface_refs / data_structure_refs
cloud-desktop/{contract,controller,viewer,rfb,rfb-client,index}；pinned noVNC 1.5.0 绘制完成事件与剪贴板发送完成事件。握手不等于首帧；有效控制 lease 是输入和剪贴板的前提；取消后的异步读取不能发送。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、design/invariants.md、platform-architecture.md 的桌面所有权段。
relevant_evolution：上轮完成面板骨架和只读真实像素验收；媒体错误地将握手投影为画面就绪；测试此前固化了该错误。
superseded_refs：2026-10-05-desktop-panel-codex-ui.md 仅作历史收据。

## acceptance / validation
握手后延迟首帧期间仍连接中且不可控制；真正绘制后就绪；迟到事件无效；失败阶段有安全诊断。授权后聚焦媒体，粘贴文本先于按键，撤销/读取失败/超时不发送按键。真实组件浏览器覆盖主题、窄屏、触控事件和 reduced-motion。聚焦测试、相关 typecheck、边界/i18n、Web 构建。

## affected_paths / scan_scope
opencraft/plugins/cloud-desktop、design-system、Web共享button/i18n、相关 scripts/tests/docs。参考只读 Codex 26.930.31428/build12913 的 panel-da547d640131.js、src-51803043763e.js、app-shared-e760024b6716.js。

## context_receipt
根/OpenCraft AGENTS、维护技能及完整 verification、Task/Checkpoint 模板、design/README、cloud-desktop-plugin、platform-architecture 的 Package ownership 桌面/排版段、frontend-runtime-openspec-i18n 邻接；检查对应 check-i18n、tests 和 locale。Router 查询 `opencraft 云桌面 首帧 剪贴板 焦点 连接状态 整改` 无匹配，随后有界精确搜索插件、测试、脚本与 pinned noVNC lib/rfb/display。邻接前端路径不拥有此通用插件，未扩大到 frontend。

## decisions / risks
不复制协议解析器，不读第三方私有对象。固定版本解码器补最小公共事件，安装时校验原文件摘要与补丁结果；应用只消费事件/public APIs。媒体能力不得变成后端授权。普通 RFB 的非 Latin-1 粘贴应拒绝而非静默损坏；扩展剪贴板支持 Unicode。

## evidence / handoff
本轮源码整改完成，旧预览保持不动；未提交、推送或部署。

- 首帧证据来自固定版 noVNC 的非空像素解码、flip 和 flush；握手、空更新不能解除加载或允许控制。安装与 Web 构建均校验补丁版本、摘要、唯一 anchor、完整性及幂等性。最终构建 `rfb-DG7aOt7u.js` 已核对像素标志、firstframe、clipboardready、clearClipboard 四项存在。
- 控制器单独拥有准备/媒体截止时间、安全诊断、确认后聚焦及剪贴板事务。剪贴板读取/Provide 各限 5 秒、文本限 16,384 UTF-16 单位；撤销/重连不接收迟到结果，不自动取回控制。基本 RFB 拒绝不支持的中文，扩展模式 UTF-8 成功；发送完成不等同于远端应用接受。
- Design System 拥有旋转/减少动画、14/18 常规胶囊按钮、24px 桌面/44px 触控密度；触控纯图标按钮也是至少 44×44。显式 compact 密度在旧 size/variant 之后投影，并重置 toolbar 固定高度；Pending 仅使用短文案，单行反馈不挤动画面。
- `npm run test:cloud-desktop` 92/92；排版测试 5/5；Cloud Desktop/Vela Platform/Design System/Web 四个 workspace typecheck、i18n（198 messages）、边界与排版生成检查、最终 Web 构建、diff whitespace 全通过。
- `smoke:cloud-desktop` 普通和扩展模式均通过真实 noVNC：延迟/空首帧负例、像素、授权聚焦、按钮及 Ctrl+V 的文本先于按键、撤销/关闭。后端 authority/executor/RFB peer 为替身，不是生产输入安全验收。
- `smoke:desktop-panel` 使用最终构建 CSS；亮/暗/自定义主题 × 720/320px、宽屏鼠标/窄屏真实浏览器 tap 序列、取消、确认聚焦、失效/重试、中文反馈、减少动画、媒体 DOM/布局稳定均通过；sm/md/lg/toolbar 与 compact 组合均验证 14/18、24/44px 实际尺寸。最终截图 `/tmp/opencraft-desktop-ui-AsV1nK`；已查看亮色连接中与暗色窄屏确认控制图，不是手机实机、原生输入或 Mac 像素对齐证明。
- 正式设计已同步；文档验证与显式本轮文件集合的影响映射通过（命中 agent-gateway-runtime，Owner review 仍是 MR 平台职责）。`--staged` 为空，不把它冒充实际变更覆盖。
- 扩展共享控件测试 14/15；唯一失败为既有 `.settings-control-select-shell` 未消费 focus mixin；该选择器正文与 HEAD 完全一致，未改无关设置代码。修正 density 优先级后相关按钮三项单测再次通过。根 context 单测 26 项中 4 项失败：历史治理资产/中文文档/服务上下文预算/全局 validator；目录已再生成，本任务 validator 报错为 0，全仓已有报错 5025；未把本轮桌面回归通过冒充整仓 gate 通过。Context audit 单测 33/33；审计发现脚本完成但 not_assessed，不构成质量评分。

## checkpoint
stage：前端/媒体整改完成并构建，当前预览未切换。
verified：真实解码器和最终构建证据、两种剪贴板模式、授权后聚焦、主题/窄屏 tap/减少动画、迟到事件和撤销负例均已通过；完整收据见上节。
unverified：生产 Conversation authority 与原生 gated executor、远端复制到本地、IME/Mac 组合键、手机实机/弱网；安全诊断默认 console sink，不是持久服务器日志。
discard：当前 checkout 没有 Playwright 包；环境变量为空；/opt 无 browser-smoke 工具目录。不能借用其他 checkout 的应用依赖，浏览器工具模块单独定位。
next_action：用户确认后再单独替换预览；真实原生控制与生产授权按独立任务验收，不扩张本轮完成范围。
failure_receipt：首次浏览器缺少 libgbm/libasound，按已有手册仅为烟测注入隔离工具库后启动，未安装系统包。浏览器负例发现首个 anchor 空格错误；补上逐项唯一匹配和部分补丁拒绝，恢复本次 node_modules 的完整安装产物，与 npm 固定版本原包对比确认仅 EOF 差异并重新应用。字号实测 13px，新增独立 14/18 controlPanel registry role，不修改原 toolbarTitle。中断时未取回的进程结果均重跑，未用丢失 session 推断通过。
