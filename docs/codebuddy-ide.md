# CodeBuddy IDE 接入

CodeBuddy IDE 与 CodeBuddy CLI 是独立 Agent，分别使用 `codebuddy-ide` 和
`codebuddy` 身份。IDE 接入在“设置 → 模型/Agent 配置 → Agent 配置 → CodeBuddy IDE”。
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
当前命令接口不提供模型枚举和模型切换，Composer 明确显示“使用 IDE 当前模型”，
菜单说明在 CodeBuddy IDE 的对应会话中选择模型；不会把 Agent 名称伪装成一个模型。
IDE 登录与 workspace trust 分开观察；未信任项目不能创建或发送对话。
项目目录必须与 IDE 当前打开的第一个 workspace folder 一致。

“接入 IDE”用于建立连接；已连接但未登录时显示“登录”；项目未信任时显示
“检查项目信任”，它只打开原生信任检查，不代表已经授予信任。成功刷新原生状态后，
对应步骤的旧失败提示立即消失；其他 Agent 就绪不能清除当前 Agent 的失败，切换到
其他 Agent 也不显示这条错误。信任检查打不开时，页面提示切换到 IDE 中检查工作区
信任并返回刷新，而不是只显示笼统的接入失败。

连接属于一个具体 IDE 窗口。独立 `--user-data-dir` 的验证实例有独立登录与项目
信任状态，不能代表用户日常配置。验证后应关闭自己创建的临时实例，避免它持续
占用单窗口桥接；恢复连接时使用正常配置中的目标项目窗口，保留其他工作窗口。

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
- 桥接扩展 0.1.2 接受原生纯文本、文本块和序列化消息内容；仅投影助手文字，
  没有助手文字的完成回执明确失败，不能成功完成却显示空白。
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

新建原生会话在首条消息前尚无历史文件。执行 owner 为未接收输入的会话记录
`nativeHistoryEmpty`，首次打开与恢复可读取空历史后继续发送；接收输入立即撤销
该证明，浏览器传入同名字段不能隐藏缺失或损坏的历史。旧版创建且从未接收输入的
IDE 会话恢复同一证明；扩展只允许可信 Host 的空会话证明重新登记该原生身份，
已接收输入的导入会话仍需核实原生记录和账号／项目。

历史 Worker 使用原生 `extra.inputPhrase` 恢复用户显示文字，省略原生隐藏 helper；
不把 IDE 添加的项目上下文和执行说明作为用户消息。只有识别到原生执行 envelope
时替换相应文本，用户自己输入的普通文本和标签保留。

## 发送与恢复验收（2026-11-17）

已安装桥接扩展 0.1.2，并在正常本地项目窗口重载；原有远程窗口保留。
真实 Web 新建 CodeBuddy IDE 会话，发送一次只要求回复、禁止工具的连接测试，
收到“连接正常”。模型入口显示“使用 IDE 当前模型”及说明；刷新后桌面和触控
均恢复原生回复，编辑器恢复可用，没有重发模型请求。已查看
`/tmp/opencraft-ide-response-model.png`、`/tmp/opencraft-ide-response-live-desktop.png`
及刷新后的桌面／触控截图。单元测试另外覆盖首条消息前历史读取、空历史证明撤销、
账号／项目边界、结构化文字、空回复失败和历史显示输入。此验收不代表已经提供
IDE 模型列表或直接切换模型，也不代表远程设备的接入程序已升级。

## 接入恢复验收（2026-11-17）

实际发现两个遗留的临时验证实例；桥接传输通，但连接窗口未登录且项目未信任。
确认验证实例没有未保存备份后关闭它们，通过官方扩展安装入口将既有桥接更新到
0.1.1，在正常用户配置中新开本地项目窗口。只读原生回执确认 authenticated、
workspaceTrusted 和当前项目匹配均为 true，并声明原生历史账号作用域；没有更改
信任设置或发送模型消息。原有远程工作窗口保留，执行 Host 进程没有重启。

真实 Web 设置页的桌面和触屏浏览器均显示 CodeBuddy IDE“就绪”，开关可用且没有
旧失败提示；已查看 `/tmp/opencraft-ide-trust-live-desktop.png` 和
`/tmp/opencraft-ide-trust-live-touch.png`。原生状态由实际 IDE 提供；错误恢复的
失败、其他 Agent 就绪、切换 Agent、先完成信任再登录等序列由真实组件加合成边界
的 smoke 验证。五条桥接测试、Web 类型检查、i18n/controls 检查及测试、Web 构建和
浏览器兼容检查通过。当前交付为源码、已验证 Web 构建、Vite 预览和已安装的本地
桥接扩展；真实模型轮次与实际历史导入写入未执行，也没有发布发行版。
