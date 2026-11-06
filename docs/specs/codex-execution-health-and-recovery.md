# Codex 执行环境健康检测、诊断与主动恢复

状态：用户已授权并实施源码；验证记录见本文末尾。尚未部署到实际服务。

## Problem Statement

Codex AppServer 仍能连接、读取会话和返回模型回答时，其共享执行环境可能已经失效，命令执行持续报 `exec-server transport disconnected`。仅检查连接或进程存活，会让用户误以为执行能力正常；反复发送消息也不能恢复工作。

本次已观察到同一 AppServer 下多条会话受影响，重启受影响实例后执行环境恢复。首次失效原因尚未确定，没有证据证明由 OpenCraft 或 Codex 中的哪一方导致。现有记录不足以还原执行器首次退出的原因。

## Solution

OpenCraft 检测并呈现实际执行能力，保存必要的执行器生命周期信息，并主动恢复已确认失效的执行环境。

优先使用 Codex 官方提供、且当前版本实际支持的局部恢复能力；无法局部恢复时，直接重启受影响的 AppServer 实例。**不把会话、轮次或后台任务自然空闲作为故障重启的前置条件，也不要求用户再次批准已确诊故障的恢复。** 恢复成功须由实际执行能力验证，不能仅凭进程启动或连接建立判定。

恢复失败后按退避间隔继续自动恢复；恢复期间用户新发的消息进入平台既有持久队列，恢复后执行。共享实例中的受影响任务明确显示为中断或结果未知，保留会话历史与工作区，不自动重放结果未知的输入或命令。恢复服务和查明首次失效原因并行推进。

## User Stories

1. 作为使用 Codex 的用户，我希望平台能区分会话连接正常与执行环境可用，以便及时知道命令是否可以执行。
2. 作为查看故障会话的用户，我希望看到准确、简短的执行不可用及恢复状态，同时仍能读取已有历史，以便理解当前能做什么。
3. 作为排障维护者，我希望获得执行器启动、退出和资源事件的必要信息，以便定位第一次失效的原因。
4. 作为执行环境已故障的用户，我希望平台主动恢复受影响实例，即使仍存在未完成轮次也不等待空闲，以便尽快继续工作。
5. 作为共享实例中的会话使用者，我希望恢复后历史和工作区保留，受中断或结果未知的工作有明确状态，且旧命令不会被自动重放，以便决定如何继续。

## Implementation Decisions

- 责任边界：Codex AppServer 拥有其内部执行器连接与执行逻辑；OpenCraft 拥有平台提供的沙盒条件、AppServer 实例生命周期、健康投影与故障恢复。平台不另造 Codex 内部执行器管理器。
- 健康检查观察官方 `environment/status` 等已支持的执行能力信号，区别于 AppServer 连接和进程存活。健康检查本身不启动或恢复执行器；独立恢复流程消费故障状态。
- 故障恢复优先选择当前 Codex 版本真实支持的官方能力。能力不存在或局部恢复不能恢复执行时，平台重启受影响的 AppServer，不以报错或收集日志替代恢复动作。
- 故障恢复与正常维护分开：正常升级的排空要求不能套用于已确认执行器故障的恢复。用户最终决定为：「执行器都已经故障了，这种情况下直接重启不用等待空闲吧。」不得重新加入等待空闲、人工批准或无限等待自然结束的前置步骤。
- 恢复范围以共享执行环境所属的 AppServer 实例为单位；该实例内所有受影响会话都参与状态更新。普通客户端断连不等于执行器故障，也不据此重启其他实例、账号服务或整站。
- 恢复前获取必要的现有状态与诊断信息，不把首次根因已查明作为恢复前置条件。诊断包括时间、所属实例及执行器身份、启动结果、可观察的退出码或信号、资源限制事件；不可观察的原因保持未知，不推测为 OOM、Codex 缺陷或平台缺陷。
- 优先复用并核对已有执行健康与生命周期记录能力，确认其在实际运行实例生效。较新源码已有实现不代表历史保留实例已经采用，不能重复搭建平行机制。
- 受影响轮次明确终止或标记中断；不能确认副作用结果的工作保留结果未知。用户已认可的恢复方案包括「不自动重放结果未知的命令」，该要求不扩展为新增审计平台或额外审批流程。
- 线上恢复检查使用新实例初始化、官方执行环境状态与同环境信息探测；真实工具执行通过隔离合成模型触发普通 Turn 验证，不能用宿主本机的 standalone command 接口冒充同环境执行，也不为线上健康检查额外调用付费模型。
- 根因修复落在实际责任层：平台原因修复平台；Codex 原因提供最小复现并验证上游修复版本。无论责任在哪，平台均承担恢复服务的动作。

