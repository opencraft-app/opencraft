# 具体I/O适配器

继承[上层规则](../AGENTS.md)。本层实现具体能力，业务写入仍经application owner。

| 子目录                             | 负责什么                                    |
| ---------------------------------- | ------------------------------------------- |
| [memory](memory/AGENTS.md)         | Markdown事实权威、shard、文件事务与投影协调 |
| [sqlite](sqlite/AGENTS.md)         | 本地UoW、迁移、repository与只读投影         |
| [pi](pi/AGENTS.md)                 | 原生执行、工具checkpoint、挂起和恢复桥接    |
| [codex](codex/AGENTS.md)           | 结构化推理、受约束持久委托与隔离进程        |
| [models](models/AGENTS.md)         | 模型目录、提议/复核交换与fixture            |
| [filesystem](filesystem/AGENTS.md) | 受约束资料、不可变产物、mailbox、文件源     |
| [local](local/AGENTS.md)           | profile、socket和加密凭据适配               |

adapter不得越过用例owner直接修改其他业务表，不把第三方任务状态复制进领域库。输入/输出要说明接受等级、幂等身份、错误和重试范围。网络、模型和异步外部I/O不能跨进同步UoW；现有本地同步引用校验的接缝见总地图。

[telemetry](telemetry/AGENTS.md) 只拥有标准 OTel SDK、本地 OTLP JSON 导出和临时关联上下文，不拥有业务状态或重试策略。

新增外部业务工具从窄port和一个实际场景开始，明确凭据消费、权限、幂等/对账；不把任意网络或Shell当默认工具。替换适配器时保持原授权、已发生结果和未知状态，不盲目重放外部动作。

[work-tools](work-tools/AGENTS.md) 只拥有共用工具描述及窄 port 调用，不拥有业务状态或原生挂起。
