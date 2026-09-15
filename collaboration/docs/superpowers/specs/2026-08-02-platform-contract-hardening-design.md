# Platform v1 数据模型与 OpenAPI 契约硬化设计

## 1. 目标

把数据库模型与 HTTP 协议从“实现旁边的文档”提升为机器可验证、可冻结、可演进的
Platform v1 契约。业务实现仍允许快速迭代，但任何实现都不得绕过租户归属、分片路由、
迁移历史、身份边界、分页、并发控制和协议兼容性。

本阶段不增加聊天消息、DM、附件、Activity 历史、Agent thinking、PTY 流或自建长连接
数据表。腾讯云 IM 继续负责聊天事实，平台数据库只保存业务事实和稳定消息引用。

## 2. 权威来源

### 2.1 领域模型契约

新增 `platform/v1/model-contract.yaml`，文件本身带 `schemaVersion`，并由严格的
meta-schema/Go decoder 校验；未知键、重复表名、悬空引用和未声明的跨分片关系都拒绝。
它描述全部 25 张业务表的：

- aggregate/domain；
- kind：`authority | registry | projection | ledger`；
- shard key 与逻辑 ID；
- 不可变路由字段；
- 逻辑归属引用；
- 生命周期字段和允许值；
- 删除策略；
- 数据保留；
- 语义字段分类：lifecycle、secret、credential、hash、PII、reference、opaque JSON；
- 是否可重建；
- 允许的跨分片事务白名单。

权威边界固定为：Ent Schema 负责字段、类型和索引；`physicalschema.Manifest()` 负责
shardkey；model contract 负责 domain/kind/ownership/lifecycle/delete/retention/classification。
contract 中的 shardkey 只是可读镜像，必须与 Manifest 断言一致，不能成为第二个路由来源。
`schemaaudit/schema_test.go` 仅作为发布快照，不再被描述成模型权威。数据库文档生成器必须
同时加载 Ent、Manifest 和 model contract：分别生成物理字段/索引、路由、领域语义，不能
只靠 contract 生成它不拥有的物理结构。

每张表的普通字段默认分类为 `data`；字段名含 secret、credential、password、hash、email，
以及所有持久 JSON 字段必须在 `semanticFields` 中显式分类，否则 CI 失败。跨分片工作流放在
contract 顶层，显式写参与表、各自路由键和单向/双向对账关系。数据库 Markdown 表格由
contract 生成或被测试逐项核对，不再手写表数量。

### 2.2 迁移发布锁

新增 `migrations/released.lock.json`，按 dialect、路径记录 SHA-256 和逻辑 migration ID。
所有已经进入仓库的 SQL 都视作永久发布历史，不存在 `released=false`；是否已部署到某个
环境属于部署状态，不能写回迁移源文件。

锁定范围包括全部 SQLite migration、`migrations/tdsql/` runtime 副本、
`internal/database/migrationsource/tdsql/` source 副本，以及 source `compile.sum` 对逻辑
迁移的绑定。`atlas.sum` 允许随新增迁移追加，但不能替代逐文件锁。

门禁规则：

1. 已发布文件不得删除、改名或改变任一字节；
2. `atlas.sum` 重新生成不能绕过 release lock；
3. 同一逻辑变更必须声明 SQLite/source TDSQL/runtime TDSQL 对应关系，并显式记录
   `includedInBaseline`；
4. 新迁移只能追加，普通生成流程不得自动重写 lock；更新 lock 必须执行独立、显式的
   promote 命令，并打印新增项供审查；
5. migration/source/runtime SQL 文件集合必须与 lock entry 集合完全相等，每个文件恰好出现
   一次；新增 SQL 未 promote 立即失败；
6. 受保护 CI 必须从可信默认分支取得 `--base-lock`，验证 transition 只能追加；本地诊断可
   不提供 base，但不能冒充发布门禁；同时修改旧 SQL 与旧 digest 仍会失败；
7. 数据库运行时 checksum/revision 校验继续保留，形成仓库门禁和运行时门禁两层保护。

## 3. OpenAPI 收敛

### 3.1 分页

凡是接受 `cursor` 的 GET 必须返回统一 page object：

