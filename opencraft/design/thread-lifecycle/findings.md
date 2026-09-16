# 已核对事实

- ref/codex 在主 checkout，属于恢复 renderer，不作为服务端实现。
- Fork 分支完整原生事件/上下文，不复制 UI turns；excludeTurns 仅控制响应。
- DSH agents.create(seed) 校验平衡、连续事件；SessionPersistence 是可替换公开存储端口。
- 临时历史必须走真正的内存存储，不写 JSONL、派生缓存或产品持久目录。
- AppHost 逻辑 lease 与共享物理连接必须区分，unsubscribe 不终止普通会话。
