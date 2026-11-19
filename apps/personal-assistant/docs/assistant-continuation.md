# 主助理续接的跨模块约定与实现

2026-11-03用户先要求更新AGENTS联盟，随后要求实现；提出人身份未确认。本轮续接实现基于0.8.0/schema11；0.9.0/schema12另增[运行保护与用量](runtime-guardrails.md)，仍为独立无界面runner，development。入口见[模块地图](module-map.md)，验证见[本轮记录](iterations/0013-continuation.md)。

## 已接通的链路

```text
用户输入 → 接待模型提出有限命令 → 原业务owner校验并执行
              ↓
       工作/原请求/相关背景固定到Execution
              ↓
       Pi执行 → 不可变执行报告
              ↓
报告 + 系统接待turn + awaiting_review同事务保存
              ↓
原主助理的新回合 → 继续 / 交付 / 静默 / 说明阻塞
              ↓
原Work/Completion/Outcome/Notification服务分别结算
```

新工作默认要求真实笔记；明确completion.output=text时不自动添加笔记条件，仍执行其他显式检查。CompletionContract为新定义采用schema2，旧工作与旧执行快照保持原语义，不补造历史报告或完成依据。所有合格结果仍经本地mailbox接受后结算，静默不等于渠道接受或用户已读。

主会话没有关联的CLI工作或默认静默routine继续使用原本地结果流程，不自动借用最近活跃会话。关联主会话的工作才通过系统turn唤醒主助理。父回合是原ReceptionModel协议的新调用，使用同一主Conversation的上下文；不新增另一个万能manager或额外原生Pi会话。

## 状态与所有权

| 边界         | 唯一职责                              | 已实现协作                                                                              |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------------------- |
| 用户命令     | ReceptionService协调，原命令owner提交 | 原单命令与最多4项非嵌套batch；同一事务提交命令、回执与turn                              |
| 安排命令     | RoutineService                        | interval安排创建/暂停/恢复；模型提供结构化参数，原服务校验revision和实际回执            |
| 委托上下文   | 接待构建，ExecutionLedger保存         | request.original、最新用户修正、有界相关消息；自动续接保留上一报告的引用和截断摘要      |
| 执行报告     | ExecutionService经ExecutionLedger     | execution_report按执行身份唯一且不可变；正常返回和error分型，保留原work/revision        |
| 完成依据     | CompletionService经CompletionLedger   | 报告接收时登记实际检查，主助理交付时再次核验；semanticReview仍为unverified              |
| 工作生命周期 | WorkService                           | 新增awaiting_review，不再被work调度器当作待执行；continue经amend产生新revision          |
| 报告消费     | ReceptionService                      | source_json区分系统来源，持久排队、接收、重试、结算；events保留审计，不独立充当可靠队列 |
| 结果与交付   | OutcomeService经OutcomeLedger         | Result保留原执行报告，Delivery可另存主助理整理的回应；稳定身份和接受回执不变            |
| 通知         | NotificationService                   | 原always/never/changed、去重和合并继续生效；silent抑制主聊天通知，不伪造交付            |
| 调度         | runtime                               | 同一主助理回合串行；优先用户，连续3个用户回合后给等待的背景回合一次机会                 |

源码落点：execution-service/ledger、reception-service、reception/context-builder/query-service/planner、domain/continuation、outcome-service/ledger、notification-service、runtime的work/reception coordinator和local-runner。各目录AGENTS继承本约定；没有为了地图复制第二套实现或建空模块。

## 边界与恢复