```json
{"items": [], "nextCursor": null}
```

本阶段统一 `listServers`、`listMembers`、`listTasks`、`listMessageThreadReplies`、
`listRuntimeTasks`、`listRuntimeReminderLog`、`listRuntimeReminderOccurrences`。所有 page schema
都要求 `items`、`nextCursor`，并设置 `additionalProperties: false`；Repository 使用 `limit+1`
判定下一页。

Cursor 是带版本的 opaque base64url 数据，包含 operation、规范化 filter hash 和稳定排序
tuple；不签名，也不承担鉴权。鉴权始终由 bearer 与 path scope 完成，篡改 cursor 最多改变
已获授权集合内的翻页位置，绝不能扩大范围。结构、operation 或 filter 不匹配返回
`400 invalid_cursor`。客户端不得解析 cursor。

稳定排序 tuple 冻结为：Server 使用 account 分片投影可直接查询的 `(server_id)`；Member
使用 `(created_at,id)`；Task 使用 `(updated_at,id)`；Thread replies 使用
`(message_sequence,id)`；Reminder log/occurrence 使用 `(scheduled_fire_at,id)`。具体升降序
写进 operation 扩展并由 repository 测试固定。
旧 cursor 格式不兼容；由于当前仍是内部 Canary，服务端、Web、TUI 同步切换，在正式
1.0.0 冻结前完成，不提供双读迁移。

### 3.2 revision 并发控制

不再滥用 HTTP `ETag/If-Match`。Agent/Computer 响应含在线状态、心跳等易变投影，这些变化
不一定提升业务 revision，因此不能声称 body 是同一个强 representation。统一改为诚实的
应用层并发头：

```http
X-Resource-Revision: 5
```

- OpenAPI 按下面矩阵显式列出需要该请求头的 operation；
- 只接受十进制非负整数；缺少或格式错误返回 `400 invalid_request`；
- 资源 revision 不匹配返回 `409 revision_conflict`；
- 成功且返回带 revision 资源 body 的 mutation，其响应 header 与 body 必须一致；
- 普通 GET 和只返回易变投影的状态查询无需返回该头；
- 规范与实现中彻底删除 `If-Match`、`ETag` 的 revision 语义。

`Revision` 与 header 都允许 `0`，匹配现有初始化行为。矩阵外 operation 不接受该头；
create/deploy/start/stop/restart/rotate/claim/ack 依靠 idempotency、generation/launch fence 或
幂等状态机，不使用 resource revision。

| operationId | 请求头 | 成功响应头 | revision 来源 |
| --- | --- | --- | --- |
| updateServer | 必需 | 必需 | Server body |
| updateMember | 必需 | 必需 | Member body |
| updateChannel | 必需 | 必需 | Channel body |
| updateAgent | 必需 | 必需 | Agent body |
| updateRuntimeTaskStatus | 必需 | 必需 | Task body |
| updateComputer | 必需 | 必需 | Computer body |
| createComputerSetupCommand | 必需 | 必需 | ComputerSetupCommand body |
| updateTask | 必需 | 必需 | Task body |
| updateReminder | 必需 | 必需 | Reminder body |
| cancelReminder | 必需 | 无（204） | 当前 Reminder |
| updateRuntimeReminder | 必需 | 必需 | RuntimeReminder body |
| cancelRuntimeReminder | 必需 | 无（204） | 当前 Reminder |
| snoozeRuntimeReminder | 必需 | 必需 | RuntimeReminder body |

### 3.3 身份面

路径前缀提供默认认证域：

- `/servers/**`、`/me/**`：HumanBearer；
- `/runtime/**`：RuntimeBearer；
- `/computer/**`：Computer credential/Bearer/Enrollment；
- `/callbacks/**`：腾讯回调认证；
- `/bootstrap/**`：Computer bootstrap credential。

例外路径 `/auth/**`、`/invites/**`、`/server-slugs/**`、
`/computer-installation-options/**`、`/computer-artifacts/**` 显式声明自身认证规则，不能靠
前缀猜测。新增机器可读的 operationId → auth-domain 矩阵，OpenAPI security 与 handler
注册必须逐项匹配。

