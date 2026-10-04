## stage
用户已授权实现并确认目标 ED25519 指纹。后端基础 SSH 连接已实现、普通 Linux 实机只读验证通过；源码交付，不重启当前预览。

本轮继续完整 Workbench 界面验收：新增桌面/触控 SSH fixture 脚本，隔离 headless Web 构建成功。已修复目录选择对持久 Project API 的强制依赖，仅明确 -32601 允许同 Server cwd-only Draft；相关 23 项测试、Web 类型与平台边界通过。UI 验收尚在进行，不宣称已完成。

## implementation_receipt
- 2026-10-04：目标 9.134.163.40:36000 只读登录确认 Codex 0.147.0 与既有 proxy 服务；原生 CLI 确认 `app-server proxy --sock` 支持。没有安装、升级、启动或停止远端服务。
- 新 Transport 经真实 SSH 完成 WebSocket /rpc、initialize、thread/list、model/list；没有推理或远端业务写入。认证口令只经隐藏 TTY 和私有 askpass IPC，未持久化。
- 复用 CodexEngineAdapter 的 Client/请求/Thread/交互所有权，remote 模式不创建本机附件、账号池、队列或 Goal。多客户端、逆序回包、未知投递不重放等测试通过。
- appserver 本机回归 251 通过，SSH 新增测试最终 17 通过、1 跳过（本机 sshd runtime 不可用），bot management 32 通过；六个受影响 workspace 类型检查、平台边界检查通过。
- 实际 Chromium 中的浏览器 AppHost/JsonRpcAppServerClient 协议验证通过：两个页面共享同一物理连接、退出和刷新不重建上游。仅 SSH exec 是合成夹具，不是完整 Workbench Shell 视觉验收。
- 私有 SSH 配置仅允许 loopback headless 服务。当前公开 80 端口预览没有认证边界，未向它暴露远端凭据或替换部署。

## verified
- HyperNode 接 Desktop 风格 exec 包装、哨兵和 SSH 内 WebSocket /rpc，不是裸 JSON stdio。
- 最新 Codex Desktop 实际 SSH proxy 入口采用同类包装；Linux bootstrap 与 proxy 附着是不同职责。
- OpenCraft headless 入口按管理员绑定的 Server ID 创建本机或远端 adapter；内部逻辑路由不会传到远端。
- 用户补充普通 Linux 必须兼容；方案不能以 HyperNode 专用服务器分支为基础。
- 默认 Steer 与可设置偏好已在独立任务完成，本任务不再改它。
- 原生 InitializeResponse 只有 userAgent/codexHome/platform 信息；不能将它当成完整服务端能力目录。HyperNode 回执与该形状一致。
- 最新 Desktop 使用 ws createConnection 接 SSH Duplex；已有 WebSocketTransport 可作为适配入口，不能手写帧编码。
- CodexEngineAdapter 共享同一套初始化/Client/请求/Thread/交互路由；本机资源仅在 local 模式构造。没有第二份 broker 实现。
- HyperNode virtual WebSocket 支持 ping/pong；透明 Thread runtime 仅在无订阅且无活动执行时回收。SSH/WebSocket/Thread readiness 必须分开。
- AppHost wire 保留 SSH 故障分类，状态去重包含 failure code/recovery。初始化有超时与等待上限；原生 fork 保留无固定 deadline，其他 pending 有界。

## unverified
- 真实 HyperNode、完整 Workbench Shell 操作与用户服务器真实推理/创建会话尚未验收。
- 原生 stateless FS 路由已允许，但实际读写/目录选择端到端未验证。远端附件、PTY/watch/search、队列、Goal 不开放，不冒充本机能力。
- 当前匿名公开 80 端口入口不能启用 SSH；公开部署必须补 attachment 鉴权及逐 Server ACL。未实现连接管理表单、自动安装/启动策略或跨进程交互持久化。
- 全仓 context 测试 4 失败（存量 Task Pack/Context/参考 instruction 约束），其余 23 通过；目录构建也报存量校验错误。文档/正式设计影响检查通过，context-audit 33 测试通过；不宣称全仓 gate 全绿。

## discard
- 本轮 UI 失败证据：首轮错误预期 Draft 跨整页刷新持久化（源码为 Application 内存）；随后两轮误用默认 `Add project` Modal 标题，而真实 Application 已传 `Choose a folder`/`Use folder`。实际目录请求与条目正常；已按真实可访问名称纠正测试，继续验收，不修改产品去迎合错误断言。
- 不部署 OpenCraft 到 HyperNode；不原样复用本机 CodexEngineAdapter 的进程/文件/账户/扩展能力。
- 不照搬参考测试跳过 hostkey 检查或 Desktop 的 pkill 策略。
- 保留失败证据：参考路径猜测失败后已用有界搜索改正；远端 daemon status 方法不存在；浏览器 libgbm 缺失后使用既有测试依赖解决。哨兵夹具曾错误交错 HTTP 字节，已修正。
- 不把关闭 logicalClientRouting 的共享广播当作外部多客户端兼容。

## restore
- 详细事实与已读文件见 2026-10-04-opencraft-ssh-codex-compatibility.md。
- 保留用户工作区改动及现有预览；本次代码/测试/文档未提交、未部署。现有广泛 dirty diff 不全属于 SSH 任务。
- Node 使用 /data/node-v26.7.0-linux-x64/bin/node；参考目录只读。

## next_action
完成实际 Workbench 桌面/触控 UI fixture 验收，记录目录选择、历史恢复、选中 Server 刷新和共享 SSH 连接证据。若用户要求公开预览接入，先确认带认证/逐 Server 授权的接入方式，不能直接把凭据绑定接到匿名 80 端口。
