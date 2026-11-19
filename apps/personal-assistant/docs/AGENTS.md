# 当前设计、计划与历史证据

继承[根规则](../AGENTS.md)。[module-map.md](module-map.md)是分治导航，[architecture.md](architecture.md)描述当前边界，[product.md](product.md)定义验收目标，[roadmap.md](roadmap.md)列下一批开发，[superapp-capabilities.md](superapp-capabilities.md)记录六项已实现范围。

iterations保留各轮事实，不把旧轮次文字当成当前能力清单。修改当前摘要时核对源码和最终证据；旧失败日志、原归属和未验证结论保持可追溯。源码归档/manifest描述固定历史快照，后续文档变更另留记录，不重写旧绿灯冒充新验证。

新模块AGENTS写清入口、owner、接口、禁止越界、测试和真实缺口；不堆通用口号，不把待建文件夹写成已有模块。owner是类/职责，不猜测用户或执行者身份。

[assistant-continuation.md](assistant-continuation.md)保存跨模块续接约定，目录AGENTS只描述自己的落点并链接它；变更交互边界时同步检查调用双方和总地图，避免各自维护冲突副本。研究结论标明源码版本与可信范围，重建源码中的定义、装配、受控探针和官方产品行为分别记实。

验证文档的本地链接、目录覆盖与格式；仅文档改动无需重跑完整业务测试。计划与实现分栏，fixture、本地I/O、真实模型、外部服务和平台上线分开记实。

[runtime-guardrails.md](runtime-guardrails.md)记录0.9.0已实现的保护、默认值与用量观察限制。统一金额预算已退出当前P0和完成标准；历史计划/验证保留原貌，当前摘要与目录指南遵循根AGENTS的最新投入边界。

0.10.0执行接口和分模块验收边界见[0015记录](iterations/0015-module-boundaries.md)。总地图的旧app工具依赖条目已退为解决状态；ReceptionService、WorkCoordinator与本地Vault等仍存在的依赖如实保留。当前代码仍schema12，不能为目录重构伪造数据迁移或真实模型质量通过。

0.11.0当前持续安排与记忆范围集中在[long-running-assistant.md](long-running-assistant.md)。学习Grokbot时注明恢复源码与官方产品行为的区别，不能把旧episode路径/可选装配写成已全量运行的事实。日历/停止条件与metadata改变要同步原owner指南、迁移和实际接口。

0.12.0当前记忆机制与Grokbot差异以grok-memory-parity.md为准。旧来源不明保护的现代协议范围已被本轮用户决定替代；旧key兼容语义保留。新版提炼与旧episode互斥，不把“没加episode/向量库”自动当成偏离新版核心。文件权威、agent shard和多项目汇聚仍是实际差异。

0.13当前文件权威/三scope与项目成员机制见memory-files-and-shards.md，覆盖grok-memory-parity.md中0.12旧差异范围。恢复源码中定义、可选factory、提示词消费接口不完整的事实须保留，不以本地实现倒推官方产品行为。旧iteration/固定归档继续不改。

0.14当前主会话长期工作上下文见conversation-working-context.md，iteration0019保留实现/失败/验证。它是会话派生信息，不能混同个人事实记忆或Pi执行压缩；当前根导航schema16。旧历史归档不改。

0.15用户消息层的当前机制/未完成范围见user-messages.md与iteration0020；不要把local:main落盘说成Slack/飞书或用户已读。工作完成兼容旧mailbox契约，不能用新通知状态倒推旧Result/Delivery；消息UI、外部账户和平台权威映射仍单列。
