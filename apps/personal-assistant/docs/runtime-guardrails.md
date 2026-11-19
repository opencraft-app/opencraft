# 运行保护与用量观察（0.9.0 / schema12）

2026-11-03用户明确：「能有对标grokbot级别的也就行了」，随后要求「搞起来」。提出人身份未确认。本轮在独立runner实现局部保护和可见用量；统一金额预占/扣账、父子和学习共用额度不作为当前完成标准，不在后台继续扩建。没有修改或部署Join。

## 默认值与恢复含义

| 路径               | 默认限制                                                     | 状态与恢复                                                                                                                                                |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worker生成步骤     | 每Execution最多128步                                         | GenerationTask的taskId去重，先提交Execution.guard_json再发请求；同generation重试不重复计步。重启/等待后保留，新工作revision重新计步。不是provider请求次数 |
| worker活跃运行     | 每次最多600000ms                                             | PiRunGuard从本次root准备好开始计时，等待用户/挂起停止；恢复或重启开始新次计时。只保存最后运行耗时，非全工作累计墙钟上限                                   |
| 模型请求           | 120000ms                                                     | Pi worker用原生stream设置；接待与记忆用completeSimple设置和外层截止。接待整次plan也有相同截止，学习提议/复核分别有截止                                    |
| 重试               | 每层最多2次                                                  | provider stream与Pi durable分别有限；不是整个工作只会调用3次。接待/学习原有重试/退避继续有界                                                              |
| 接待与续接         | 最多6次查询/7轮交换、4项批量命令、3次自动续接、3次父回合失败 | 复用原查询限制与持久接待状态，不新增manager或全局额度                                                                                                     |
| 并发、上下文与关注 | 原工作槽、分页/截断、按需技能和Attention/Routine保护         | 保持原owner、取消/修订与无人关注暂停机制，不将关注计数当花费                                                                                              |

Pi1.3.0会报告并忽略普通钩子异常。步数超限使用原生abort，等实际TaskRuntime.signal中止再throw；专项核对超限后没有第二个模型产物。等待经Pi原生挂起，不保留常驻等待Promise。模型截止释放接待/学习槽，迟到提议不能提交；不能保证任意第三方工具可被强制终止，也不撤销已经发生的外部效果。

超限工作保留blocked/错误详情与已有产物；显式修改可创建新revision重新推进。provider额度错误保留原始详情，不伪造本地余额。尚无平台额度查询API，也未进行真实provider限流/付费验证。

## 后台任务并发

每个助理运行时默认提供 **8 个后台 Work 工作槽**，可配置为整数 1..8。
这不是全平台总额度，也不表示同一个任务会同时执行多轮；同一 Work 仍只有一个活跃执行。
接待使用独立协调器，不占后台工作槽。达到上限的新工作保留在原队列，空出槽后继续。
并发数只是上限，不会为了凑满 8 个而额外创建工作。

新建本地配置可以指定：

```bash
node bin/assistant.mjs init --profile ./profiles/me --owner local:me --concurrency 4
```

不指定时，新本地配置和新托管 Bot 均默认 8。已有 `profile.json` 中显式写入的
`concurrency`（例如旧值 2）保持不变；缺失该字段时只在内存解析为 8，不回写文件。
修改已有配置须先正常停止对应 runner，修改其 `concurrency` 后再启动；本次没有增加热更新接口，
不能用创建新配置覆盖原 Bot 身份。其他配置、权限、模型限流、预算及共享资源独占约束不变。
提高并发可能增加同时发起的模型请求与资源消耗；它**不会修复运行中补充的即时投递问题**。

## 配置与查询

```bash
node bin/assistant.mjs init --profile ./profiles/limited --owner local:me --max-steps 64 --work-timeout-ms 300000 --model-timeout-ms 60000
node bin/assistant.mjs run --profile ./profiles/limited
node bin/assistant.mjs usage --profile ./profiles/limited
node bin/assistant.mjs usage --profile ./profiles/limited --work WORK_ID --limit 20
node bin/assistant.mjs usage --profile ./profiles/limited --after-id CURSOR --limit 20
```