- 报告、系统turn和awaiting_review同UoW提交；模型请求在事务外。主助理决策、子命令、结果/交付和turn结算也在同一UoW提交。
- 系统turn保存原主会话、报告/执行/work/revision引用、原通知来源、用户是否等待、完成检查、原请求与历史锚点；不经say冒充用户，不刷新Attention，也不进入用户事实的MemoryLearning.capture。
- query grant继承原工作资源；换根后不能获得新资料。report.read仅返回当前会话关联工作报告，可分页且受原查询次数/大小约束。原始报告至多100万字符，模型初始摘要6000字符并标明截断。
- 重复报告不创建第二个系统turn，身份冲突拒绝覆盖；重复父决策不重复创建revision、Result或Delivery。修改/取消后旧turn退役，迟到报告只保留审计，不能完成新目标。
- 自动续接最多3次，计数保存在请求快照，重启不清零；新显式用户修改开始新的有限续接链。父回合处理失败最多3次，有退避；耗尽后保留报告并阻塞工作，需新的用户修改才能继续。
- 用户等待的结果不能用silent丢弃。quiet结果可静默：检查合格则创建抑制主聊天通知的本地交付，接受后才完成；失败则保留blocked，没有假交付。quiet阻塞不会被直接发成用户等待的回答。
- 原生Pi requestId与checkpoint继续归Pi；报告已保存的工作不因重启重跑。宿主关闭挂起，取消/修改仍走原Pi中止和revision边界。
- pump现按阶段隔离同步错误并有界退避；phaseErrors显示当前阶段故障，恢复后清除该项。其他阶段继续，不通过吞错伪装健康。此退避不是持久执行预算。

## 协议示例

用户输入的模型提议可为：

```json
{
  "kind": "batch",
  "commands": [
    {
      "kind": "delegate",
      "goal": "比较方案",
      "completion": { "output": "text" }
    },
    {
      "kind": "delegate",
      "goal": "整理风险",
      "completion": { "output": "text" }
    }
  ]
}
```

系统报告回合只允许一个决策：

```json
{ "kind": "continue", "goal": "补齐缺失依据并保留原要求" }
```

也可为deliver（可选text）、silent或blocked（必填text）。这些仍是有限结构化提议，不是向模型开放任意服务/方法；提交时由宿主验证原归属、revision、完成条件和通知约束。提示词已在实际ReceptionModel请求入口装配，AGENTS本身不自动进入模型。

fixture增加“每隔30秒提醒我检查项目”的演示分支。任意自然语言时区、日历重复、歧义处理和真实模型判断质量尚未验收；不要把interval协议支持宣传为完整日程能力。

## 验证与未完成范围

专项test/continuation.test.mjs覆盖真实SQLite事务、报告重开、重复与迟到、失败/quiet、有限批量与修改、真实Pi回流/文本输出、两处真实进程崩溃、真实say CLI安排命令、schema10升级和阶段故障隔离。原schema1/2/3/4迁移用例继续回归。完整命令与结果见[迭代记录](iterations/0013-continuation.md)。

模型为fixture或受控响应；实际Pi和本地文件/socket/CLI/子进程不等于真实模型验收。未接远程IM、OAuth业务工具或OpenCraft平台权威，未部署Join。局部执行上限/用量可见性、长时间运行、日历/时区自然语言与真实模型内容质量继续列入[roadmap](roadmap.md)。按用户最新[投入边界](runtime-guardrails.md)，统一金额预算不作为当前前置。

## 研究来源

参考非官方Grok Bot 0.18 reconstructed and extended源码，固定提交a9f633e09d49a85829b8236331b9e21f7e612634；不是官方原始源码或官方应用运行验证。本机研究记录在`/data/output/grokbot-architecture-20261102/stitching.md`。

其完整multitask提示段未由当前装配入口传入，delivered可对应0条可见消息，部分完成队列使用内存Map。本实现吸收“完成结果重新唤醒父助理”的机制，自行保留持久消费、独立状态和真实本地接受边界，没有把重建源码或提示词定义当作已验证产品行为。

0.10.0已把执行桥/工具对app的依赖投影为窄port，结果报告与主助理结算仍走原owner；work验收场景独立覆盖报告处理、原问题重开和结果回原会话。具体见[分治实现](iterations/0015-module-boundaries.md)，不改变本页续接身份和事务协议。
