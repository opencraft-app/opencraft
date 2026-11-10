# P3c：ACP resume/history、model/list、客户端服务与 Host 实机收尾

P3c 建立在已合入的 P1b Host 与 P3 通用 ACP bridge 上，不切换任何默认引擎，
不改动现有 Web/Electron/Expo 的 AppServer 连接路径。它补上 P3 明确留空的
native history、模型目录和 ACP 客户端侧服务，并把真实验收改走
`apps/agent-bridge-host`。

## 已实现

### 1. session resume/load 与 history

- `session/resume` 接收 `providerThreadId`（或 `nativeSessionId`）和可选
  `cwd`/`permissionMode`/`modelSelection`。
- 探测到 `agentCapabilities.loadSession` 时调用 ACP `session/load`，否则探测
  `sessionCapabilities.resume` 并调用 ACP `session/resume`；两者都没有则
  `unsupported`，Host 的 `history` gate 也不会放行。
- resume/load 窗口内的 `session/update` 只进入 history replay，不转成 live
  `thread/delta`；load 响应后保留 200ms 供 resume 结果计数，之后到首个 turn
  开始前仍归入 history，容纳 Amp 这类在响应后才吐历史的实现，避免 late
  replay 变成 live unhandled。
- `history/read` 分页返回 `{nativeSessionId, updates:[{seq,update}], nextCursor,
  total, truncated}`。上限 1,000 条 / 4 MiB，单页 512 KiB，避免超过 Host 的
  1 MiB wire 限制。
- replay 不是第二套客户端历史：没有 load 就不承诺 history；没有把 replay
  强行投影成 live Turn。
- 恢复时只应用与当前 native 值不同的 mode/config。Amp 在首个 prompt 后拒绝
  改 `amp-mode`；相同值不再发送，避免把“恢复”变成一次非法变更。

### 2. model/list

- 有活动 session 时直接读 ACP `models.availableModels/currentModelId`，或
  category=`model` 的 config option；没有 session 时启动一个短命 ACP
  `session/new` 探测，不发 prompt、不消耗模型 token。
- 返回 `{models, current, source}`；Copilot 为 `acp-models`，Amp 为
  `config:amp-mode`。没有模型目录时返回空列表并标 `source:"none"`，不伪造
  模型。
- `model` 是注册上限，实例探测只决定 history 等可验证能力；`model/list`
  本身不会因探测失败而宣称有模型。

### 3. ACP 客户端侧 fs/terminal/elicitation

- ACP initialize 的 `clientCapabilities` 按权限模式声明：
  - `fs.readTextFile` 始终可用；
  - `fs.writeTextFile` 只在 `accept-edits`/`full` 声明；
  - `terminal` 只在 `full` 声明；
  - `elicitation` 在非 `read-only` 声明。
- `fs/read_text_file`/`write_text_file` 限定在会话 cwd，`realpath` 后拒绝
  symlink/path escape；写拒绝 symlink 目标，限制 8 MiB。
- `terminal/create/output/wait_for_exit/kill/release` 在会话 cwd 启动普通子
  进程，输出上限 512 KiB、最多 8 个；`session/close` 释放全部终端。
- `elicitation/create` 进入既有 `interaction/request` 通道，kind=`elicitation`，
  payload 为 `item/elicitation/request`；resolver 接受 accept/decline/cancel
  和 content，未送达/未知一律 decline。未在 Web 客户端投影。
- `mcp/*` 仍未实现且不声明，避免假支持。

### 4. Host 运行

真实验收不再直连 bridge：

```sh
npx tsx scripts/smoke/agent-bridge/p3c-real-host.ts --agent copilot
npx tsx scripts/smoke/agent-bridge/p3c-real-host.ts --agent amp
```

脚本注册 pinned generation，经 `BridgeHost` 走命令账本/outbox、审批回调、
canonical assembler，再执行一次临时文件写入、一次 steer、close/resume、
`model/list` 和 `history/read`。真实额度只在明确手动运行时消耗。本机脚本
使用 `tests/agent-bridge/fixtures/local-backend` 作为本地进程后端；Host 的
账本、outbox、assembler 和 bridge 是真实路径，但这不等于生产 sandbox 后端
已验收。

## 实机验收（2026-11-11，经 Host）

| Agent | initialize | model/list | 任务 | steer | resume/history |
| --- | --- | --- | --- | --- | --- |
| GitHub Copilot CLI 1.0.109 | loadSession=true；无 `_meta.midTurnSteering`；image=true | 15 个 `acp-models`，当前 `claude-haiku-4.5` | 临时目录写 `p3c-accept.txt`=`ok`；1 次审批；3 turns | 显式 next-turn；`disposition=next-turn`；最终 `STEERED` | close 后 load 成功；replay 12 条 |
| Amp ACP 0.10.0 | loadSession=true；`sessionCapabilities.resume`；`_meta.midTurnSteering=true`；image=true | 4 个 `config:amp-mode`，当前 `low` | 临时目录写 `p3c-accept.txt`=`ok`；0 次审批；2 turns | native-inject；`disposition=steered`；最终 `STEERED` | close 后 load 成功；replay 7 条 |

证据：`design/agent-bridge/recordings/p3c/copilot-host.json`、
`amp-host.json`。原始 ACP initialize、session/new、任务文件、steer states、
resume/history 都在文件中；路径已脱敏为 `<workspace>/<host>/<home>`。
证据档位仍是 admission，不能声称 context-confirmed。

## Web 呈现核对

`scripts/smoke/agent-bridge/p3c-web-presentation.ts` 用现有
`UserMessageBlock` 渲染两个形状：

- Copilot next-turn：普通 `data-message-kind="user"` 消息；
- Amp native steer：`data-message-kind="steering"` 消息，pending/accepted 同一
  个组件。

脚本断言两种形状都可见，且文本中不出现 `native` / `inject` / 真 steer 假
标签；截图 `recordings/p3c/web-steer-presentation.png`。这证明现有 Web 组件
不会凭空制造 native 标签。**限制**：现有 Workbench 尚未订阅
`opencraft/steerEvidence/updated`，P3c 也没有把 canonical input 投影成
durable `steeringUserMessage`；因此这不是 Host→AppServer→Web 的端到端呈现，
只覆盖组件语义。

## 缺口

- `history/read` 是 bridge 的 native replay 分页，不是 AppServer 历史查询；
  Host 尚未把 replay 注入现有 `thread/read`/Web 历史。
- `elicitation` 只进 Host outbox/interaction，Web/Electron/Expo 尚无表单 UI。
- `model/list` 只提供目录，不包含 UI 选择器或账号价目校验；Amp 的
  `config:amp-mode` 是模式路由，不是精确模型 id。
- ACP `mcp/*`、fork/checkpoint 未实现；`fs/terminal` 的权限模式按上表收窄，
  但没有为它们增加独立的用户审批卡。
- 真实任务通过 Host 的 bridge 进程执行，但 smoke 使用 local test backend，
  不是生产 sandbox 后端的隔离验收；Web 端到端呈现仍需后续接线批次。
- Amp 在首个 prompt 后拒绝 mode 变更；resume 时若请求不同模式会明确失败，
  不会静默改模式。
