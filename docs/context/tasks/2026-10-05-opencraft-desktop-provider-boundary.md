---
id: opencraft-desktop-provider-boundary
type: task
scope: 实现云桌面传输适配与 Vela 产品 provider 的单向插件边界。
triggers: ["desktop provider boundary", "云桌面 Vela 插件边界", "noVNC product provider"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/plugins/cloud-desktop/src/contract.ts"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
按用户“搞起来，要注意云桌面插件和 vela 插件的边界”推进真实适配实现，保持通用呈现/媒体与产品授权/资源接入分离。

## non_goals
不提交、部署、重启预览、启用真实 TAT/云资源；不以客户端 viewOnly 冒充后端授权；不增加未接通入口。

## requirement_ids / requirement_refs / requirement_excerpt
外部编号 unknown；本会话 2026-10-05 请求。前序传输评估选择 WSS 候选，真实授权 attachment/媒体/输入仍未完成。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、plugin-architecture.md、platform-architecture.md。
relevant_evolution：2026-10-04 协议无关框架、CTL 准备接口与本地二进制传输测试已完成。
superseded_refs：旧 frontend desktop/session 直接凭据模式不作为安全控制租约模型。

## required_context / context_receipt
- 根 AGENTS.md、opencraft/AGENTS.md、CTL service pack 及 ctl/AGENTS.md：路由 query 命中 control-plane-ops（adapter），核实控制面授权边界。
- 完整 OpenCraft maintenance 技能及 verification 清单：实现、可见结果、所有权与证据分层。
- platform-architecture 的拓扑/桌面/认证章节，plugin-architecture 的 activation/owner/Cordis/模块边界章节。
- adjacency README、frontend-runtime-openspec-i18n 卡：有界检查产品相关 runtime 邻居，不改生成副本。
- 收尾正式 Domain 同步时补路由 agent-gateway-runtime 并完整读取 must_read 派生 Pack；没有修改公共网关路径或将本地数据面验证当作云上证据。
- 两次定位猜测不存在 lightvela 目录及 session-provider 路径，随后按 rg --files 改为实际 lightvela-platform/lightvela-hermes 入口；一次并行读取截断，拆分后重读必需指令。

## acceptance / validation
通用云桌面不导入产品插件/TAT/账号；产品 provider 不持有 Shell 几何或桌面呈现；身份变化与退休拒绝迟到结果并清理连接。两端类型检查、聚焦测试、依赖边界、相关 Web 构建；真实后端未接通时入口仍隐藏。

## decisions / risks
实现 cloud-desktop 的 noVNC 1.5 媒体适配、lightvela-platform/desktop 的产品 provider 和单向 source/package dependency guard，不编造上线 API 或降低后端输入门禁。Vela 使用现有账户 request 和真实 CTL resource 路径；viewer port 与 canonical directory 仍需生产实现/组合，缺失 viewer port 不发布入口。provider 不依赖 activeBotId、Chat 或 DOM，普通账户详情更新不退休观看连接，身份/绑定代次变化则退休。

noVNC 使用公开 WebSocket channel/API。握手事件为就绪源；surface 创建前不打开 socket，以免导入期间丢 greeting。输入默认禁用，租约只能来自同一 connection；异步模块加载取消立即释放 session。未知 POST 结果不自动重试，90 秒消费端准备超时不取消 CTL 的独立资源后台任务。

## evidence / scan_scope / scan_output
仅 cloud-desktop、lightvela-platform、lightvela-hermes 接入边界及相关 tests/scripts/runtime；只读 legacy frontend 桌面 installing 测试核对邻居，未改生成副本或 CTL。

本轮新增：中性 RFB adapter / Vela provider / loader interop / focused tests / 真实浏览器 framebuffer smoke。维护技能促使加入取消、晚到结果、权限代次与真实解码验收；fake-client 测试通过后仍实际发现 noVNC 默认导出不是构造器的问题，已修正。

## validation / handoff
- 最终 `npm run test:cloud-desktop`：43/43 通过；相邻 LightVela platform/account port/panels 测试：20/20 通过（既有生成 i18n 警告保留）。
- cloud-desktop、lightvela-platform、workbench-web 三端 typecheck 通过；新测试/fixture/smoke 单独 strict tsc（DOM.Iterable）通过。
- check:boundaries、check:i18n、build:web 通过；既有构建 chunk/dynamic-import 警告不宣称已处理。
- 最终真实 Chromium smoke 成功，实际 noVNC 解码合成二进制 framebuffer 像素并验证 observe/grant/revoke/close。独立 Playwright 工具与浏览器依赖仅作测试环境，产品依赖在本 worktree 安装，未借用其它 checkout。
- git diff --check 与显式本轮变更集合 docs-impact 通过；正式文档 validator errors/warnings 均为空。全 npm gate 未重跑，前序已记录的无关 extension-artifacts 失败不由这些 focused checks 证明解决。
- Context 校验发现新 TaskPack triggers 少于 3，已补齐；历史 5025 项错误单独保留，不混作本轮源码失败。
- 预览仍 opencraft-neutral-focus-20261004-preview.service active，MainPID=2785955。未替换、重启、启动桌面、执行真实 TAT、改 GitOps、提交或推送。
- 四个 vela 桌面 unit 均 inactive/disabled；未改变前序本机安装状态。
- 源码边界阶段完成；生产 viewer broker、输入门禁、canonical directory 组合与真实云网络/设备验收未完成，默认入口隐藏。后续不能用旧 password/session 契约替代。

## checkpoint
stage：两端源实现及真实浏览器验证完成，TaskPack 退出默认路由；未改运行态。
verified：43 例桌面和 20 例相邻测试通过，类型/边界/i18n/Web 构建通过。真实 Chromium + 实际 noVNC + 真实 panel/provider 解码合成 RFB framebuffer 像素成功；控制授予后 key/pointer 发送、撤销后停止、关闭清理通过。provider 无 viewer port 不发布能力，CTL 尚无 attachment/input gate。
unverified：生产授权观看/输入、云上媒体与设备输入。
restore：继续使用 mono2-cloud-desktop-tencentos-20261004，保留全部此前 dirty 修改。
discard：产品 typecheck 首次发现跨 workspace noVNC 声明不可见，显式 reference 修复；独立测试 tsc 初次缺 DOM.Iterable，补正确库后通过。Fixture 的 react-dom types 在 Web workspace 私有安装，typeRoots 仍受 exports 阻止；按已有版本范围给 root 测试依赖声明 @types/react-dom，非借用其它 worktree。
discard：浏览器初次缺 libgbm/libasound，使用已有独立测试工具依赖（不安装系统包）后启动成功；真实 mount 错误为 CommonJS default export 对象不是构造器，局部 ESM wrapper 也未修复，移除并在 loader 边界显式校验两种导出形状。后续握手失败是合成 server 将 greeting 发成 WS text，改为正确 binary 后 browser smoke 通过。
next_action：后续实现后端授权观看/输入 broker、canonical directory 组合，再接云上端到端验收，不用 raw TAT/VNC 密码降级。源码、Web 构建产物与运行中的旧预览分别交接。
