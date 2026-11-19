# Single Thread command owner

ThreadOrchestrationBroker is the single command lifecycle owner for native Agent
CLI and hosted assistant requests. Headless creates one Broker and attaches Bot
admission through AssistantThreadAuthority. The legacy AssistantThreadCommands
constructor is a compatibility subclass only: no command implementation, engine
port, in-flight map or independent lifecycle lives there. Desktop/test callers
reach the same implementation. There is no new queue, database, permission grant
or fictitious parent Thread.

Bot authority retains claim/profile/takeover fencing and an expiring admission
projection. Existing assistant_thread_operations are preserved as the Bot command
receipt/claim binding, not migrated into execution-source tool operations or a
second native Thread identity. Root start and child spawn remain distinct; they
use the same native execution port and Collaboration input owner. This change
consolidates the command owner, not all historical schema rows into one table.
Native execution remains native-owned. Work-issued start/tell inputs now link to
their exact native Turn completion before the existing Work/report path wakes the
original assistant; a submission receipt alone can no longer satisfy that Work.

Reception discovery and execution Delegation now derive their tools from the
same pure resource catalog. A captured/current platform.threads resource exposes
thread_command to both Pi and Codex routing; read-only group discovery cannot
silently hide the authorized Thread command path. Per-command profile/admission
checks still run in Core. Old Work snapshots do not inherit new tools.

---

# 管家创建与跟进平台会话

管家通过 `thread_command` 工具或本地 CLI 操作真实平台会话。
两者共用 `@opencraft/appserver-protocol/thread-command` 的 argv 解析器及
`opencraft/personal-assistant/threads/command`。argv 是字符串数组，不进入 OS
shell，不展开 `$()`、环境变量、管道或重定向。原有 `opencraft thread spawn`
继续表示执行中的 Agent 创建子会话；管家的 `start` 创建独立会话，没有虚构的父会话。

## 用户入口

在“Agents → 我的助理 → 管理助理 → 助理任务授权”中选择一条自己可委托执行的会话，点击“允许创建任务”。
页面沿用 SettingsGroup/Row/ChoiceSelect/Button；页面滚动和边距仍由 People page 持有。
打开页面、登录、申领助理或选择下拉选项均不自动授权。保存才产生默认配置 `default`。

配置记录所选会话的工作目录、模型及执行权限快照，不保存模型凭据。更新使用 CAS revision，
使旧配置下的后续管家命令失效。现阶段只接本安装的 Codex Host，未知自定义权限配置拒绝保存；
没有授权配置时必须提示配置，不能自动借用管理员环境。桌面 Daemon 和 Headless 装配同一服务。

“停用任务授权”撤销后续管家操作及尚未被引擎接管的输入，不删除已经创建的会话，也不自动
终止已被引擎接管的工作。停止运行中的工作仍走原会话停止入口。停用、重申领助理后需要重新授权。

## 所有权

| 对象 | 唯一 owner |
| --- | --- |
| Bot/人类绑定与当前资格 | PersonalAssistants，现有 claim epoch |
| 执行配置、命令身份及回执 | Server 数据库中的 assistant_thread_profiles / assistant_thread_operations |
| 原生会话创建及未知结果恢复 | 现有 Engine Host 创建 operationId/fingerprint 回执 |
| 会话归属、可见性与输入来源 | 原 ThreadAccess / ThreadOrchestrationLedger / Collaboration |
| 输入排队和投递 | 现有 actor_execution_requests，不另建任务执行队列 |
| 管家 Work、结果和通知 | 原 Work / Execution / Completion / Reception；平台提交不等于任务完成 |

新会话以 Human 为 owner，Bot 为输入发起者，Human 为 delegator，私有且在正常会话列表可见。
Bot 能读用户可见的旧会话，但只有自己当前 claim 下创建的会话可以用此入口跟进。
用户直接接管后不再接受管家自动跟进；不会换一个新会话绕过接管或停止。

存储操作经过现有通信 Worker；新建会话访问策略在 Worker 提交后发布到权限投影。
原生 Host 在分配前建立发布屏障；创建回执返回后仍不向其他连接发布通知、列表或读响应。Hub 提交私有归属并安装权限投影后，显式释放发布屏障，再准入首条输入。旧 Host 不支持该能力时拒绝创建。
主线程仅持有在途请求和有截止时间的授权投影，不成为第二份业务状态。
授权投影在启动时从未完成输入重建，原队列扫描异步刷新；失效和未知状态拒绝准入；Worker 暂时不可用时保留原队列状态，已有授权只在原有效期内有效，不因错误续期；恢复后再核验。
配置变更/停用只使对应用户的旧投影失效，接管只影响对应会话，不清除其他用户的权限。现有 Collaboration 队列自身的历史同步读写仍是存量边界，
本改动没有宣称它已全部异步化。数据库结构由 Server 迁移 owner 生成。
原生创建完成时，即使助理已被停用，Host 仍登记原 Human 的私有会话归属；该完成记录入口
不暴露给 Bot，不恢复执行授权，也不发送任务。

## 命令

仅托管 Bot profile 有平台入口；纯独立 lab profile 不会凭空获得平台权限。
本地 socket 由已有 runner 持有；无需另起 shell/server 或复制 Human token。

```sh
opencraft-assistant thread --profile-dir "$BOT_PROFILE" profiles
opencraft-assistant thread --profile-dir "$BOT_PROFILE" start \
  --profile default --title '修复构建' --prompt '检查项目并修复构建错误' \
  --idempotency-key build-fix-1
opencraft-assistant thread --profile-dir "$BOT_PROFILE" list --owned --limit 20
opencraft-assistant thread --profile-dir "$BOT_PROFILE" output "$REFERENCE"
opencraft-assistant thread --profile-dir "$BOT_PROFILE" tell "$REFERENCE" \
  --message '补充回归验证' --idempotency-key build-followup-1
opencraft-assistant thread --profile-dir "$BOT_PROFILE" operation show "$OPERATION_ID"
```

