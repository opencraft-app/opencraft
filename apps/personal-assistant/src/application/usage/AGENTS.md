# 用量观察与查询

继承[应用层约束](../AGENTS.md)。UsageService只保存adapter观测到的计数/耗时和有界查询投影，不拥有金额额度、预占、扣账或工作生命周期。

Pi仍独占原生usage；这里按稳定work/bucket/mode保存可覆盖的累计查询快照，不累加重复抓取。直接模型调用以宿主生成的调用ID去重，失败/超时保留未知，不把缺值补0。fixture与model分组；目录价格估算不是实际账单。只接收白名单元信息，不保存prompt、内容或认证。

写入归UsageService，具体存取归SQLite适配器。用量写入失败不得默默重跑已完成模型请求；停止/关闭后未知范围如实暴露。验证见test/guardrails.test.mjs；修改共享装配/迁移仍跑全量回归。