`/servers/{serverId}/tasks*` 不再接受 RuntimeBearer；Agent 只使用 `/runtime/tasks*`。
增加规范测试和真实 HTTP 测试，证明凭证不能跨前缀降级使用。

### 3.4 错误码

主 OpenAPI 顶层新增机器可读 `x-error-code-registry`，每项至少包含 code 与 HTTP status。
Go `error_registry.go` 与该 registry 必须精确对账；新增 Go 错误码而不更新协议会使测试失败。
`ErrorEnvelope.error.code` 保持 string，以便旧客户端容忍未来错误码，不生成封闭 enum。

`x-error-code-registry` 是协议唯一权威；Go registry 是运行时镜像，必须精确一致。Computer
Bootstrap API 和 Markdown 都从同一 registry 生成或校验。Bootstrap 复用相同
`{error:{code,message,requestId,details?}}` envelope；requestId 是 string（允许运行时兜底值），
错误响应统一 `Cache-Control: no-store` 与 `Pragma: no-cache`。

### 3.5 兼容性门禁

当前契约硬化完成后，将两个 OpenAPI 的 `info.version` 冻结为 `1.0.0`，协调 Web、TUI、
Go client 完成全部破坏性切换，并保存：

- `platform/v1/releases/1.0.0.openapi.yaml`；
- `platform/v1/releases/1.0.0.computer-bootstrap.openapi.yaml`。

release snapshot 另有不可变 digest manifest，普通生成命令不得覆盖。受保护 CI 必须从可信
默认分支取得 manifest，既有 snapshot path/digest 只能保留，只允许追加新版本；不能通过
同时修改 snapshot 和 digest 绕过。CI 使用仓库固定版本的成熟 OpenAPI diff 工具比较当前
规范与两个 baseline，至少拒绝：

- 删除 path/method、改变 operationId 或安全域；
- 删除成功响应或改变其媒体类型；
- 删除请求/响应字段或参数；
- 给请求增加新的 required 字段；
- 缩窄已有输入 enum/range/pattern；
- 改变 schema 类型；
- 扩大响应 enum（生成的 closed enum 客户端可能失败）；
- 对 closed response object 增加旧客户端不能接受的字段；
- 改变 path/query/header 参数位置或 required 性质。

允许新增可选请求字段、新 path/method 和新错误码；响应字段只有 schema 明确带
`x-tolerant-reader: true` 时才允许增加。工具固定在仓库/CI 中，不能依赖开发机全局安装，
也不手写一个不完整的 OpenAPI diff 冒充兼容检查。

## 4. 数据一致性与持久 JSON

### 4.1 一致性扫描器

新增只读命令：

```text
chatserver database check-consistency \
  --scope server|account|registry \
  --partition-key <serverId|accountId|registryKey> \
  [--registry-type login|server-slug|tat-binding|agent-im-route|computer-setup] \
  [--cursor <opaque>] [--limit 1000]
```

registry scope 必须同时提供 registry type。TDSQL 与 SQLite 都显式提供 scope 和 partition
key，第一版不提供全库遍历。每条 TDSQL 查询的路由键必须与
`physicalschema.Manifest()` 完全一致，测试用多 set 模拟证明无广播。扫描器输出结构化
问题，不自动猜测修复，发现问题退出非零。

第一版覆盖：

- Agent 与对应 Agent Member 同 Server；
- Agent.computer_id 指向同 Server、未移除 Computer；
- ChannelMember 的 Channel/Member 同 Server；
- Task owner/creator/updater 同 Server；
- Reminder/Occurrence 与 Agent/Reminder 同 Server；
- infrastructure `partition_key/server_id/resource_id` 一致；
- `computer_runtime_credentials` 与同 Server Computer、version/state/expiry 一致；该表没有
  Agent 外键，不虚构 Agent 归属检查；
- `computer_agent_observations` 检查 ingest 时记录的 accepted/rejection 事实和同 launch 内
  sequence/fence 单调性；仅当前 receipt 与 Agent 当前 launch fence 对账，历史 receipt 不误报；
- server scope 从权威行点查 registry；account/registry scope 负责反向投影对账；
- AccountServerMembership 投影可与权威 Member 对账。