## Testing Decisions

测试断言用户或调用方可观察的健康结果、恢复动作的作用范围、命令结果和会话连续性，不以调用次数、私有字段或代码中出现某个条件代替行为验收。

优先复用 Codex Core 的控制 API 与原生 Unix WebSocket 集成夹具、沙盒引擎运行时与生命周期测试边界。现有先例包括 “Core reconnect publishes ready only after the new native initialize finishes”、“stdio EOF reaches the bounded process and cleanup waits for its whole environment” 及 “systemd lifecycle observes actual service exit code and explicit environment stop”。这些边界在较新实现中存在，实施时核对最终目标基线；当前 checkout 也已有 Codex Core 控制 API 与连接恢复测试。

客户端只为“连接正常、执行失效并最终恢复”的主路径增加一个浏览器场景；故障分支、活动轮次与未知结果等语义在 API/集成边界验证。下表为拟定验收边界，尚未获得针对测试边界的单独反馈，不增加实施审批步骤。

| Story | Boundary | Risk | Proven by |
| --- | --- | --- | --- |
| 1 | api | AppServer 仍能连接和读取历史时，执行器失效被错误报告为健康 | 场景「连接存活但执行环境断连」：保持原生连接可读，令执行环境不可用，控制 API 和 Host 健康投影报告执行不可用；只读检测不启动或重启进程 |
| 2 | browser e2e | 用户只看到正常连接或无限等待，无法识别执行故障与恢复 | 场景「可读历史、执行故障与恢复」：页面仍呈现原历史，给出简短执行不可用/恢复反馈，恢复后清除故障状态并可继续使用 |
| 3 | integration | 执行器退出后仅剩通用断连文本，不能区分启动失败、退出及资源事件 | 场景「执行器生命周期诊断」：分别触发已知启动失败、已知退出及可观察资源事件，读取与对应实例关联的必要记录；未知退出原因仍显示未知 |
| 4 | integration | 故障实例因仍有轮次或后台任务而永远无法恢复，或只重启连接而没有恢复执行 | 场景「执行故障期间有未完成工作」：保持该实例轮次未结束、无空闲信号，确认执行器失效且局部恢复不可用后，平台直接恢复该实例；恢复后同一执行环境中的无副作用命令成功；其他实例及账号服务保持运行 |
| 5 | integration | 重启丢失会话或工作区、挂起轮次假装继续运行，或未知命令被重放产生重复副作用 | 场景「共享实例故障恢复连续性」：两个会话共用故障实例，其中有未完成及结果未知工作；恢复后历史与工作区保留、受影响状态明确、原命令未重放，新提交命令正常完成 |

人工终止执行器可用于上述故障恢复回归，但不能宣称复现或解释本次首次失效的原因。

## Out of Scope

- 在缺少证据时认定本次故障由 OpenCraft、Codex 或 OOM 导致。
- 重写 Codex 的执行器、内部协议或内部连接管理器。
- 将正常部署和升级统一改为强制重启；本规格的直接恢复规则针对已确认的执行环境故障。
- 自动重放结果未知的业务命令，或代替原会话继续发布、审批等业务操作。
- 新建通用审计平台、额外用户审批或与本故障无关的整站改造。

## Further Notes

本规格记录恢复后的产品改进需求与已完成的源码实现，尚未部署。首次失效根因仍待调查；实际根因修复须以复现和相关回归证据为依据。

项目未提供 Issue 跟踪器契约及标签约定，故本稿没有创建 Issue 或设置 `ready-for-agent`。配置完成后按项目契约发布本规格。

实施前确认：用户已选择持续退避恢复、恢复期间新输入持久排队。用户进一步确认：在确认旧实例退出、执行环境恢复后，保留旧消息的结果未知记录，但放行用户明确新发的消息；旧消息不重放。

## Implemented contract

