# CodeBuddy IDE 接入

CodeBuddy IDE 与 CodeBuddy CLI 是独立 Agent，分别使用 `codebuddy-ide` 和
`codebuddy` 身份。IDE 接入在“设置 → Agent 接入 → CodeBuddy IDE → 接入 IDE”。
目前自动发现、安装入口针对 macOS `/Applications/CodeBuddy CN.app` 和
`CodeBuddy.app`；原生指令接口验证基线是 CodeBuddy CN 1.106.1、内置
Tencent-Cloud.coding-copilot 3.10.0。其他版本需实际验证，不能据此宣称兼容。

## 连接与执行

OpenCraft 用官方扩展安装入口安装自己的 VSIX，扩展 ID 为
`opencraft.codebuddy-ide`，不会修改 CodeBuddy 应用文件。首次安装后可能需要
重载 IDE 窗口，再打开页面提供的连接链接。连接链接只含私有连接文件的路径，
不含登录凭据。原生命令面板也提供“OpenCraft：接入 CodeBuddy IDE”。

扩展连接到同一机器上 OpenCraft Host 的临时回环 WebSocket。私有描述文件
0600，目录 0700；IDE 与内部协议代理分别持有随机令牌，浏览器 Origin 被拒绝。
不需要公网端口、SSH、隧道或代理用户的 CodeBuddy 登录凭据。
当前一个 Host 只接收一个 IDE 窗口；多窗口不会静默抢占连接。

执行发生在 IDE 的原生 `chat.sendMessage` 命令中，由其创建/续接原生会话。
OpenCraft 只转发文本和原生会话 ID；返回内容来自原生完成回执。
内部 ACP 代理只是 OpenCraft 引擎端口适配，没有启动 CodeBuddy CLI。
模型与权限由 IDE 当前配置持有，不向 IDE 伪造任意模型或权限切换。
IDE 登录与 workspace trust 分开观察；未信任项目不能创建或发送对话。
项目目录必须与 IDE 当前打开的第一个 workspace folder 一致。

## 当前能力与限制

- 可创建原生会话，发送文本，完成后展示原生回复。同一扩展生命周期可继续
  自己创建的会话，也可接入 IDE 当前打开的原生会话。
- 桥接扩展 0.1.1 支持当前 IDE 登录账号、当前已打开项目的历史导入。Host 在历史
  Worker 中只读原生索引与消息，续接前重新核对原生会话和项目，扩展接收 Host 的
  核验回执后才放行冷导入会话；导入后的原生 ID 保持不变。更换账号或项目会隔离
  导入缓存并重新校验；其他项目先在 IDE 打开，再刷新目录。
- 老扩展不声明此能力。须更新 VSIX 并在方便时重载／重新连接 IDE；Host 升级不等于
  已安装的 IDE 扩展自动升级。没有原生持久记录的旧会话仍需在 IDE 打开原会话。
- 当前执行返回完成后的回复，尚无逐段流式事件、实时工具过程同步或 fork。
- 停止任务需在 IDE 操作；OpenCraft 的停止请求明确返回不支持，不冒充已停止。
- 断线、超时或未确认完成按结果未知处理，不自动重发提示词。检查 IDE 原会话
  后再决定下一步；连接恢复不等于原任务已经结束。
- `OpenCraft CodeBuddy IDE` 输出通道提供激活/传输诊断，不输出连接令牌或提示词。

## 构建与验证

`node scripts/build-codebuddy-ide-extension.mjs` 生成
`.local/codebuddy-ide/opencraft-codebuddy-ide.vsix`，不发布到扩展市场。
Host 的接入动作使用同一构建入口，并附带本次描述文件路径，便于安装后连接。
打包保留随包 ws 的许可证，不携带第三方 IDE 源码。

测试 `tests/execution/codebuddy-ide-bridge.test.ts` 使用真实回环传输和引擎代理、
模拟原生 IDE 命令，覆盖原生 ID、工作目录、busy、并发、trust 和拒绝非授权连接。
`scripts/smoke/execution/smoke-codebuddy-ide.ts` 检查真实 React 消费者中的
IDE/CLI 分离、连接/登录/信任/就绪状态，以及键盘、触控和浅深主题。
模拟命令测试不能替代原生登录后的真实模型轮次。
