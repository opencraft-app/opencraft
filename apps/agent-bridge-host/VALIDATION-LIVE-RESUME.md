# 重新登录后的真实验收 — 2026-11-11

用户在个人实例完成设备码重新登录后，旧 Codex 同模型对照成功，原 429
阻塞已解除。本轮没有登录、刷新账号或修复代码。P2a 指定的真实任务以及
P7b once/cron 成功；P7a 和 P4 仍未验，原因见下表。
此前 429 的历史证据保留在[首次复查](VALIDATION-LIVE-RECHECK.md)。

| 项目 | 本轮结果 | 脱敏证据 |
| --- | --- | --- |
| 账号只读确认 | 一个账号 ready、无 hold；新 access token 到期为 `2026-11-21T03:38:58Z`，未过期 | [账号、旧路径与 P2a](../../design/agent-bridge/recordings/live-recheck/codex-relogin-and-p2a.json) |
| 旧 `/rpc/codex` 对照 | **通过**；`gpt-5.6-luna`、low，一次最小提示，completed，回答 `OK`，无工具 | 同上 |
| P2a | **通过本轮指定真实任务**；读文件、工具中 steer、运行中网关重启、无重复副作用 | 同上 |
| P7a | **未验**；首轮配置刷新在 `thread/resume` 收到原生 `-32600 / no rollout found`，没有发送模型任务 | [CLI 准备拒绝](../../design/agent-bridge/recordings/live-recheck/p7a-cli-preparation.json) |
| P7b once | **通过组件真实执行**；一次真实定时触发，新建一个 Broker child，native 与 Worker 均 completed，回答 `P7B_ONCE_OK` | [once/cron](../../design/agent-bridge/recordings/live-recheck/automations-success.json) |
| P7b cron | **通过组件真实执行**；当前 UTC 分钟的一次 cron 触发，已有线程一个 native Turn，回答 `P7B_CRON_OK` | 同上 |
| P4 | **未验**；`hy3-ioa` 经独立 Host 重试一次，`session/new` 仍为 HTTP 500，没有 prompt 或 steer | [CodeBuddy 重试](../../design/agent-bridge/recordings/live-recheck/codebuddy-retry.json) |

## 成功项实际覆盖的边界

P2a 使用本分支源码构建并固定 SHA-256 的 Codex bridge、独立 durable Host，
连接已有 Core 与账号池。真实命令读出 `P2A_READ_OK`，只向临时文件追加
一行，再等待。观察到 commandExecution 开始后发送一次 steer；03:42:33 UTC
SIGKILL 验收网关进程并启动新进程，原 Turn 随后 completed，最终回答
`P2A_STEER_OK`。恢复历史中 start/steer 各一个 userMessage、一个工具结果；
steer admission 为 accepted，native-input-id 证据为 context-confirmed，
nativeExecutions 为 1，副作用文件恰好一行。此证据证明原生上下文关联，
不将其称为模型理解证明。独立 Host 和 Core 没有重启。

once/cron 使用临时 Server 数据库及真实 Orchestration Worker、ProjectAutomations、
Broker、独立 Host、新 bridge 和真实 Core。各自产生一个 scheduler occurrence、
一个 completed run、一个 completed native Turn；不是 manual run，也没有用
网关接纳代替模型终态。完成后暂停两个临时定义，关闭临时服务，避免继续触发。

这些是本机源码组件集成验收，未替换部署中的 headless composition。临时执行
adapter 将 Broker 的 create/read/start 接到真实 bridge，但没有覆盖生产
thread-prepare RPC；prepare 的权限装配不能代替生产装配验收。bridge 传输
进程显式使用现有 test process backend，真实模型与工具沿已有 Core 执行；
不宣称该测试 backend 具备生产资源隔离。没有打开或验证 Web、Electron、Expo
客户端，因此设计 §7 P2a/P7b 的更广退出条件仍保留，不写成整批全验收。

## P7a 新阻塞

真实 Host 已成功发行执行 CLI 凭据，Server admission 检查通过。
随后 `CodexOwnerConnection.configureExecution` 进入共享
`refreshCodexExecutionConfiguration`：thread/read 返回 idle，但
capture-settings 阶段的 thread/resume 返回 `no rollout found for thread id`。
网关把这次明确拒绝投影为 `cliUnavailable`、submissionOutcome=rejected。

这发生在新线程首轮之前，未产生 rollout；尚未运行 spawn/tell/wait/output 链。
首个准备失败后，又进行了三次仅配置准备的诊断复现，均未发送 native
turn/start。最后一个本地诊断 bundle 只增加阶段和原生错误的 stderr 记录，
未改变请求或绕过拒绝，也未提交诊断代码。没有将这些准备重试记成真实任务。
后续需要调整首轮配置准备与原生 session 生命周期的衔接，并补回归与独审；
这是独立于已解决账号 429 的缺口。本次没有扩大为该生命周期改造。

## 自行引入的决定

- 继续使用 `gpt-5.6-luna`，不换更贵模型。当前目录仍无价格元数据，
  仅确认它是原对照模型，不声称重新核实绝对最低价。CodeBuddy 沿用此前
  产品目录标为最低价的 `hy3-ioa`，没有第二次 session/new 重试。
- P7a 准备失败后，独立 automation Host 不配置可选 execution CLI，
  继续完成无工具的 once/cron。该结果不算 P7a 通过，也不证明 CLI 注入。
- cron 限定当前 UTC 日期和分钟，两个 automation 完成后立即暂停；所有调度
  使用真实时间，没有用 fixture 时钟代替真实 scheduler。
- 验收脚本曾对无首轮的线程请求完整历史并被拒绝，发生在任何 automation
  prompt 发送前。随后改为首轮前只读 metadata、真实 turn/start 后读完整历史；
  终态与输出始终来自原生历史，没有推定 completed。
- 本 checkout 临时复用同基线主 checkout 的依赖目录运行源码 harness，收尾移除
  该链接；未修改依赖、lockfile 或主 checkout。临时脚本、凭据配置、数据库与
  任务目录在脱敏取证后删除，只保留交付证据及 Core 原生历史。

## 检查与剩余缺口

脱敏 JSON 解析、关键结果断言、文档链接和 `git diff --check` 通过。
运行 smoke 前移除了 `BASH_FUNC_which%%`。本轮没有代码修复，未运行根
`typecheck`、`test:agent-bridge`，也未派发代码修复独审；既有测试不算本轮结果。
未部署、未修改默认引擎、未动 Hermes、未推送、未开 PR。

剩余：P7a 的首轮 CLI 配置生命周期与完整真实通信链；P4 的外部 HTTP 500；
生产 headless 装配及 Web/Electron/Expo 的相关客户端连续性验收。
