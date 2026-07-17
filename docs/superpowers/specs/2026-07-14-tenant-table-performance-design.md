# 租户列表与统计快照设计

## 背景

生产环境约有 35 万租户。当前 `GET /api/admin/tenants` 每次请求都会执行精确
`COUNT(*)`，并先把整张 `llmgateway_api_key_bindings` 按用户聚合，再从中取当前页。
实测返回 25 或 100 条都需要 15 至 21 秒。前端刷新菊花只是等待这个同步查询，并非
Table 渲染瓶颈。

## 目标

- 租户列表是传统的服务端分页 Table，首屏和刷新只处理当前页。
- 总数由 worker 周期统计，允许延迟，不进入列表读取链路。
- 搜索仅支持用户 ID、上游用户名的精确或前缀匹配，不支持任意位置模糊匹配。
- 租户权益观测继续由 observer 异步处理，不进入列表请求链路。
- 在当前约 35 万租户规模下，生产列表接口 p95 小于 500ms；目标值为 200ms 内。

## API 契约

### 租户列表

`GET /api/admin/tenants` 保留现有 `backend`、`set_id`、`limit`、`offset`、`cursor` 和
`keyword` 参数。新增 `include_total`：

- 未传或为 `false`：不执行 `COUNT(*)`，响应中的 `total` 为 `null`；管理台固定使用该模式。
- 显式为 `true`：保留精确筛选总数语义，供旧调用者迁移；该路径不属于 500ms SLA。
  精确计数使用独立的最小 count 查询，不能连接密钥聚合或 observation 等无关投影。
- `limit` 继续默认 50、最大 200；管理台使用 50。
- `offset` 暂时保留兼容，但管理台只使用 cursor，避免深分页。

列表响应新增 `has_more`；`next_cursor` 仍为不透明字符串。新 cursor 使用 `v2` 版本，内含
查询类型、排序键以及规范化后的 `keyword/backend/set_id` 摘要。旧 cursor 或参数变化后
复用 cursor 时返回 400，而不是按新排序误续页，产生重复或漏项。

### 租户统计

新增 `GET /api/admin/tenant-statistics`，只读取最近一次成功的 worker 快照，返回：

- `total`、`new_total`、`old_total`
- `active_total`、`disabled_total`、`deleted_total`
- `generated_at`、`stale`

统计接口不接受列表筛选条件，也不承诺筛选后的数量。成功时固定返回：

```json
{
  "ready": true,
  "total": 349000,
  "new_total": 340000,
  "old_total": 9000,
  "active_total": 348000,
  "disabled_total": 1000,
  "deleted_total": 0,
  "generated_at": "2026-07-14T10:30:00Z",
  "stale": false
}
```

没有成功快照时仍返回 HTTP 200，`ready=false`，六个计数字段和 `generated_at` 均为
`null`，`stale=true`；管理台显示“统计中”，租户列表仍然可用。worker 失败原因继续使用
通用 job 状态和 run 记录展示，避免在统计快照中混合“上次成功数据”和“本次失败状态”。
首次执行失败仍保持无快照；已有成功快照后再失败，继续返回原计数和原 `generated_at`，
只由时间推导 `stale`。

## 列表查询

### 普通分页

1. 使用 `updated_at DESC, external_user_id DESC` 的 keyset cursor 读取 `limit + 1` 条；两列
   同向排序可以反向扫描现有 `(updated_at, external_user_id)` 索引。
2. 主查询只连接一对一的 binding、assignment 和 observation 投影，不连接密钥聚合子查询。
3. 得到当前页 user ID 后，再执行：
   `WHERE user_id IN (...) GROUP BY user_id`，利用现有 `user_id` 索引补充当前页密钥数。
4. 第 `limit + 1` 条只用于生成 `has_more` 和 `next_cursor`，不写死为第 51 条。

为常用筛选增加复合索引：

- tenants：`(backend, updated_at, external_user_id)`
- tenants：`(set_id, updated_at, external_user_id)`

索引通过现有 MySQL migration/`information_schema` 检查路径增量创建，不能只写进初始
`CREATE TABLE`，确保已有生产库会升级。

### 精确和前缀搜索

