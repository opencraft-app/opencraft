# 0014：局部运行保护与用量（0.9.0 / schema12）

2026-11-03，用户在“对标Grokbot级别即可”的范围裁决后要求「搞起来」。提出人未确认。只修改独立无界面runner；未调用真实模型服务、操作Join或发布公共包。设计与具体恢复语义见[运行保护说明](../runtime-guardrails.md)。

## 实现

复用固定Pi1.3.0的原生取消、请求超时/重试和usage，补上宿主持久步骤检查、每次活跃运行timer、接待/学习外层截止。默认128步、10分钟活跃运行、2分钟模型请求、每层2次重试；等待/关闭暂停timer，重启/恢复活跃计时重新开始，步骤跨重开保留，新revision重置。没有统一财务预算或累计全工作墙钟计费。

新application/usage是真实观察模块，独占usage_observation写入与有界查询。Pi累计快照覆盖，直接调用按ID去重；fixture/model分组、未知null、目录价格估算与账单区分。ExecutionLedger独占guard_json。旧schema11迁移不补造历史统计，依赖未增加；导航与相邻AGENTS同批更新。

## 验证

- 全量183/183通过，约106.63秒：[完整日志](../../evidence/guardrails-tests-full-first.log)。既有164项和新增19项均通过。
- 专项真实Pi验证超限后恰好一个模型产物、原生abort、已有笔记保留、新revision推进；活跃超时、用户等待超过旧timer后仍可继续、quota详情、只读usage不恢复工作、跨重开累计和重复采样不膨胀。
- 接待/记忆验证不响应取消时释放槽、迟到提议不提交、复核超时保留原提议；真实model adapter使用受控响应核对timeout/retries/usage、JSON解析失败仍记统计、用量存储故障不重跑模型；fixture与model聚合、未知与分页、schema11和真实CLI均覆盖。
- 扩展personal-scenario已用新隔离fixture profile实际运行，17项断言通过：[演示日志](../../evidence/guardrails-personal-demo.log)。含记忆更正/遗忘、提问后重启、修改/取消、有限安排、明确秒数的自然语言安排、主助理处理报告、执行保护和usage。详情采证位于验证清单记录的新profile/evidence.json；runner已关闭。
- 语法、格式、链接、模块导航覆盖、依赖对比、归档逐文件哈希与固定源码身份以[验证清单](../../evidence/guardrails-validation.json)为准。语法检查不是类型检查。

## 已修正的中途失败

保留guardrails-focused-first.log（12/14），只读Harness缺registry导致native usage/CLI两项失败；补齐实际registry后第二轮14/14通过。第三轮扩展聚焦40/40通过。guardrails-focused-final.log的18/19中，新增quota测试误用未定义workId；修正测试引用后全量183/183通过。没有删除失败记录或把初次运行称为全部通过。

Pi普通hook抛错会被吞掉的问题在接入时确认，改为先原生abort并等待实际signal；否则仅看Work blocked会漏掉额外provider请求。测试断言原生模型产物数量，避免只验证表面状态。

## 尚未验证

真实provider付费请求、限流、精确账单、模型技能选择/证据提炼与输出质量、远程IM/OAuth、真实业务连接器和长期无人值守未通过验收。accept:real拒绝fixture，需当前显式授权连接；没有借用共享机器认证。当前仍为development，下一步按[roadmap](../roadmap.md)推进实际使用。
