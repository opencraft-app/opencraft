---
id: cloud-desktop-local-install
type: task
scope: 在本机 TencentOS 4.4 试装已适配的 CTL 图形环境，不重启 OpenCraft。
triggers: ["本机云桌面试装", "TencentOS 4.4 试装", "图形环境安装验证"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - ctl/pkg/instance/desktop.go
  - ctl/pkg/instance/desktop_install_packages.go
status: retired
reviewed_at: 2026-10-04
review_due: 2027-01-02
revision: 1.0.0
precedence: task
derived: false
---

# 本机图形环境试装

## goal
在当前 TencentOS 4.4 主机执行已适配的安装脚本，验证包、unit 和仅回环地址的实际图形会话。

## non_goals
- 不接通 OpenCraft 云桌面 UI/WebRTC，不重启当前 OpenCraft/Codex，不部署、提交或推送。
- 不添加外部仓库、不关闭安全策略、不开放公网 5900/6080。
- 不给新增桌面账户 sudo 权限，不改变 OpenCraft 现有进程用户或项目权限。

## requirement_refs
用户最新授权：“在本机 opencraft 上安装看看？”；此前脚本适配已完成，仅模拟验证。

## interface_refs / data_structure_refs
renderDesktopInstallCommand 原始生成脚本；agentuser、/home/agentuser 和 4 个 vela 桌面 unit；安装进度 DONE/FAIL。

## history_context
- current_design_refs：docs/engineering/domains/agent-gateway-runtime.md 的 CTL Desktop provision 语义。
- relevant_evolution：2026-10-04-cloud-desktop-tencentos44-installer.md 已完成 21 个模拟场景和全量 instance 包测试。
- superseded_refs：前一任务不实装的范围已由本次明确授权扩展；不扩展到 OpenCraft 服务切换。

## acceptance
- 在变更前核对系统、账户、服务、端口、磁盘和 DNF 事务。
- 执行原始生成脚本，包与 unit 验证通过；安装本身不 enable/start。
- 若进行服务冒烟，使用隔离 display 和临时服务、仅回环监听；结束后清理临时运行态。
- 交接报告安装状态、图形验证、UI 未接通和保留的机器改动。

## affected_paths
- 主机原生 RPM 包、/home/agentuser、/etc/systemd/system/vela-*.service。
- 本任务记录；不修改 OpenCraft 源码。

## context_receipt
- AGENTS.md、ctl/AGENTS.md、opencraft/AGENTS.md：权限与交付边界。
- docs/context/domains/site-environment-routing.md、docs/context/project/services/ctl.md：路由 must_read；不作线上或区域推断。
- CTL 安装源码和前一任务记录：使用原始生成脚本，不另外手写另一套安装包逻辑。

## evidence
- 本机 root、TencentOS 4.4、systemd 正在运行；agentuser 和四个桌面 unit 均不存在，5900/6080 未监听。
- 根盘余量约 17 GiB，内存 available 约 25 GiB；图形核心包未安装。
- DNF --assumeno：新增 105 包、升级 5 个 curl/libcurl/libcurl-devel/dbus-common/dbus-libs 配套包，约 136 MiB 下载；没有删除包或整机升级命令。
- 原 OpenCraft：opencraft-neutral-focus-20261004-preview.service，MainPID=2785955，启动时间 2026-10-04 10:40:41 CST，HTTP 200。
- 导出目录：/data/opencraft-desktop-local-install-Jn46gw；使用临时只渲染的 Go test 导出原始脚本，导出后已移除临时源码文件。
- 原始外层 launcher 在本地命令结束后未留下后台安装进程，日志/进度为空；改用独立 transient systemd installer 执行它已生成的同一内层脚本，不重写安装逻辑。不能据此断言 TAT 也有相同子进程生命周期。
- 安装最终写入 PROGRESS=100 / DESKTOP_INSTALL_DONE，DNF 事务完成，四个正式 vela unit 为 disabled/inactive。
- 默认 UID 1000 与已有容器 metrics-server 的数值 UID 重合；撤回仅本轮创建的账户登记、不删除 home/spool、不停止容器进程，重建为 agentuser UID/GID=59091，并将本轮 home/spool 归回该账户。账户密码保持锁定、无 sudo。UID 超出本机默认自动分配范围的 warning 不阻止显式 UID 创建。
- 重分配后再次实际启动 XFCE/终端、VNC 和 websockify 临时服务：HTTP 200、WebSocket 101 到达 RFB、1440×900 非空 framebuffer（采样 513 色）、Noto Sans CJK SC 字体匹配通过。测试监听仅 127.0.0.1/::1。
- 图形截图：/data/opencraft-desktop-local-install-Jn46gw/desktop.png；测试服务通过 EXIT cleanup 停止，正式 unit 没有 start/enable。
- 最终截图人工查看：中文窗口标题可读；通过真实 VNC KeyEvent 向隔离终端输入仅打印测试文本的命令，截图显示 OpenCraft desktop input OK，验证输入链路。最终非空画面采样 538 色。
- OpenCraft PID 2785955 和启动时间保持不变，HTTP 200；原 dbus-broker PID 975 保持不变；metrics-server PID 3853119/UID 1000 不变。
- RPM scriptlet 有两条 “Failed to connect to bus: No medium found”，事务仍成功；systemd-analyze verify 仅提示原有 tat/devops unit 的非本次警告，桌面 ExecStart 路径有效。

## decisions
先创建仅用于图形环境的非特权、无密码登录账户，继续以 root 执行安装。保留现有 OpenCraft 运行用户和工作区权限；本轮不认为 UI 或 Agent 桌面工具已接通。

## risks
DNF 可能依赖升级系统库，须先审阅事务；不得触发无关服务重启。默认 VNC unit 有监听风险，真实冒烟使用单独回环临时进程，默认 unit 保持停止且不启用。

## validation / handoff
安装和真实回环桌面冒烟已完成。保留原生包、独立 agentuser 和 4 个已停止/禁用的桌面 unit；保留本轮日志与截图。未接通 OpenCraft UI/WebRTC/Agent 桌面工具、未验证 CTL/TAT/ingress 的完整端到端链路；原 OpenCraft 未重启。

最终文档链接与文档校验无错误，本任务 Context schema 无错误，git diff --check 通过；staged 门禁为空变更集，不作为实际变更检查的替代。最后端口检查四个测试/正式端口均不监听，agentuser 无残留进程；临时渲染测试源码已移除。

## checkpoint
### stage
安装完成；真实图形、中文、键盘输入与回环链路通过，截图与服务/端口清理已核对。
### verified
原脚本图形包与 unit 安装成功；账户独立；OpenCraft 与原有容器未重启。
### unverified
用户页面云桌面入口、WebRTC、TAT 与远程鉴权端到端尚未接通/验证。
### discard
不使用当前 OpenCraft 的重启/替换流程。
### restore
独立工作树 /data/mono2-cloud-desktop-tencentos-20261004；不动原脏工作树。
### next_action
交接安装和真实图形测试证据；前端接通作为后续独立任务。