搜索使用独立的两段索引流，不在多张表上拼跨列 `OR`，也不使用 `UNION DISTINCT` 后全量
去重、排序：

1. 关键词先 `TrimSpace`，按字符串原样比较；不做大小写转换，遵循数据库列当前 collation。
2. 1 至 2 个字符只做 `=` 精确匹配，防止极短前缀变成运营误操作。
3. 3 个及以上字符做前缀匹配；前缀本身的完整值在索引字典序中自然排在更长值之前。
   `%`、`_`、`\` 必须通过 `LIKE ? ESCAPE '\\'` 转义为字面量。
4. 第一段沿 tenants 主键 `external_user_id` 升序读取 `limit + 1` 个匹配项；cursor 记录
   `phase=user_id` 和最后一个 ID。
5. 第一段耗尽后，第二段沿 `llmgateway_user_bindings(username, external_user_id)` 升序读取；
   cursor 记录 `phase=username`、最后的 username 和 external user ID。第二段排除
   `external_user_id` 同时命中第一段前缀的行，避免跨页重复。
6. 两段可以在一次请求中衔接：第一段少于当前页剩余容量时，立刻用第二段补满。第一段
   恰好填满页面且已耗尽时，对第二段执行 `LIMIT 1` 的存在性探测；有结果则返回指向
   `phase=username` 起点的 cursor，否则 `has_more=false`。任一段取得 `remaining + 1`
   条时，只返回前 `remaining` 条，并将 cursor 留在该段最后一条已返回的位置。
7. 一期禁止 `keyword` 与 `backend/set_id` 同时使用，组合请求返回 400 和明确错误。否则
   热前缀叠加无结果筛选仍可能扫描整个前缀范围。管理台进入搜索时清空并禁用线路/Set
   筛选，启用筛选时清空搜索；将来确有组合搜索诉求时再引入专用搜索投影，而不是让主库
   承担不可控扫描。
8. 每段查询都只执行索引 range scan 并读取当前页附近的数据，不物化全部候选；`sgw`
   这类热前缀也不得出现临时表或全结果 filesort。
9. username 索引建在 `llmgateway_user_bindings`，不是密钥表。不再搜索 source、套餐、
   observation 文本。线路和 Set 继续使用独立筛选字段。

## 统计快照与 Worker

新增固定主键单行表 `llmgateway_tenant_statistics`：

- `id VARCHAR(32) PRIMARY KEY`，固定为 `global`
- 所有计数字段使用 `BIGINT NOT NULL`
- `generated_at DATETIME(6) NULL`、`updated_at DATETIME(6) NOT NULL`

core worker 新增 `refresh_tenant_statistics` job，默认每 10 分钟执行。任务只对
`llmgateway_tenants` 做 `GROUP BY backend, status`，不连接密钥、观测或 new-api。为该查询
增加覆盖索引 `(backend, status)`，并设置 30 秒任务超时；超时保留上一版成功快照。

统计写入必须受当前 job lease fencing 保护：同一事务使用数据库当前时间并通过
`SELECT ... FOR UPDATE` 锁定对应 worker job 行，确认 `lease_owner` 仍匹配且 lease 未过期，
随后才 upsert `global` 快照并提交。新 owner 获取 lease 也必须锁同一行，因此旧 worker
不可能在检查后被抢租、再覆盖新结果。通用 job 指标负责暴露最近成功时间、失败数和
lease age，不另建一套状态机。

## 存量迁移

新增的 username、backend 分页、set 分页和统计覆盖索引都必须同时出现在初始建表语句与
存量 migration 中。扩展为支持复合列的 `ensureMySQLCompositeIndex`，并使用 MySQL named
lock `llmgateway-schema-migration` 串行化多 Pod 启动。`GET_LOCK`、锁内复查、DDL 和
`RELEASE_LOCK` 必须全部使用同一个专用 `*sql.Conn`；等待上限 60 秒并始终 defer
`RELEASE_LOCK`，连接异常关闭时由 MySQL 自动释放。获取锁后再次检查索引，再执行
`ALTER TABLE ... ADD INDEX ..., ALGORITHM=INPLACE, LOCK=NONE`。未拿到锁的 Pod 返回明确
启动错误；相同索引已存在视为成功。目标 MySQL 不支持在线 DDL 时同样启动失败，不静默
退化为阻塞整表的 DDL。

不使用写路径事务计数器：当前不要求实时精确，为此增加所有租户写路径的计数一致性和
补偿逻辑得不偿失。也不使用 `information_schema.TABLES.TABLE_ROWS`，避免运营数字产生
不可解释的大幅估算误差。

## 管理界面

- 租户 Tab 以一个全宽 Table 为主体，不再用多张指标卡占据首屏。
- 工具栏从统计接口展示“约 34.9 万租户 · 统计于 10:30”，以及搜索、线路和 Set 筛选。
- 默认 50 条；上一页/下一页使用 cursor，不显示虚假的总页数。
- React Query 使用上一页数据作为 placeholder；后台刷新保留现有行，只让刷新图标显示
  进行中，首次加载才展示表格骨架。
- 点击行打开租户详情侧栏；详情和单租户“刷新观测”有独立 loading 状态。
- 列表刷新只读取本地 MySQL 投影，不调用 new-api，不触发观测任务。
- 后台任务使用独立的“后台任务”Tab，展示任务状态、最近运行、失败原因、lease 和手动触发
  操作；不把任务列表、队列详情或运行记录塞进运营总览。
- 运营总览不展示后台任务数量、状态、异常摘要、运行记录或跳转入口；后台任务是独立信息
  架构，不作为总览模块存在。
- 租户 Tab 只展示统计快照的生成时间和是否过期，不展示 `refresh_tenant_statistics` 的运行
  细节，也不提供任务跳转；排障统一从主导航进入“后台任务”Tab。

## 可观测性与错误处理

- `/metrics` 增加列表查询耗时，以及统计快照生成时间；worker 成功、失败和 lease 指标复用
  现有通用 job metrics。
- 快照超过 30 分钟时 UI 显示“统计数据较旧”，但 Table 仍可正常使用。
- 列表查询和统计 job 分别记录耗时；查询超时不回退到旧的全表聚合方案。
- 发布时同时观察统计 job 执行期间的列表 p95，统计任务不能明显挤占线上列表连接池。

## 验证

- 单元测试覆盖 cursor 与筛选绑定、精确/前缀规则、LIKE 转义、当前页密钥计数、无快照时
  列表仍可返回，以及统计写入的 lease fencing。
- MySQL 集成测试构造至少 2 万高基数租户和多密钥，并专门构造大量 `sgw` 热前缀，使用
  `LLMGATEWAY_MYSQL_TEST_DSN=... go test -tags=integration ./internal/gateway -run 'TestMySQLTenant(List|Statistics)'`
  验证普通分页、backend/set 筛选和两段搜索的 `EXPLAIN`：必须命中对应分页索引，不出现
  临时表和全结果 filesort，扫描行数不能接近全表；热前缀的首、中、末页都要覆盖。统计
  查询允许完整扫描 `(backend,status)` 覆盖索引，但必须不回表、不使用临时表。列表还需
  确认不存在全表密钥聚合。
- 迁移集成测试并发启动两个 store，验证 named lock、重复建索引和已有索引路径均幂等。
- lease 集成测试覆盖：旧 owner 锁前租约过期、新 owner 获取 lease、旧 owner 随后尝试写入
  快照时被拒绝；也覆盖持锁事务期间新 owner 不能交错获取 lease。
- HTTP 测试覆盖 `include_total` 兼容行为、独立统计接口、筛选和非法 cursor。
- 前端测试覆盖保留旧行的后台刷新、首次骨架、筛选重置 cursor 和统计过期提示；同时确认
  运营总览不渲染任何后台任务信息，租户页只展示快照时间/过期状态，任务详情和操作仅在
  独立“后台任务”Tab 出现。
- 北京生产发布前后对相同请求采样；验收只针对 `include_total=false`，要求无筛选、线路
  筛选和 ID/username 前缀搜索 p95 均低于 500ms，并确认刷新不触发 new-api 请求。统计
  job 执行期间同样采样，列表 p95 不得超过基线两倍且仍小于 500ms。
