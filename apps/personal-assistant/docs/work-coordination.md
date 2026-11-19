# 多工作协调的最小闭环

用户随后要求不以“最小”为最终目标。本页保留已实现能力；Grokbot 源码对照与更完整的长期协调设计见[后续研究](grokbot-coordination-design.md)，其中建议项尚未实现。

主助理使用现有 Work 账本管理多项工作，每次用户输入和执行报告唤醒都读取当前状态。没有新增 Todo 表、Goal 管理器或数据库迁移。工作会话仍属于各自 Execution；主会话通过 conversation_work 关联可见工作。

## 概览与查询

接待上下文新增 `workOverview`：统计当前主会话关联的全部工作，按实际状态计数。`open` 排除 completed/cancelled；`attention` 最多六项，依次优先展示 waiting_input、blocked、awaiting_review、awaiting_delivery、running、queued，同状态按更新时间倒序。这个排序是注意力提示，不是用户设置的业务优先级，也不改变执行调度。

`attentionTruncated` 表示还有其他未完工作。`works` 是 attention 的兼容别名，不再把按 ID 排序的前六项当成全部工作。主助理可用以下只读查询补全：

- `work.overview {}`：刷新全量计数和有界注意力列表。
- `works.list {state?,query?,after?,limit?}`：state 为 all/open/closed，默认 all；query 匹配目标文字的连续子串或完整 Work ID。按 ID 分页，最多 12 项，不把某页长度当总数。
- `work.get {workId}`：指定工作、完成条件和投递状态。
- `questions.list {workId?,after?,limit?}`：只看当前版本、仍 waiting_input 的待答问题，可按工作筛选。敏感等待保留原有类型与专用完成路径。

session 仅暴露当前执行的 ID、引擎、状态及是否已绑定原生会话，不暴露原生线程标识或路径，也不表示进程在线。完成指完成检查并经过原本地 mailbox 接受链路，不表示用户已读。旧版本执行不能冒充当前执行。

本地入口：

```sh
node bin/assistant.mjs overview --profile /absolute/profile
```

协议为 `{"op":"work.overview","params":{}}`。它只统计已关联主会话的工作；安静例行工作和未关联工作不因查询自动进入聊天。

## 定向跟进

```sh
node bin/assistant.mjs say --profile /absolute/profile \
  --work WORK_ID --revision 1 --id UNIQUE_INPUT_ID \
  --text '时间范围选本周，回答这个工作的待答问题。'
```

对应 `say` 的参数为 `text,workId?,expectedRevision?`。接收前校验会话归属和指定版本，随后在已有 query_scope_json 捕获目标及当时版本；未显式指定版本时也捕获当前版本。失败不写用户历史或输入回执。重复相同 inputId 仍沿原 InputInbox 幂等处理。

上下文的 `targetWork` 包含当前状态、捕获版本和 changedSinceIntake；指定目标的问题不会被其他工作的首屏问题挤掉。提交阶段从持久 turn 重新读取约束，只允许回复、澄清、发送回复、回答/拒绝目标问题、修改/取消目标工作。批量命令也受同一约束并原子提交。不能借一次定向跟进新建其他工作、改另一个工作，或自动换到新版本。

自然语言提到明确 ID/名称仍由主模型结合只读查询解析；含糊的“那个”需要澄清。模型可能误解，host 的定向约束不等于已解决全部指代理解。

三种行为要区分：

- 回答问题：InteractionService 记录实际回答，恢复原 Work/revision/原生会话。
- 修改目标：WorkService 保留 Work ID，增加 revision，退役旧问题和执行，新执行使用新原生会话。
- 查询进展：只读并回复，不创建委托，不改变完成状态。

通用“向正在运行的原生线程追加消息”、用户优先级、依赖 DAG、跨项目目标聚合及任意外部会话控制均未加入。不能把此闭环称为完整长期目标调度器。

## 所有权与验证

ReceptionQueries 与 SQLite ReadModel 只提供有界投影；ReceptionService 拥有输入约束和提议结算；Work/Execution/Interaction/Outcome 保留原写入者。模型和网络调用不进入同步事务。

接待的 Codex 线协议使用平铺的可空字段记录；宿主去掉 null 后仍按原有带 kind 的命令联合严格校验，再交原应用 owner。平铺仅用于生成语法，不把命令分支、授权和版本检查交给提供方 schema。非空的跨分支字段、未知字段和缺少必填字段仍失败；旧 wire 可兼容读取。后台记忆/摘要协议不变。

机制测试：`node --test test/work-coordination.test.mjs`，覆盖历史挤占、分页/隔离、定向问题超出首屏、重开、错误目标/过时版本、原子回滚、系统唤醒、真实 CLI 和 Pi 等待续接。模型替身不证明语言质量。

显式真实模型入口：

```sh
node evaluation/work-coordination-probe.mjs \
  --codex-config /private/codex.json --output /new/private/run
```

该入口使主聊和执行均走 Codex，关闭自动记忆学习以隔离协调链路。真实主模型自行选择提议；同时创建 A/B、A 等待而 B 完成、重启、定向回答 A、定向修改 B、汇总状态。失败保留原始 profile/回合，不自动人工纠正或重跑取最好值；传输自身仍保留一次语法纠正。它不产 benchmark 分数，也不证明复杂依赖或长期稳定性。首轮失败、诊断和修复后通过见[真实验收记录](../evaluation/WORK-COORDINATION-RESULTS-20261110.md)。
