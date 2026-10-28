# Legacy DSH owner handoff

独立 DSH Host 的进程交接使用私有 descriptor 中 `ownerHandoff.protocol=1` 的控制入口。
这是单 writer 的排空协议；不提供跨引擎热迁移，也不注册完整应用升级 recipe。
首次从无协议版本迁入仍是维护中断，不追认为旧版本的原子排空。

## Authority 与准入

原生固定起点为 DSH `0.1.1-rc.2` 加随包的 owner admission 补丁。
启动前逐项验证原生 RPC、Agent send、Inbox mutation、driver wake/后续 Turn、工具 dispatch/journal 的钩子。
缺任一钩子或版本未知就拒绝启动交接 owner，不用网关的空闲状态推断原生空闲。

Host 在加载任何 store 前取得独占内核锁；持久协议记录 operationId、epoch、fence、sourceOwner 和当前 owner。
fence 同时关闭 Host RPC/IM 输入、内部 schedule/recovery、Tasks 私有端口和原生执行入口。
已开始的 Turn 自然完成，内部后续输入停放在持久 inbox；不清空 queue/goal 或自动续发。
直接原生 RPC 和经聚合转发的请求使用同一原生 authority；消费者连接断开不证明输入未接纳。
原生 bridge 中在途操作、原生 Agent、全部历史未闭 Turn、inbox、审批、job、Host journal、queue、schedule/recovery 及 OS 子进程共同参与计数。
读取失败、超时、未知拓扑或损坏均为 unknown。
Host→Pi/直连网关的结果另持久登记消费者lease；只有消费方匹配自身请求并完成处理后返回的精确receipt才能退休，迟到或丢失结果不自动确认。IM使用相同的确认边界。

原生可执行 RPC 在动作前持久 custody，在结果后生成精确 receipt。
消费者解析实际响应后确认该 rpcId/receipt，缺确认时不重复执行，也不因取消另一个请求而退休原输入。
原生工具在 dispatch 前持久登记，在成功结果写入并 flush 原生日志后退休；错误、超时、abort 或未写入日志的结果继续阻止 release。
该首版保守地保留所有错误工具结果，不能据错误文案判断副作用是否发生。
没有通用强制清零接口。

初始化模型配置有单独的私有 bootstrap 凭证，仅允许受限模型 namespace 与执行凭据引用，
在公开 Host 准入前永久封闭。它不能提交输入、创建 Agent 或恢复 Turn。
交接期间不能热重载原生 owner 插件；需要完整进程生命周期。原生意外退出会持久关闭Host准入，不沿旧restartEngine路径创建新generation或自动重放；未确认工作保留，需有证据的维护处理。

## 控制顺序

| 动作 | 必须成立 |
| --- | --- |
| inspect | 同一原生 owner 和本 Host/OS 的完整观察；不是 Web idle |
| fence | expectedOwner/epoch CAS，持久关闭新准入；保留全部工作事实 |
| release | fenced 且完整计数为零；停止原生与 Host store，复核 OS 无余留；持久 released |
| cold-ready | 旧 writer 已 released 且进程退出释放内核锁；新 owner 冷读当前数据，计算 identity |
| resume | 同一新 owner、operation/epoch/fence 和重算后的完整 proof 一致；然后恢复准入 |

最终release先在原生authority封闭包括读取、取消与私有bridge的全部入口，再取得排空快照并停止writer；不能拿封闭前的快照放行。尚未开始停writer的拒绝会恢复fenced下的对账入口。
IM消费者custody仅在取得Host准入后创建，确定被fence拒绝的输入不产生未知租约。

控制监听器与 Host RPC 分开，释放 Host 不会等待正在处理 release 的 HTTP 请求自身。
旧进程仍须由现有监督器停止，确认内核锁释放后才能启动继任。
旧 writer 未确认释放、继任崩溃或 proof 变化时保持关闭；不能拿旧 cold-ready 证明为另一进程放行。

## 冷读取清单与兼容边界

两个消费者 profile 都读取同一份 DSH 原生数据；聚合消费者另有自己的租约，聚合空闲不能替代 DSH authority。
冷 proof 绑定 Node/ABI、固定入口摘要、完整配置摘要、machineId、Host与原生incarnation、原生effective settings、新 owner、所有资源与原生历史摘要。模型配置和执行凭据须仍等于本进程实际应用的内容；私有配置/认证附件在启动后变化则拒绝。

- Host 全部 SQLite store（routing、threads、executions、documents、connectors、tasks、schedule/recovery）：quick_check 与全表读取；不靠空库测试推断旧库兼容。
- 原生全部持久 session：由原生 reader 解码历史与 Inbox/goal/审批/Turn，完整摘要与计数；fork inbox仅折叠seedLength之后自有事件。物理历史中缺失或无效header拒绝完整证明，不能沿用reader静默跳过行为；文件 hash 不代替 native decoding。
- 数据目录中附件、checkpoint、配置、插件/profile；共享 models/projects、持久 skills；原生固定运行时及插件闭包。
- 符号链接只允许落在声明的资源/依赖闭包内，逐一绑定链接与目标内容；闭包外、循环、特殊文件或缺失资源拒绝。
- owner 进程标记/锁和易变 SQLite WAL/SHM 不是内容 proof；SQLite 当前逻辑内容已经由只读连接完整读取。

