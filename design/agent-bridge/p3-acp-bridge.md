# P3 通用 ACP bridge：实施记录

状态：已实现，本地验收完成；未切换任何现有引擎默认路径。基线为 P1b
`feat/agent-bridge-p1b`（`0d8f509517`，PR #213 未合入时的分支）。

## 交付

- `packages/agent-bridge-acp`：通用 ACP provider bridge。复用 P1a
  `@opencraft/agent-bridge-protocol` 的 JSONL/能力/语法契约和 P1b 独立 Host；
  ACP 客户端、翻译器、权限/模式映射为本批独立实现。
- `tests/agent-bridge/fixtures/acp-agent.mjs`：确定性 ACP 原生 fixture，覆盖
  initialize、session 模式/配置、流式更新、权限请求、native steer、cancel。
- `tests/agent-bridge/acp.test.ts` / `acp-host.test.ts`：bridge 契约与 Host
  组装/outbox/assembler 集成。
- `scripts/smoke/agent-bridge/p3-real-acp.ts`：opt-in 真实账号最小任务与
  initialize 录制。
- `design/agent-bridge/recordings/p3/`：Copilot、Amp 实际 initialize 与本机
  最小任务/steer 证据。

## 实施决定

1. **每个 Thread 一个 ACP agent 进程**。桥进程可承载多个 Thread；每个
   `session/create` 启动独立 agent，`session/close`/EOF 由桥回收。这样
   session 级能力、取消和崩溃不会跨 Thread 串扰。
2. **initialize 真实探测，声明只作上限**。静态声明保留
   `native-inject`/`next-turn`/`interrupt-replace`、text/image 的上限；探测只
   会移除 native-inject、image 或收窄 content types。没有 `steerMode`。
3. **ACP 无逐条 native input id**。native steer 回执只到
   `input.delivery{native-inject,admitted}` + `input.evidence{admission}`。
   ACP 没有稳定逐条 ID，`user_message_chunk` 的文本不能唯一归因到某条 steer，
   因此本 bridge 不发 echo evidence；同文本多输入时更不做猜测。绝不发
   `context-confirmed`。
4. **无 native 声明时不猜路径**。`turn/steer` 未带 `delivery` 直接
   `explicit-reject` 并提示选择 `next-turn` 或 `interrupt-replace`；Copilot
   真实 initialize 无 `_meta.midTurnSteering`，因此 UI/客户端不会收到 native
   label。显式 next-turn 在活动 turn 结束后开新 turn，`input.accepted` 带
   `disposition:"next-turn"`；只有新 prompt 成功后才记 delivery/admission，
   失败记 `input.outcome unknown`。interrupt-replace 先 cancel、等活动 turn
   结算后再写 replacement；写入前可通过 withdraw/stop/close 撤回，写入后
   delivery/admission 只在 prompt 成功后记录。P1a 的 `InputAcceptedDelta.disposition` 与
   `TurnSteerResponse.disposition` 为此做了加法扩展；旧值仍兼容。
5. **权限执行者是 bridge（声明 `approvalExecutor:"provider"`）**。bridge 按
   mode 自动裁决或把 ACP `session/request_permission` 转成既有
   `interaction/request`（kind `approval`），payload 同时带现有
   `item/commandExecution/requestApproval` 形状与 ACP 原生 options；答复接受
   `decision` 或精确 `optionId`，未知 option 一律 cancel。`full` 只在审批边界
   自动允许，不宣称扩大 agent 自身 sandbox。
6. **图片只在探测到 `promptCapabilities.image` 时进入 prompt**；否则显式
   拒绝，不退化成路径或文本。P3 不实现 ACP fs/terminal/elicitation 客户端
   能力。
7. **权限模式映射按方言落地**：Copilot `allow_all`、Amp
   `permission`/`amp-mode`、generic 的 `modes`/config options。session/create
   返回实际 plan，避免把“请求了 full”当成“已获得 native full 模式”。
8. **方言扩展点**：`registerAcpDialect` 接受 DSH/CodeBuddy/Cursor/AGY 的后续
   dialect 模块，只能收窄/授权 native 路径，不能扩大注册声明；P3 不加载任意
   外部模块。