profile.json的runPolicy允许maxSteps、workTimeoutMs、modelTimeoutMs、maxRetries，未填使用默认。steps范围1..5000，活跃运行1..86400000ms，请求1..3600000ms，重试0..5。旧profile加载时解析默认值，不偷偷改写文件。配置在启动时读取；不要编辑正在运行的配置来期待即时生效。

usage是本地只读查询，不调用模型、不恢复Pi执行、不更新关注/已读。默认20项、最大100项，next是下一页游标；totalsByMode聚合全部匹配观察，不随当前页截断。--work还显示各revision的steps、最后限制和lastRun观察；Pi累计统计跨该work全部revision，不能分摊为每revision精确账单。

## 用量的可信范围

- Pi原生usage由模型/tool checkpoint产生，执行期间每2秒采样，关闭后用paused Harness只读采样。业务表按work/bucket/mode覆盖累计快照，不累加重复抓取，不复制原生工具记录。
- 接待、记忆提议与复核用宿主调用ID记录一次调用的回执和耗时。返回后JSON解析失败也保留统计；超时/错误未返回usage时字段为null。hostCalls指宿主交换，不能等同provider内部计费请求数。
- input/output/cacheRead/cacheWrite/totalTokens来自可取得的回执；estimatedCostUsd来自模型目录估算。fixture与model分别分组，工具与模型明细分别保存。原生provider可能把未上报字段归零，coverage明确计数可能不完整，不能用0证明没有实际费用。
- knownTotals只加已观察值，unknownObservations单列未知记录数量。部分未知时，已知部分不是完整总额；没有观察时为空，不补造旧数据。
- 用量持久化失败记录健康错误，不重跑成功模型或覆盖其结果。进程崩溃前尚未保存的直接调用、provider内部失败重试可能遗漏；Pi最终可读取的原生累计值在后续采样修复快照。它是统计与诊断，不是精确账单、额度或审计级调用总账。

观察只保存白名单元信息，不保存prompt、正文或认证。schema12新增execution.guard_json和usage_observation，迁移保留旧snapshot，不回填旧步骤或token。

## 模块边界

| owner                              | 拥有的事实/资源                      | 不接管                           |
| ---------------------------------- | ------------------------------------ | -------------------------------- |
| RunPolicy / usage纯规则            | 默认值、错误与计数标准化             | I/O、时钟、账本                  |
| ExecutionService / ExecutionLedger | revision检查、持久步骤、最后运行观察 | Pi原生generation、工具checkpoint |
| PiRunGuard / PiExecutionAdapter    | 原生中止、timer、采样句柄            | Work状态、金额额度               |
| UsageService                       | 观察快照、去重、有界查询             | 工作/交付生命周期、扣账          |
| model-request / coordinators       | 模型截止、取消、实际回执             | 模型直接提交业务命令             |
| Attention / Routine                | 关注、安排与暂停                     | 账户余额                         |

具体导航见[分治地图](module-map.md)和[usage模块](../src/application/usage/AGENTS.md)。

## 证据与参考

183/183全量机制测试通过，新增19项专项；真实Pi中止、暂停后只读usage、用量跨重开、接待/学习迟到响应、schema11迁移与真实CLI均已验证。扩展个人场景17项离线断言通过；fixture/受控模型响应不能证明真实模型产品质量。详细记录见[0014迭代](iterations/0014-run-guardrails.md)，下一批仍是[真实使用与业务连接](roadmap.md)。

对标依据为非官方Grok Bot 0.18重建源码a9f633e09d49a85829b8236331b9e21f7e612634，研究记录位于`/data/output/grokbot-architecture-20261102/budget-boundaries-20261103.md`。可见steps、空转续接、上下文和无人关注保护；重建仓库另有usage实现。不能据此宣称官方完整行为或服务端扣账算法，也不机械照搬5000 steps参数。

2026-11-10：接待整轮模型/查询截止现在标为 planning-timeout，单次 modelRequest 仍为 model-timeout，两者数值均来自现有 modelTimeoutMs；没有增加预算。Codex 接待的两阶段生成也共用一次交换的截止，不能逐原生 turn 重新计时。报告重试恢复的是有界查询描述并重新读取当前状态，不是从旧响应继续提交；见[接待协议](reception-protocol.md)。
