# 三方记忆方案实验适配

本目录只负责固定实验协议、上游SDK调用和公共reader接线；不实现新的记忆、排序或更新算法。原始事实、角色和因果边界保留，gold仅在父评分器。

本轮比较的是本方案、Hy-Memory、TencentDB Agent Memory，固定共同reader、后台模型和外部预算。[协议](../TENCENT-COMPARISON-PROTOCOL-20261109.md)记录初始声明及运行后发现的限制；[完成报告](../TENCENT-COMPARISON-RETEST-20261109.md)分别列出来源、质量、预算失败和准备开销。

## 固定运行与适配审计

- v2为后台hy4额度中断记录，不用于质量排名。
- `run.mjs`对应v3恢复运行的冻结接线。审计发现其中腾讯云的capture窗口、追问搜索和场景路径适配存在问题；**不要把原始TDB接线当作已修正配置重跑或排名**。Hy的Chroma后端实际为dense-only。
- 修正的腾讯云完整分支单独位于[本轮修正适配](../../evidence/tencent-comparison-20261109/tdb-correction/declaration.json)，其worker/session/run均随v4结果归档。修正调用原生capture/L1、独立memory_search/formatter与隔离profile场景文件，不修改原生策略或提示词。
- [原生流水线本地检查](../../evidence/tencent-comparison-20261109/tdb-correction/contract-smoke.mjs)使用HTTP模型/embedding替身验证消息覆盖及读取边界，无付费调用，不产生质量分数。

这是本轮显式私有配置、上游版本和固定输出的研究脚本，不是通用服务。输出拒绝覆盖；再次实验应使用新目录、固定并归档源码/计划，声明哪些参考分支复用，不能择题挑选答案。真实模型配置只读取用户明确指定的私有文件，不从共享环境找凭据。
