# 接待命令生成与规划恢复

接待的输出是业务提议，只有 ReceptionService 能提交；Codex 不持有业务 owner，也没有本机工具。命令选型、参数生成与最终授权分开。

## 默认协议 selected-v2

CodexStructuredHarness 在同一个临时原生线程中执行两步：

1. 模型选择 operations。候选名称从同一个封闭命令契约派生，按宿主的用户/执行报告来源筛选；查询名称也分别选择。
2. 宿主给出所选命令的精确 schema，模型填写参数。单命令使用 proposal，最多四个可批量用户命令使用 command1…command4，解码成原有有序原子 batch。

选型没有业务效果。参数的 expectedRevision、interactionId 等成为对应 schema 的真正必填字段；未知字段、跨分支字段、缺失必填值仍拒绝，不默认填版本、不解析自然语言替代模型选择。schema 与解码共享定义，应用层继续验证来源、目标范围、CAS、完成条件和事务。

两步合计最多一次协议纠正，正常两次生成、最多三次。不会因为参数阶段选错命令而自动扩大分支或回退旧协议。参数缺少事实时，应在选型阶段选择查询。一次 modelRequest 覆盖整个选型/参数交换，原规划总截止也覆盖所有模型/查询回合；因此不能把每个原生 turn 解释成独立的 60 秒预算。

配置 harnesses.codex.structuredProtocol 可显式选 flat-v1 兼容旧平铺格式，缺省为 selected-v2。仅接待使用两步协议，记忆提炼、复核、摘要仍沿原 schema；持久执行工具契约不变。兼容模式不自动启用，性能和真实模型质量需分别验证。

## 报告上下文与重试

ReceptionQueries.reportGoal 从已有 SELECT-only port 为原工作所属 Goal 提供当前 criteria/revision、最多四项工作、分页游标及有界已接受证据。每份证据最多 1200 字符，整个 goalContext 最多 12000 字节；超限标明省略，不能当作完整事实。当前报告 candidateResultId 与已接受 evidence 分开，只有原子的 deliver 成功后才产生接受事实。

ReceptionPlanner 对失败报告重试，仅回放之前宿主记录的查询描述；在本次 grant 下重新读取，不复用旧响应。回放去重并计入原来的六次查询、总输出预算。当前模型轮次和三次报告尝试上限不变，没有新增工作/目标/执行状态 owner。

查询 trace 在每次查询完成后同步交给 coordinator。即使不合作的模型悬挂导致外层截止先发生，ReceptionService.failed 也能保存已完成的宿主查询；旧模型返回不能提交。用户输入不自动回放另一轮查询。

截止诊断区分 model-timeout（一次模型交换）和 planning-timeout（整轮模型/查询规划）。两者当前共用原 runPolicy.modelTimeoutMs 数值；这次没有扩大预算。OTel 只记录阶段、固定错误码和 schema 字段路径，不记录正文、原始响应或凭据。

## 验证入口

- test/codex-selected.test.mjs：真实原生进程、loopback 提供方，选型/参数 schema、原子批量、一次纠正、取消、socket 装配。
- test/reception-recovery.test.mjs：真实领域数据、报告证据隔离、截断、超时查询保留、最新版本刷新、迟到阻断及查询上限。
- 原 codex-harness、guardrails、goal-coordination、reception-queries 等测试继续验证兼容和原业务保护。

受控提供方只证明协议和机制。真实模型结果另记在 evaluation 的管家评测报告；六个合成场景不能证明无人值守的长期可靠性。

补充：报告交付的 text/message 和 goalPlan/goalReview 也是互斥契约。selected-v2 路由将 deliver 分成六种合法形状（默认 text 或 :message，可另选 :goalPlan 或 :goalReview），参数仍是原 kind=deliver。默认 deliver 可省略自定义 text，让宿主使用原报告；选中 message/goal effect 则必须填写对应对象。模型生成阶段不能同时输出两种互斥字段；应用层原拒绝规则继续保留。