仅验证该固定起点和当前实际历史/插件/配置组合。未知版本、任意 ABI、任意自定义插件及反向读写兼容不自动成立。
未完成输入、未来或暂停 schedule、待审批及在途 unknown custody 保留并阻止安全 release。已终结历史未知按下节移交责任。
空闲 goal（包括 active/paused/blocked）是持久意图，完整读取并纳入历史 proof，但不单独增加执行占用。
fence 期间不起新 Turn；已有 goal 不续跑。继任保留 goal 原 phase，冷加载保持 disarmed，
恢复准入后的行为与正常重启相同，不隐式 arm、清除或重放 goal。若 goal 已产生 Turn、inbox 或未确认结果，仍按对应执行事实阻止 release。
冷 ready 是恢复准入条件，不是回滚数据的授权；不自动回灌旧备份。

## 旧历史的只读恢复视图

冷数据使用原生 `sessionPersistence.inspect` 的确定性逻辑视图，与正常重启及历史 API 一致：中断尾部的结束事件只在内存投影，不写回物理日志。proof 同时绑定逻辑历史和 `storedEvents/storedDigest`，保留原物理事件，不加载 Agent 或重放输入。活着的 Session/Agent 仍观察实际事件，未结束 Turn 继续阻挡交接；原生 custody 中的未知结果也不因逻辑恢复而消失。

Host 队列沿 `ThreadQueueStore` 的终态语义：`deleted` 与 `dispatched` 都是保留记录，不计待执行工作；仍为 `queued` 的记录继续阻挡。观察过程不删除记录、不变更状态。

`TOOL_OUTCOME_UNKNOWN` 是原生工具未确认副作用的明确记录；无论来自只读恢复投影还是已保留的物理历史，均在 `unknownResults` 单独计数并阻止交接。`storedDigest` 只是数据完整性证据，不能代替副作用确认；关闭Turn的逻辑投影、重试成功或没有新custody ledger都不会消除旧未知结果。没有通用强清或自动重试。


## 已终结未知结果的责任移交

历史 `TOOL_OUTCOME_UNKNOWN` 继续保持未知，不确认成功、不确认失败、不清空、不重放，不改物理日志。
原生观察保留 `unknownResults`，并仅对所在逻辑 Turn 已结束、无运行 Agent 和未闭 Turn 的结果给出 `transferableUnknown`。
每项精确记录 `sessionId/resultSeq/toolCallSeq/storedEvents/storedDigest`，工具调用必须与结果所属 Turn 和 callId 匹配。
原生 custody、Host 输入、工具进程、jobs、Inbox、审批等独立执行事实照旧阻挡，不能靠历史清单抵消。

旧 owner 封闭全部原生入口，最终观察排空，在停止 writer 后、持久标记 released 前写入私有持久 `carried-unknown.json`。
回执绑定 epoch、operationId、fence、sourceOwner 和完整有序清单；写入失败不能声明 released。
新 owner 冷读的清单必须与该回执逐项、逐摘要完全一致；缺失、新增、减少、摘要或代次变化均拒绝 cold-ready/resume。
匹配的历史未知从 Host 总 `activeCount` 中扣除，单列 `carriedUnknown`；原生原始 `unknownResults` 及记录继续保留。
之后每次协议交接重新封存完整责任清单，不把一次迁入的豁免沿用到后继未知。
首次无协议维护桥接由维护执行器在确认旧 writer 及其整个 cgroup 已退出、只读冷读取后写入同样绑定的回执；不追认旧版原子 fence。

同一已恢复准入的 writer 再次 fence 时，在内存保留先前已接收的精确责任回执；仅当前 writer 的 fenced 阶段且清单、回执文件均未变化时继续单列 carriedUnknown，不因新 fence 代次而误计回占用。release 仍重写绑定新代次的封存回执，继任 cold-ready/resume 仍只接受该新代次，不能复用旧证明。

## 普通引擎崩溃与交接崩溃

同一存活 Host 的 open/ready owner 遇到 native 引擎意外退出时，沿既有有界重启预算重建引擎、路由代次和流连接，重新完成 bootstrap sealing 与 native admission 后恢复 health。自动恢复与 fence/release 共用控制队列；队列中 fence 先完成时不允许恢复重开写入。已经 fenced、released、cold-ready 或持久化未知时仍保持 recovery-required。恢复失败才将 open owner 持久 fence，不能把正常崩溃直接当成交接释放不明。手动 restartEngine 仍拒绝绕过交接。
