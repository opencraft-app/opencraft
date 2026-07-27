# VelaGW 用户用途 Key 幂等获取

## 背景

CTL 在创建或重建 Bot 时，会调用：

```text
POST /api/admin/users/:user_id/api-keys
{"name":"default"}
```

VelaGW 已通过 `(user_id, purpose)` 唯一索引保证同一用途只有一个 Key，但接口当前
始终尝试创建。用户已经存在 `default` Key 时，MySQL 返回唯一键冲突，CTL 随即将
发货判为失败并删除已经创建的 Sandbox。

VelaGW 的表结构和当前运行规范要求中央 MySQL 保存完整 `external_key`，但现有
`prepareAPIKeyReservation` 会在写库前清空它，导致部分历史 active 记录无法再次
返回。本次同时修正新 Key 的明文持久化；历史空明文记录不自动轮换。
完整 Key 仍不得进入日志、指标、Redis 或错误消息。

## 接口语义

现有 POST 路径和响应结构保持不变，创建语义升级为 Get-or-Create：

| `(user_id, purpose)` 状态 | 行为 |
|---|---|
| 不存在 | 执行现有 Key 创建、上游 Token 创建和 Redis 路由发布流程 |
| `active` 且完整性校验通过 | 直接返回原 Key，不访问 new-api，不创建新 Token |
| `reserved` / `upstream_ready` / `route_pending` | 返回明确的 provision-in-progress 错误 |
| `error` / 未知状态 | 返回明确的不可复用状态错误 |
| `active` 但明文缺失或元数据不一致 | 返回 `api_key_material_unavailable`，不轮换、不返回空 Key |

`RevokeExternalKey` 当前物理删除绑定；删除后相同 purpose 可以重新创建。

active Key 的完整性校验必须解析严格 v2 格式，并核对 `external_key_id`、
`external_key_hash`、`secret_hash`、`key_version` 和 `route_slot`。任意不一致都
失败关闭。active 复用仍先经过租户 active/删除门禁，不能借只读复用绕过租户状态。

## 存储接口

Store 增加按 `(user_id, purpose)` 精确读取单条绑定的方法。MySQL 使用唯一索引查询，
MemoryStore 在锁内按相同语义查找，测试与生产保持一致。purpose 非空时才启用
Get-or-Create；无 purpose 的内部兼容入口继续允许多 Key。

Service 在任何 new-api 登录或 Token 创建前先读取：

- active：立即返回；
- 中间态或异常态：立即返回状态错误；
- 不存在：进入现有创建流程。

现有签发顺序保持不变，避免改变登录/access token 失败时的持久化状态机；中央身份
预留仍发生在上游 Token 创建之前，并在同一次纯 INSERT 中保存完整外部 Key。
并发请求可能同时观察到不存在，但唯一索引仍是最终互斥边界：预留返回
`ErrAPIKeyPurposeConflict` 时，Service 重新读取该 purpose。若此时已 active，则
返回获胜请求创建的 Key；否则返回其真实状态，不进行随机碰撞重试，也不产生第二个
上游 Token。并发败者可能重复执行无密钥泄漏的登录/access-token 准备，但不会创建
第二个上游模型 Token。

Set 的 admin 写暂停时，active Key 复用属于本地只读路径，直接返回 200；不存在时
仍沿用 durable admin command 排队，不绕过升级写门禁。

本次不改变 `RevokeExternalKey` 的物理删除和路由发布状态机。撤销与路由发布之间的
持久化清理/墓碑属于独立 P0，需单独设计，不能用一次无持久化兜底的 Redis DELETE
伪装成已解决。

## 错误契约

管理 API 对 Key 状态错误返回 HTTP 409，并在既有响应对象新增顶层 `code`：

```json
{
  "success": false,
  "code": "api_key_material_unavailable",
  "message": "external api key material is unavailable"
}
```

逐项映射：

- `reserved` / `upstream_ready` / `route_pending`：
  `api_key_provision_in_progress`
- `active` 但完整 Key 缺失或元数据不一致：
  `api_key_material_unavailable`
- `error` / `legacy_disabled` / 未知状态：
  `api_key_state_unavailable`

其他参数或上游错误维持现有 400。错误消息和 code 均不得包含完整 Key。

## 安全与兼容性

- 不修改 new-api。
- 不修改 CTL 请求或响应 DTO。
- 不自动撤销、轮换或覆盖 active Key；历史空明文数据需要显式运维重签。
- 不在日志、错误或遥测中记录完整 `external_key`。
- purpose 继续使用现有规范化与 32 字符限制。
- purpose 在规范化时统一转为小写，使 MemoryStore 与当前 MySQL 不区分大小写唯一
  约束保持一致；中文等无大小写字符不变。
- 无 purpose 的内部旧接口保持原有“每次创建”的能力；管理 API 始终将空名称规范为
  `default`，因此 CTL 获得幂等行为。

## 测试

- 同一用户第二次请求 `default` 返回相同 Key ID 和明文。
- 第二次请求不登录 new-api、不生成 access token、不创建上游 Token。
- 不同 purpose 仍分别创建。
- 预留与复用共享严格 v2 完整性校验；新签发记录在 MemoryStore/MySQL 中保存完整
  Key，且 Redis 快照仍不含明文。
- active 但明文为空或 v2 元数据不一致时失败关闭。
- `reserved`、`upstream_ready`、`route_pending` 和 `error` 不返回不可用 Key。
- 预留阶段 purpose 冲突后，若已存在 active Key，则回读并返回。
- 并发创建只有一个请求完成预留和上游 Token 创建。
- 随机 Key ID/hash 碰撞仍最多重试五次，purpose 冲突不进入随机重试。
- HTTP 接口重复 POST 返回 200 且响应内容一致。
- admin 写暂停时 active 返回 200，不存在时返回 202 排队。
- 无 purpose 内部入口仍可重复创建。
- disabled/deleting/deleted 租户不能通过 active 复用取回明文。
- 状态错误响应、日志、trace 和指标不包含完整 Key。
