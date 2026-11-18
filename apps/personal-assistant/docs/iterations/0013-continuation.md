# 0013：后台报告回到主助理（0.8.0 / schema11）

日期2026-11-03。提出人未确认。原话：「然后实现一下吧」。范围为独立无界面runner，未操作Join、Core/router、Git远端或外部服务。

## 交付行为

- 执行报告先持久保存，与原主会话的系统接待turn和awaiting_review同事务；运行时只安排处理，主助理重新检查并提出继续、交付、静默或阻塞。
- continue经原WorkService.amend推进同一workId的新revision，保留原授权、完成要求和原始请求；用户修正与自动续接次数随快照保留。
- 用户接待最多4项非嵌套命令同事务提交；支持interval安排创建/暂停/恢复，经RoutineService真实校验和回执，不开放任意服务调用。
- 默认仍为笔记契约；显式output=text可不生成笔记。原报告和最终回应分开保存，渠道接受后才完成。
- quiet静默不刷新关注、不生成假回执；重复与迟到报告不重复效果或覆盖新revision。原来没有主会话关联的工作保持本地流程。
- 续接最多3次，主回合失败最多3次并退避；耗尽后保留报告与阻塞状态。pump各阶段故障隔离，不再因routine异常跳过接待和交付。
- 已保存的报告遇后续结算故障时直接重试结算，不再调用executor；Pi原生checkpoint归属不变。

详细owner、数据与协议见[续接说明](../assistant-continuation.md)，导航见[模块地图](../module-map.md)。本次新增domain/continuation.mjs与test/continuation.test.mjs，未为导航创建空模块或新的manager。

## 验证记录

最终全量164/164通过（约103.51秒），专项33/33通过；语法检查92模块与格式通过。结果汇总写入`evidence/continuation-validation.json`。全量日志为`evidence/continuation-tests-release.log`；专项33项日志为`evidence/continuation-focused-final.log`。包括真实Pi Harness、本地SQLite/文件/socket/CLI、报告保存后与父提议提交前两个真实子进程崩溃窗口。

重点断言：不重复Pi work-input/产物/交付；结果先保存再由父回合决定；未通过检查不能成功交付；文本工作无产物；同一输入两项工作分别收尾且可只修改一项；批量中途失败全部回滚；重启保留计数/最新修正；独立任务结算故障不重入executor；旧schema1/2/3/4/10迁移保留原快照/回执和授权。

保留中间记录：首次39项中两项旧迁移夹具未移除schema11新增列，已修正夹具；首次专项21项中一个断言误读query session返回层，已修正为response。对应日志为continuation-tests-first.log与continuation-focused-first.log。后续152、162、163项全量绿灯是各自中间状态，最终交付以release日志和源码manifest为准。

源码快照`evidence/superapp-continuation-0.8.0-source.tar.gz`、逐文件哈希和检查命令在验证汇总中，不覆盖旧0.7.0归档。

## 验证范围与剩余项

模型来自fixture或受控响应，包括真实模型适配器的请求协议验证；未调用真实模型服务。机制通过不代表自然语言判断、内容质量或通知价值已通过。未发送远程IM，未接外部OAuth/业务工具，未做长时间无人值守验收。没有新增依赖，没有Join部署。

局部轮次/重试上限不是全局预算。时区/日历自然语言、完整预算、真实业务连接器、备份/保留与OpenCraft内置装配继续在roadmap。blocked的父回合保留诊断，当前恢复方式为用户明确修改原工作，没有新增后台管理UI。
