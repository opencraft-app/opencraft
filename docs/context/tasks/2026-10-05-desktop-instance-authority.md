---
id: desktop-instance-authority
type: task
scope: 补充本机云桌面的后端会话授权与真实 native/Codex/浏览器验收。
triggers: ["desktop instance authority", "桌面会话实例授权", "本机桌面浏览器验收"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/docs/build-matrix.md", "sandbox/docs/desktop-viewer-broker.md"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
后端独立核验会话与执行 Server 绑定，优先打通当前 Server 的本机桌面能力；TAT 作为远端适配，不阻塞本机验收。

## non_goals
不重启/替换预览、不创建云资源、不借用协作产品空间 Server 身份；不把本机路径宣称真实 TAT 验收。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；本会话用户“搞啊：缺少后端会话→实例的权威授权绑定，真实 TAT 尚未验收”；澄清“你现在应该是用本机能力啊”。

## history_context
current_design_refs：ctl/docs/cloud-desktop-resource.md、sandbox/docs/desktop-viewer-broker.md、opencraft/docs/cloud-desktop-plugin.md。
relevant_evolution：desktop-verified-runtime 已完成物理只读进程核验，缺少生产 Authority；保持真实能力未接通前入口隐藏。
superseded_refs：客户端 Host/activeBot 投影不是后端授权；collaboration Server 是产品空间，不是执行 Server。

## interface_refs / data_structure_refs
LocalDesktopService 后端机器注册与真实 Thread 元数据、CodexEngineAdapter 连接代际、HostDesktopCapability/HostDesktopCredential、HostDesktopBackend；Sandbox desktop.Authority 是远端后续边界，不是本机授权替身。

## acceptance / validation
拒绝错误 Thread/Server/连接代际、票据重放、准备或绑定变更和迟到响应；验证只读观看不销毁会话。类型检查、Host/桌面/网关回归及真实 native/Codex/浏览器链路；真实 TAT 与本地合成模型证据分别记录。

## affected_paths / scan_scope
OpenCraft appserver-protocol、local-agent-host/desktop、daemon Codex adapter、headless/web gateway、workbench-web Host adapter、桌面验收脚本与文档；CTL 原生 observer 测试用于实机安全验收。

## context_receipt
根、OpenCraft、CTL、Sandbox、collaboration AGENTS；OpenCraft 维护技能及 verification；agent-gateway-runtime、identity-access、ctl-service-detail；邻接索引与 frontend-runtime-openspec-i18n、lightvela-desktop-provider.test.ts；Task/Checkpoint 模板；前一 verified-runtime 和本机安装 Task。

## decisions / risks
候选 locator 不等于授权记录。用户澄清前曾评估 CTL 归属+Hermes 会话；本轮最终按本机执行 Host 的真实 Codex Thread 和后端 UID/机器注册实现，不建第二份聊天数据库。云元数据确认的实例不能被假定为 CTL 分配记录。Loopback trust 不是 DevCloud 多租户授权；公网组合/TAT仍未验收。

## checkpoint
stage：本轮本机实现、实机验收和运行知识沉淀完成；未部署到当前预览。
verified：全 workspace 类型检查通过，桌面回归 79 项、AppServer 回归 248 项及 headless 测试通过；Web 构建、边界/排版和 i18n 检查通过，原生只读/代理实机测试通过。真实 Codex/Thread→systemd原生核验→独立观看→noVNC浏览器全链路通过，1440×900、RGBA [32,128,224,255]；关闭观看后真实Thread仍可读取，断开Host撤销入口。
unverified：公开 DevCloud入口鉴权、Vela多租户目录、真实 TAT、原生控制权仲裁、手机弱网媒体恢复。没有宣称这些已完成。
discard：不存在的 opencraft-server/Go 目录、cloudagent/hermes-agent、conversation-registry.ts 和 ctl/chatclaw_runtime.go；已改沿当前 Hermes bridge/Profile 源码定位。
restore：脏工作树原有桌面实现保留，当前预览不动；本轮启动的三个桌面服务均恢复 inactive、disabled，无 5901/5902 监听。并行停止时 observer 因 Xvfb 先退出产生 failed，已 reset-failed。
next_action：等待用户决定预览接入；公网 DevCloud 授权与真实 TAT 属于另一个后续任务，不自动扩大本轮范围。
gate_receipt：文档校验和明确 changed-file 的 impact check 通过，owner review 为后续合入要求；空 staged changeset 不是验收证据。根 context 单测有 4 个历史失败，context catalog/validator 有历史错误；当前 Task 的 triggers 条数错误已修正，不能宣称全仓门禁通过。context audit discovery 为 needs_agent_review，不等于审查通过。
failure_receipt：第一次 headless 测试被 checkout 内 node-pty 未编译阻止；本机 npm rebuild 后 12 项通过。Playwright 工具最终由浏览器 cache .links 定位。Chromium 缺 libgbm/libasound，使用已有隔离工具库；又缺 libwayland-server，安装 TencentOS 的 libwayland-server-1.23.1-1.tl4。已新增可复用 preflight 并沉淀 build-matrix，不复制其他 checkout 依赖、不自动安装。第一次画面采样早于首帧绘制，已改等待不透明真实 framebuffer，而非仅 RFB connect。

## runtime_receipt
本机 prepare command 从 CTL 真源生成（临时 Go exporter 已删除），仅安装 root-owned observer/proxy 源码和 unit，不 enable 开机启动。原 inactive 的 vela-xvfb、vela-desktop-observer、opencraft-desktop-observer-proxy 在验收期间启动；未启动旧 5900/6080 服务或 WM。浏览器依赖新增 libwayland-server；库路径只注入验收子进程。独立 profile/截图：`/tmp/opencraft-local-desktop-smoke-lI03tv/desktop-acceptance.png`，本地合成模型仅 1 次请求，无真实账户、TAT或收费请求。真实 Codex binary取当前进程 exe 的已确认路径，只启动隔离新子进程；旧 PID1048893 未动。
