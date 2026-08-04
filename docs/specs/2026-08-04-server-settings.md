# Server 设置实施规格

## 目标

为每个 Server 增加独立设置页，首版允许 Owner 和 Admin 修改 Server 名称与描述。Slug 作为稳定路由标识只读展示，不允许修改。

## 方案选择

- **独立 `/s/{slug}/settings` 页面（采用）**：信息架构清晰，可复用现有管理页面壳，未来可以自然增加其他 Server 级设置。
- 标题栏弹窗：入口轻，但表单状态、错误与权限容易和聊天界面耦合。
- 合并到成员页面：实现最少，但 Server 元数据不属于成员管理，长期会使页面职责混乱。

## 契约与权限

- 复用已经发布的 `PATCH /v1/servers/{serverId}`，不修改 OpenAPI。
- 请求体仅使用已有字段 `name`、`description`。
- 请求携带 `X-Resource-Revision` 与 `Idempotency-Key`。
- Owner 和 Admin 可以更新；权限事实来自 `members` 权威表：按 `server_id` 查询当前账号对应的 active human member。禁止使用 `account_server_memberships` 账户侧投影鉴权。普通 Member 返回 `permission_denied`，前端不显示设置入口。
- 名称去除首尾空白后必须为 1–100 个字符；描述去除首尾空白，空字符串按 `null` 保存，最大 1000 个字符。
- Revision 不匹配返回 `revision_conflict`；同一幂等键与不同请求内容冲突返回 `idempotency_conflict`。

## 后台

- 在 ServerMember 应用边界增加 `UpdateServer` 命令和 Repository 操作。
- 单个 `server_id` 分片事务内依次完成：权威 Member 鉴权、幂等记录读取、Server revision CAS、元数据更新、revision 自增和幂等响应持久化。
- 幂等记录必须在 revision CAS 前读取。同一幂等键重放直接返回已保存响应，不得因当前 revision 已变化而误报冲突。
- 若两个同键请求并发且最初都未读到幂等记录，后到事务在 CAS 未命中后必须通过新的已提交读重新检查该幂等键：哈希一致则返回先到事务保存的响应，哈希不同则返回 `idempotency_conflict`；只有确实没有同键记录时才返回 `revision_conflict`。
- 请求哈希包含 expected revision、字段存在标记和规范化后的字段值。
- 事务路由严格为 `servers.id = serverId`、`members.server_id = serverId`、`idempotency_records.partition_key = serverId`；不得在该事务中读写账户分片投影。
- 不新增表、不修改 Schema、不新增 Migration。
- Server 名称是平台业务元数据，不修改腾讯 IM Community 的技术名称，也不产生腾讯 Operation/Outbox。
- HTTP Handler 接线现有 strict OpenAPI `UpdateServer`，并加入 Human 已实现路由列表。

## Web

- Client Core `PlatformApi` 增加 `updateServer`，使用已有 OpenAPI 类型并发送 revision、幂等头。
- Zustand Store 增加 `updateServer` action；成功后同时替换 `servers` 列表中的对应资源，当前路由标题和侧栏随状态更新。
- 新增 Expo 文件路由 `/s/[serverId]/settings` 和 `ServerSettingsScreen`；公开 canonical URL 始终是 `/s/{slug}/settings`，通过 `ServerRouteBoundary` 解析并规范化旧 ID 路径，同时加入内部安全路由白名单。
- 页面字段：名称、描述、只读 Slug；只有 Owner/Admin 能进入编辑页面。
- 保存期间禁用重复提交；成功后表单采用服务端返回值；失败时保留用户输入并显示现有产品错误。
- 同一次网络重试复用同一个幂等键；用户修改内容或 revision 冲突后生成新键。revision 冲突时重新读取最新 Server/revision，同时保留当前草稿供用户再次确认保存。
- Workspace 管理导航增加“设置”，仅对 Owner/Admin 显示。

## 验收

- Owner/Admin 可以修改名称和描述，响应 revision 增加 1。
- 普通 Member 无入口，直接调用接口返回 `permission_denied`。
- 旧 revision 返回 `revision_conflict`，不得覆盖新值。
- 同一幂等键重放返回相同结果；不同请求返回 `idempotency_conflict`。
- 两个同键同内容请求并发时最终返回完全相同的已持久化响应，不得让后到请求误报 `revision_conflict`。
- 名称为空、超长或描述超长返回 `invalid_request`。
- 修改成功后侧栏、页面标题和设置表单立即显示新名称，无需刷新。
- Slug 不可编辑，原有链接保持不变。
- 后台完整测试、race、生成/兼容门禁与前端完整验证全部通过。
