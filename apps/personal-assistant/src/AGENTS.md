# 源码分治入口

继承[根规则](../AGENTS.md)。当前为独立的助理 runner workspace；Host 通过共享平台端口接入。先按职责进入对应目录，再读该目录AGENTS。

| 改什么                     | 入口                                 | 状态归属                      |
| -------------------------- | ------------------------------------ | ----------------------------- |
| 对象身份、版本、纯规则     | [domain](domain/AGENTS.md)           | 纯值与约束，无I/O             |
| 用例与事务                 | [application](application/AGENTS.md) | 各业务owner，不在装配层改状态 |
| 接口语义                   | [ports](ports/AGENTS.md)             | 数据、回执与恢复契约          |
| 实际存储、模型、工具和文件 | [adapters](adapters/AGENTS.md)       | 具体I/O实现                   |
| 入站请求格式               | [interfaces](interfaces/AGENTS.md)   | envelope，不定义授权          |
| 装配、调度和关闭           | [runtime](runtime/AGENTS.md)         | 临时进程资源                  |

依赖方向：application → domain/ports；adapters实现具体I/O；runtime组合服务和适配器。application/domain不得反向导入adapters/runtime。

本目录的store.mjs、runner.mjs、profile.mjs、files.mjs、pi-executor.mjs是兼容入口，不在这里增加业务分支或第二套状态。详细文件组见[总地图](../../../docs/architecture/personal-assistant.md)。