扫描查询必须走 Repository/专用只读 adapter，携带 shardkey、limit 和稳定 cursor；不得把
跨分片扫描混入正常 API 请求。

### 4.2 JSON 版本化

持久 JSON 使用精确 envelope：

```json
{"schemaVersion":1,"payload":{}}
{"schemaVersion":1,"service":"im|tat|platform","kind":"...","payload":{}}
```

第一种用于消息引用，第二种用于 TencentOperation request/result snapshot。以下字段纳入：

- Task `source_message_ref_json`；
- Reminder `anchor_message_ref_json`；
- TencentOperation request/result snapshot（由 kind 决定 payload schema）。

每个 operation kind 必须按 `(service,kind,column=request|result)` 注册严格 codec，允许
某一列显式为 `none`，并由穷举测试确保 registry 完整。decoder 拒绝
未知字段、类型错误和 trailing JSON。无版本 legacy 只允许精确的既有字段集合，并解释为
v1；仅当所属 payload 字段自身被重写时才升级 envelope，不能因为更新同一行的其他字段而
顺手重写。未知版本 fail closed，并由一致性扫描器报告。

`idempotency_records.response_body_json` 当前保存多种 locator/DTO，并非统一 HTTP opaque
body，因此也纳入版本化：按 `scope_type` 注册 codec，写为
`{"schemaVersion":1,"payload":...}`；legacy 只接受对应 scope 的既有精确结构，未知
scope/version fail closed。`response_status` 继续由独立列保存，不塞入 JSON。

`computer_agent_observations` 只保存 correctness receipt，不是 Activity。其保留期固定 30 天，
清理按 `server_id,created_at,id` 有界执行；其他遗漏类型同步补入数据保留矩阵。

## 5. 文档与生成物

同步修正并加入反向断言：

- 数据库表数从 23 更新为 25，并加入 Computer credential/observation；
- Computer 已拥有 bootstrap/正式短期凭证，不再写“Computer 没有平台凭证”；
- 删除已经不存在的 `/runtime/session` 和 Human provider registration 描述；
- 明确 Computer launch session、Enrollment、Bootstrap、Runtime 的真实路径；
- OpenAPI、生成 Go server/client、Scalar 文档和所有 fixture 一致；
- 禁止文档再次出现“23 张表”、旧 `/runtime/session`、“Computer 没有平台凭证”，以及
  把 revision 描述成 `If-Match/ETag`。

现有按 path/operation 数量冻结的测试保留作为烟雾测试，但新增语义 lint，不能再用数量
相同证明协议兼容。

## 6. 测试与交付顺序

每项遵循 RED → GREEN：

1. model contract：删表、错 shardkey、悬空引用、未知键、未分类 secret 均失败；
2. migration lock：旧 SQL 编辑/改名/删除、旧 lock entry 修改、dialect 映射错误、新 SQL
   未 promote、同时修改旧 SQL 与旧 digest 均失败；
3. pagination：0/limit/limit+1、多页无重漏、错 operation/filter/schema cursor；
4. revision：缺失、畸形、stale、成功、header/body 一致，并证明不存在 `If-Match`；
5. auth：Human、Runtime、ComputerCredential、ComputerBearer、Enrollment、Bootstrap、
   Callback 凭证对两个 OpenAPI 的全部 operation 做交叉矩阵；
6. scanner：每条规则一个损坏 fixture、三种 scope、cursor/limit、多 set 无广播；
7. JSON：legacy/v1/未知版本/未知字段/类型错误/trailing/lazy rewrite/kind 穷举；
8. error registry：OpenAPI、Go、Bootstrap、Markdown 精确对账；
9. compatibility：两个 snapshot 覆盖每项 allow/reject 规则和 snapshot digest 篡改；
10. docs：反向搜索旧表数、旧路径、旧凭证描述和旧 revision 语义；
11. 全仓 test、race、vet、生成一致性、凭证扫描、SQLite/TDSQL migration verify。

完成标准是十项目标均有权威文件、失败测试、实现和全量验收证据；只补 Markdown 或只让
当前测试通过不算完成。
