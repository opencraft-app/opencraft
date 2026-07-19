# 外部 API Key v2 设计

## 目标

LLMGateway 对外只签发 OpenAI 风格的 `sk-` Key，同时满足中央存储和路由层长期横向扩容。新格式不兼容现有 `sk-lgw-v1-*`，不修改 new-api，MySQL 仍是事实源，Redis 只是流量路由投影。

## 二进制格式

Key 的文本形式为：

```text
sk-<Base64URL payload>
```

payload 固定为 69 字节：

| 字段 | 长度 | 语义 |
| --- | ---: | --- |
| version | 1 byte | 当前固定为 `2` |
| route_slot | 4 bytes | 大端无符号分片键，不绑定物理节点或 Set |
| key_id | 32 bytes | 256 bit 随机公开标识 |
| secret | 32 bytes | 256 bit 随机认证秘密 |

Base64URL 不带 padding，payload 编码后固定 92 字符，完整 Key 固定 95 字符。`external_key_id` 使用 `route_slot + key_id` 的 Base64URL 编码，因此管理操作只持有 Key ID 时也能恢复分片键。

`route_slot` 是存储和缓存的稳定分片键。它不能编码 Set ID、Redis 节点或 MySQL 实例。物理拓扑扩容由 TDSQL、Vitess、Redis Cluster 或后续的逻辑槽映射处理，用户 Key 不变；用户迁移 Set 只更新路由记录。

## 安全属性

- Key 材料只允许通过 `crypto/rand` 和 `io.ReadFull` 生成。
- 随机源失败立即终止签发，禁止固定字符串或弱随机降级。
- MySQL 不保存完整外部 Key，只保存 `external_key_id`、完整 Key 哈希、带域分离的 Secret 哈希、路由槽和状态。完整 Key 仅在路由发布成功后向调用方返回一次。
- Redis 路由投影、流量缓存、日志和指标不保存或输出完整外部 Key。
- Secret 校验使用恒定时间比较。
- 日志和指标只允许记录内部 user ID、Key ID 或哈希前缀。
- 格式和算法可以公开，安全性只依赖随机 Secret，而不依赖算法保密。

## 签发状态机

状态依次为：

```text
reserved -> upstream_ready -> route_pending -> active
```

1. 生成候选 Key，在中央 MySQL 使用纯 `INSERT` 创建 `reserved` 记录。
2. 只有 Key 主键或完整 Key 哈希冲突才重新生成，最多 5 次。`user_id + purpose` 冲突属于业务冲突，不得伪装成随机碰撞重试。
3. 使用 `sgw-<external_key_id>` 作为 new-api token 的确定性名称创建上游 token。
4. 将上游 token 信息写回 MySQL，进入 `route_pending`。
5. 从 MySQL 记录构造路由快照并发布 Redis。
6. Redis 发布成功后将 MySQL 状态改为 `active`，此时才向调用方返回完整 Key。

Redis 写失败时不得返回 Key。`route_pending` 记录由 worker 幂等重试；Redis `SET` 本身必须幂等。`reserved` 或 `upstream_ready` 的异常中断记录保留在 MySQL，交由超时清理或后续补充的上游 token 对账任务处理，不能凭空重新生成同一把完整外部 Key。

## 兼容与清理

- 流量入口只接受严格合法的 v2 格式，其他 Bearer Key 直接返回 401，不做旧哈希查询。
- 数据库迁移不得偷偷删除旧记录。旧 v1 记录保留为不可用历史数据，清理由显式一次性运维动作完成。
- Redis 中旧路由由显式清理流程删除，不在启动迁移中执行破坏性扫描。

## 测试边界

- 格式：固定长度、字段 round-trip、错误版本、错误长度、非法 Base64URL、旧格式拒绝。
- 随机源：读取失败立即报错，不产生 Key。
- 冲突：Key ID/Key 哈希冲突最多重试 5 次，业务唯一键冲突不重试。
- 状态机：MySQL 预留发生在 new-api 调用前；Redis 发生在 MySQL 完成后；Redis 失败不返回 Key；成功后状态为 active。
- 恢复：route_pending 可重复发布，重复执行不创建第二个上游 token。
- 集成：MySQL 唯一约束、Redis 路由 key 使用 route_slot、traffic-only 入口不回源 MySQL。