9. **Amp 作者边界**：Amp dialect 只按用户 amp-acp 的 native steering 行为独立
   实现（`ad1d035`/`12998b4`/`8ef5b5ab`，作者 hxy91819：initialize 宣告
   `_meta.midTurnSteering`，活动 turn 的并发 prompt 作为 steer）。没有复制
   amp-acp 源码，也没有采用上游 Jintao Zhang 的 `5ee8c99`/
   `7776677` cancel-then-prompt/next-turn 代码；本批未修改 amp-acp 安装。
   Copilot 没有用户 steer patch，只走本批通用 ACP + 显式 next-turn。
10. **未知不重放**：写后 EOF/超时/agent 退出把未结算 steer 记为 unknown 并
   关闭 turn 为 failed，附 `provider.recovery{staleTurn}`；迟到的成功不覆盖
   unknown。
11. **真实任务只跑最小闭环**：临时目录、一个文件工具操作、一次 steer。模型
    选当前可用最低档（Copilot `claude-haiku-4.5` 0.33x；Amp `amp-mode=low`）。
12. **拒绝策略不因缺少 reject 选项而升级为人审**：read-only（以及
    accept-edits 对非编辑工具）在 agent 只给 allow 选项时直接回 ACP
    `cancelled`，不能让人通过 interaction 批准写操作。
13. **写入失败与撤回边界**：next-turn/interrupt replacement 在 native prompt
    成功前只算 accepted，成功后才记 delivery/admission；prompt 失败记
    `input.outcome unknown`。interrupt replacement 写入前可 withdraw/stop/
    close 撤回，写入后不可。ACP 响应写入死管道只收尾连接，不抛未处理
    rejection。

## 实机验收（2026-11-11）

| Agent | initialize | 最小任务 | steer | 证据档位 |
| --- | --- | --- | --- | --- |
| GitHub Copilot CLI 1.0.102 | 无 `_meta.midTurnSteering`；image=true；loadSession=true | 临时目录创建 `p3-accept.txt`，内容 `ok`；shell 工具 2 项 | 显式 `next-turn`；第二 turn 结束后开新 turn，回答含 `STEERED`；delivery=next-turn，admission | 队列/admission；无 native 标签 |
| Amp ACP 0.10.0（本机 8ef5b5ab 快照） | `_meta.midTurnSteering=true`；image=true | 临时目录创建 `p3-accept.txt`，内容 `ok`；shell 工具 2 项 | `native-inject` 并发注入；`turnsOpened=2`（未开第二 turn），最终 `WAITED STEERED`；delivery=native-inject，admission | native admission；不升级 context-confirmed |

录制文件保留实际 ACP `initialize` 请求/响应、bridge 握手、session plan、
任务文件内容与 steer deltas；已脱敏 home/workspace/repo 路径。Copilot 的
per-input `query` 未纳入录制（该字段在首次运行后才修正），以 canonical
`input.delivery`/`input.evidence` 为记录事实；排队 admission facet 由确定性
fixture 测试覆盖。

> P3c 后续批次已补上 session resume/load、history、model/list 与 ACP
> fs/terminal/elicitation，并把真实验收改走 Host；见
> [p3c-acp-followup.md](p3c-acp-followup.md)。本 P3 文档保留当时的范围记录。

## 未实现/缺口（P3 当时）

- `session/resume`、`history/read`、`model/list`、usage 仍为未声明：没有真实
  native history reader，不宣称可恢复；模型选择通过方言 config option 完成。
- ACP `elicitation/create` 在 P3 明确 decline；`fs/*`、`terminal/*`、`mcp/*`
  未实现，因此 initialize 不声明相应 client capabilities。
- 审批 payload 已进入桥的既有 interaction 通道，但 P3 未把该 payload 接到
  Web/Electron/Expo 的 UI；实际客户端投影属于后续接线批次，当前由 Host
  outbox/测试与 smoke client 消费。
- native steer 证据只到 admission；本 bridge 不使用 `user_message_chunk` echo
  作为逐条身份，Amp 也未观察到可归因 echo，不能声称模型上下文消费。
- 未覆盖多 Thread 同桥的性能、ACP agent 版本升级后的方言漂移和
  `session/close` 后真实 agent 资源释放；这些需要后续 provider 批次实测。