- Managed generation owners check `environment/status` without inference. `/health` reports failed execution; `/native-health` retains readable Native connectivity. Unsupported/timeout status remains unknown and does not by itself authorize destructive recovery. A newly observed executor exit in the current owner's runner log is separate positive failure evidence, so a stuck Native status RPC cannot hide a known executor death. The log reader uses asynchronous, bounded reads and ignores prior-owner history.
- A confirmed disconnected execution environment records its source identity before stopping it. Source PID birth and systemd invocation distinguish the original owner from a successor. Fault stop resumes after controller replacement, escalates within a bounded interval and does not require idle. A surviving or unconfirmed source keeps admission blocked.
- `execution-recovery.json` retains recovery ID, fixed affected conversation IDs, original source identity, the latest verified replacement identity, attempt and backoff across controller replacement. The initial interval is one second, capped at thirty seconds; monitor cadence can delay a due retry. Confirmed recovery requires the original source to be gone and the replacement environment ready.
- Host fault writes run in an owned Worker. It seals execution leases and old delivery uncertainty, cancels old interrupted/provider retry chains, commits per-fault receipts, then acknowledges. Failed writes keep execution blocked and are retried. Re-observing a completed receipt after Host replacement does not interrupt later work.
- Existing conversations accept new, explicitly submitted inputs through the durable Host queue during recovery. Client routing uses affected conversation identities rather than treating every conversation on the Host as failed. Queue release follows committed recovery; sealed unknown records remain visible and are excluded from automatic replay and reconciliation.
- The normal upgrade drain and external attach-only lifecycle are unchanged. Existing synchronous registry/Host queue code remains a separately tracked storage migration boundary; this change's new fault journal and fault transitions do not add a synchronous storage writer to the connection loop.
- UI follows the existing Chat reading axis, Composer queue and non-blocking Workbench notice owner. Recovery feedback does not replace history or Composer; automatic waits do not offer a manual Resume action. Connection and execution remain separate states.

## Validation record

Focused API/integration coverage includes a live Native with disconnected execution, bounded source stop, busy-instance recovery, durable backoff, storage lock responsiveness, receipt replay, new-message admission, unaffected instances, unknown history and disabled automatic continuation. Browser acceptance uses the real Conversation, Composer, Runtime and notification components with a deterministic remote boundary at desktop/touch sizes in light/dark themes. This is browser/component acceptance, not a deployed Join session or native-device acceptance.

The repository-wide gate was attempted. Its startup check fails in the unchanged Expo SDK dependency contract. Two Headless queue integration cases also fail on the original upstream baseline; the baseline was separately checked and the temporary comparison checkout removed. These pre-existing failures must not be reported as passing.

The real native smoke passed with Codex CLI 0.166.0 and a loopback synthetic model: a normal Turn tool executed once, the shared executor was killed while another Turn remained unfinished, Native history remained readable, the managed AppServer was replaced without idle, and the next normal Turn tool executed once in the same workspace/HOME. This deliberately injected failure does not explain the original incident.

Independent review found five actionable recovery issues. Regression coverage now fixes affected scopes at fault creation, clears superseded failed commit stages, records/replaces failed replacement owners, keeps routed history readable during recovery, and preserves a preflight rejection's not-submitted proof through the relay and Host queue. A completed receipt also leaves later Turns intact after Host replacement.

The initial focused suite passed 226 tests; the affected Codex Core, daemon,
Workbench Web and CLI type checks passed; boundary/i18n checks and packaged
Headless/Worker acceptance passed. Four browser combinations covered desktop
and touch input in light/dark themes, preserving history, row identity and an
unsent Composer draft while queuing exactly one explicit new input.

The current full-gate blocker is specifically `react-native-worklets` outside the
installed Expo SDK's declared range. This task did not change mobile dependencies
or lockfiles. The two separately reproduced baseline Headless failures concern
session-tool reconfiguration while another Native subscriber remains attached.

Controller continuation also checks fault-scoped Router custody. Callback,
command and process leases retain their unknown evidence and fault association;
releasing Router custody never claims Native success. A new controller remains
closed until the durable journal explains every current unresolved lease by its
exact generation/incarnation. Unattributed or unrelated uncertainty keeps the
existing explicit-recovery requirement. A completed fault remains restartable
without replay. If the source unit is still deactivating, startup skips ordinary
ensure for that recovering generation, honors retryAt and starts its recovery
monitor so the bounded source stop can finish. Historical fault source evidence
remains durable across repeated incidents so a later fault cannot erase the
proof needed to explain an earlier unknown lease. Only the latest fault per
generation is projected to Host recovery status.

The second independent review identified the Router restart and deactivating-unit
startup gaps described above. Both were fixed and covered by the subsequent
69-test controller suite. Final focused checks also covered superseded Host
commit failures and unsent queued start/steer custody. Packaged Router evidence
readers passed in ESM and CJS; final affected-workspace type checks and boundary
checks passed. These follow-up fixes were not submitted to a third independent
review round.
