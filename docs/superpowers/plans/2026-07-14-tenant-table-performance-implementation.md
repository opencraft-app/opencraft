# 租户列表性能与后台任务页面实现计划

## 目标

把租户列表读取成本从 O(全量租户/密钥) 降为 O(当前页)，由 worker 周期生成全局租户统计
快照；同时把 jobs、BYOK 队列和租户观测队列从运营总览迁移到独立“后台任务”Tab。

## 1. 后端类型与 Store 契约

- 在 `internal/gateway/model.go` 增加 nullable total、`TenantStatistics`、v2 cursor 数据结构和
  `BackgroundJobsOverview`。
- 在 `internal/gateway/store.go` 增加读取/替换租户统计快照的方法；MemoryStore 实现相同
  行为，供单元与 HTTP 测试使用。
- 先在 `tenant_test.go`、`operator_p0_test.go` 写失败测试，覆盖无快照、统计生成、旧 cursor
  拒绝、筛选绑定和搜索/筛选互斥。

## 2. MySQL 快速租户查询

- 从租户主查询删除全表密钥聚合；主查询后按当前页 user ID 批量统计 key 数。
- 普通列表使用 `(updated_at, external_user_id)` 同向倒序 keyset；搜索使用 user ID、username
  两段索引流 cursor。
- `include_total=false` 为默认；显式 true 才执行独立 count。
- 增加复合索引迁移 helper，并通过同一专用 `*sql.Conn` 上的 MySQL named lock 串行执行在线
  DDL。
- 先增加 MySQL 查询/迁移测试，再实现查询与 schema 变更。

## 3. Worker 租户统计快照

- 增加 `refresh_tenant_statistics` 默认 job，10 分钟运行一次，纳入 core worker pool。
- MySQL 使用 `(backend,status)` 覆盖索引统计；30 秒超时。
- 快照写入与当前 job lease owner 在同一事务中 `SELECT ... FOR UPDATE` 校验，拒绝旧 owner。
- 增加首次失败、保留旧快照、租约丢失和 metrics 测试。

## 4. 管理 API 职责拆分

- `GET /api/admin/tenant-statistics` 返回独立快照；没有快照仍返回 HTTP 200 和 `ready=false`。
- `GET /api/admin/background-jobs` 聚合 jobs、BYOK 队列和租户观测队列。
- 运营总览不再查询/返回后台任务数据，也不生成 worker/队列类告警。
- 保留 `GET /api/admin/jobs` 和 `POST /api/admin/jobs/{name}/run` 兼容现有调用。

## 5. 管理界面

- 增加“后台任务”主导航和 `BackgroundJobsPage`；任务状态、lease、运行时间、错误和手动运行
  统一在该页，BYOK/观测队列也迁入该页。
- 运营总览删除任务异常指标、任务卡、BYOK 卡和观测卡，文案不再提后台任务。
- 租户页删除指标卡区，改为全宽 50 行 Table；统计快照只在工具栏显示。
- 列表请求显式传 `include_total=false`；React Query 保留上一页数据，后台刷新不清空表格。
- 全局搜索仅匹配用户 ID/上游用户名；搜索与线路/Set 筛选互斥。

## 6. 验证

- Go：`go test ./internal/gateway ./internal/httpapi`
- 前端：`pnpm test -- --run` 与 `pnpm build`
- MySQL 集成：使用现有测试 DSN 运行租户查询、统计 lease 和索引迁移用例。
- 最终检查总览不含后台任务，租户首屏无精确 count 和全表密钥聚合。