模型工具接收同样的 `['thread', 'start', ...]` 数组，由 runtime 绑定当前 Work ID。
旧 Work 只保留创建时捕获的能力，不因安装新版获得新工具。工具调用前后检查 Work 与资源 binding。

- `start` / `tell` 必须提供稳定幂等键；同一键改内容、Work 或配置参数会拒绝。
- 超时/连接中断后用相同 argv 和键重试。创建已发生则恢复同一会话，发送已接受则读取原队列回执。
- `operation show` 提供命令状态与已有输入投递状态。`submitted` 不是工作完成，也不保证模型成功。
- `output` 返回有界历史、下一页游标和引擎状态；历史为不可信外部内容。追加 `--cursor` 追读。
- 运行中补充使用 `tell --delivery steer --expected-turn TURN_ID`；只能修改当前授权下自己创建的、仍在该轮执行的任务。过期/等待输入/已停止/被接管的轮次明确拒绝，不降级成 queue，不新建替代任务。
- 不支持停止任意会话、修改成员、替用户批准审批或任意选择 cwd/model。
- Work 取消阻止新的工具调用及迟到结果写入；已被平台接受的独立会话不会因 Work 生命周期自动删除。
- Work 工具发起的 start/tell 自动关联具体输入和 Turn 结果，再进入原 Work/Reception 回报流程；CLI 未携带 Work 的独立命令仍通过显式查询跟进。这不是新增 Goal 或全局调度器。

## 验证入口

`tests/identity/assistant-thread-commands.test.ts` 验证真实 Server Worker、存储、授权及队列；
原生创建是可控替身，用来覆盖失联与撤权竞态。
`test/thread-command.test.mjs` 验证真实 CLI/socket、工具作用域。
`test/codex-execution.test.mjs` 的动态 thread tool 用真实 Codex 进程连接本地模型响应替身，
检查平台引用和 Work 身份，未调用真实付费模型。
`scripts/smoke/execution/smoke-personal-assistant.ts` 在实际 Workbench 的“大家”页面验证
浅/深主题、宽屏键鼠及窄屏触控、显式授权与撤销；账号和引擎为测试替身，不等于线上登录或物理手机验收。


## Live supplements

A user correction to a running task is not an instruction to wait for its next turn.
The assistant first reads `thread output REF`, then uses the observed active
`state.turnId` with `thread tell REF --delivery steer --expected-turn TURN_ID
--message TEXT --idempotency-key KEY`. This targets the same native Thread/Turn;
it does not interrupt/recreate the task or allocate another Thread. Normal queue
follow-up remains available for intentionally later work; bare tell retains its
legacy queue semantics for compatibility.

Server admission persists the exact delivery mode/expected turn in the existing
fingerprinted operation. The storage Worker derives execution intent from that
operation, not a send-mode override. Current claim/profile/source grants, native
ownership and the Human takeover fence are checked before handoff and native claim.
Steering is allowed only for the observed active turn, never a pending approval or
question. A race that changes the turn is rejected by native exact-turn injection;
there is no fallback to queue or new-task creation.

The immediate receipt reports `inputMode: steer`, `expectedTurnId`,
`delivery: accepted`, `taskOutcome: unknown`. Inspect `operation show` for
`input.deliveryState`: only `injected` confirms native injection, not that the
model has complied or completed. An unknown outcome must be reconciled with the
original key/arguments; replays cannot change content or retarget a new turn.
Distinct supplements retain distinct durable queue IDs rather than replacing a
single in-memory pending-message slot. Supplied ordinary text is not new authority.

The model tool, shared execution instruction, reception routing guidance and CLI
help advertise this capability. This change does not add a new Work lifecycle or
change the local Work.instruct next-settled-turn contract. It addresses immediate
control of delegated platform Threads, not arbitrary permission approval.


## Work 委托结果自动回流

Execution 在 RPC 前记录最小的执行→平台操作关系，固定原 Work/revision/execution、argv 与幂等键。发送到 Core 的键由 execution 身份隔离，不让后续执行复用模型短键串到旧任务。未知提交只使用原意图对账；不会分配新键或新 Thread。

执行器的暂存回答不是 execution_report，也不是完成证据。仍有未决平台输入时，Work 保留未完成状态并释放本机模型名额，Goal 并发限制仍计入该 Work；重启不重跑已经暂存的模型回答。运行时沿原 pump 有界对账，不持有第二份任务状态。

原生 Host 只从该输入的持久 admission、targetTurnId 和确切 Turn 的终态及有界 Items 返回 completion。新 Turn、未确认注入、普通线程 latest 状态都不能代替它。终态文本是外部不可信内容，截断明确标记。旧 Host 或越过有界历史时显式说明无法确认，不伪造成功，也不自动替换任务。

全部关联输入结算后，Execution 将原暂存说明及确切原生证据交给原 report→Reception→Completion/Outcome/Delivery 流程，同一执行最多一个不可变报告与一个父回合。失败、取消、拒绝和无法确认进入失败复核，不被提交说明覆盖成成功；有新要求、取消、接管、撤权或 Goal 暂停时重新校验。

私有助理 schema21 只新增 Execution 所有的关系及暂存回答表；Core schema 不变。它们不是新的原生 Thread、输入队列或工作调度器。历史已完成或没有关系记录的工作不回填、不重放。回退旧代码前须核对 schema 和未决关系，禁止通过恢复旧数据库丢弃新写入。
