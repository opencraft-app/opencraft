# Agent 创建强制绑定 Computer 设计

## 1. 目标

正式 Agent 是可运行、可收发腾讯 IM 消息的主体，不是草稿配置。任何活跃 Agent 从创建
开始都必须归属于同一 Server 内的一台可用 Computer，不允许出现未绑定 Computer 的
半成品 Agent。

若未来需要“先配置、后部署”，应新增独立的 AgentTemplate 或草稿资源；不得重新放宽
正式 Agent 的绑定约束。

## 2. 权威不变量

- 所有活跃 Agent（`deleted_at IS NULL`）的 `computer_id` 均为非空逻辑引用；Agent
  删除后保留原 Computer 引用作为历史事实。旧版本已经产生且无法可靠回填归属的历史
  墓碑可以保留空引用，但不能恢复为活跃状态。
- 创建 Agent 时，Computer 必须与 Agent 属于同一 Server、生命周期为 `active`，且已
  完成纳管并具有 TAT Instance ID。Computer 当时是否在线是瞬时状态，不影响建立长期
  归属。
- 创建成功后 Agent 初始状态仍为 `desired_state=stopped`、
  `observed_state=unknown`；绑定不等于自动部署或自动启动。
- Agent 只有在停止态才能从一台 Computer 迁移到另一台 Computer。
- 更新 Agent 不接受 `computerId: null`，也不存在“解除绑定”操作。
- Computer 有活跃 Agent 引用时不得删除。操作者必须先迁移或删除这些 Agent。
- Computer 暂时离线只影响部署、启动、重启和终端等执行动作，不妨碍创建或迁移绑定，
  不解除绑定，也不改变长期归属事实。

## 3. HTTP 契约

这是已发布 2.0 契约的破坏性变化，不直接改写或覆盖 2.0 baseline。平台发布新的正式
OpenAPI 3.0 契约；当前部署只提供最新产品契约，因此继续使用稳定的 `/v1` 产品路径，
不并行暴露 2.0 写接口。新版本
`CreateAgentRequest` 的 required 集合加入 `computerId`，字段类型由 `NullableId` 改为
`Id`。省略、显式 `null`、无效 UUID、跨 Server Computer 或未完成纳管的 Computer 均
拒绝创建。新版本 `Agent` 响应也必须把 `computerId` 列入 required 并使用非空 `Id`。

2.0 OpenAPI snapshot 保持逐字节不变。3.0 必须拥有独立 release snapshot、生成代码
和兼容性基线；兼容门禁只禁止同一主版本内的破坏性变更。正式切换 3.0 后，产品前端与
Computer/Runtime 客户端统一使用新契约，不提供双写或旧 Agent 创建路径。

切换按以下顺序完成，不存在新旧写语义长期并行的窗口：

1. 部署新版本代码，但暂不开放新主版本 Agent 读写；
2. 进入短暂的 Agent 管理写维护窗口，下线 2.0 的 Agent create/update 写路径；聊天、
   已运行 Runtime 和其他平台资源不受影响；
3. 按 Server 修复或删除所有活跃空绑定 Agent，并完成覆盖审计；
4. 审计为零后启用活跃 Agent 的全局非空绑定门禁，开放新主版本 Agent 读写；
5. 2.0 Agent create/update 保持下线，不再产生空绑定；2.0 snapshot 仅作为已发布历史
   契约保留。

新主版本在第 4 步之前不得读取或返回可能为空的旧 Agent。任一步失败都保持 Agent 管理
写入关闭，不回退到允许空绑定的旧写路径。

`UpdateAgentRequest.computerId` 保持可选，含义是：

- 字段省略：不修改绑定；
- 字段为有效 `Id`：在 Agent 停止时迁移绑定；
- 字段为 `null`：请求结构非法。

创建和迁移遇到不存在、跨 Server、已删除或未纳管 Computer，返回稳定错误
`computer_not_ready`。只有部署、启动、重启和终端等执行动作才因瞬时离线返回既有
`computer_offline`。

## 4. 数据库与迁移

Ent Schema 和物理列暂时保留 nullable，以兼容无法可靠回填归属的历史墓碑；nullable
不是活跃业务状态。应用服务和仓储事务双重拒绝创建、恢复或更新出
`deleted_at IS NULL AND computer_id IS NULL` 的记录。一致性扫描增加以下规则：

- 活跃 Agent 必须指向同 Server、`lifecycle_state=active` 的 Computer；
- 墓碑 Agent 的非空 Computer 引用必须指向同 Server 且仍存在的 Computer，允许目标为
  `removed`；
- 历史墓碑的空 Computer 引用单独报告为 legacy warning，不阻断运行面。

不增加数据库外键；`server_id` 仍是 Agent 的 ShardKey。发布前的升级审计按 Server
路由检查活跃空绑定，必须在 migration revision claim 之前完成；发现问题时不得创建
revision，不得随机绑定、静默删除或猜测目标 Computer。SQLite 在单机事务中扫描。

TDSQL 当前没有可供应用在线分页的全局 Server ID registry，本次不假设该能力存在，也
不为一次升级新增常驻业务表。运维流程通过 TDSQL 管理面/离线导出生成不可变的完整
Server 分区清单；清单包含生成时间、总数和 SHA-256。审计器逐项携带 `server_id` 点分片
扫描，记录已扫描 ID、水位、结果和清单 hash，全部覆盖后才签发通过证明。应用实例不得
自行执行无 shardkey 的 `DISTINCT server_id` 或广播查询。缺少清单、清单 hash 改变、
扫描未覆盖全部条目或写维护窗口失效时，切换失败并保持新写路径关闭。

待历史墓碑归属全部完成受审计修复后，可以在后续版本把物理列升级为 `NOT NULL`，不与
本次行为收紧耦合。

## 5. 应用与界面行为

Agent 创建服务在生成 Agent ID 和提交 IM Operation 之前验证 `computerId` 必填；仓储
层在事务内再次验证 Computer 归属、active 状态和纳管事实，防止绕过应用服务。创建
事务只增加目标 Computer 的 `assignment_revision`。在线状态不参与该事务。

Agent 管理页的新建表单必须选择 Computer；没有可用 Computer 时禁用提交，并引导用户
先创建和纳管 Computer。编辑表单移除“未绑定”选项，只允许在停止态选择另一台可用
Computer。界面不得把“已绑定”表述成“已运行”。

## 6. 验收条件

- OpenAPI 和生成客户端把创建 `computerId` 表达为必填且非空；
- 2.0 release snapshot 不变，3.0 具有独立 snapshot、生成物和兼容基线；
- 旧写路径先下线、存量修复和覆盖审计完成后，新写路径才开放；切换期间不会继续产生
  空绑定 Agent；
- 省略或传 `null` 创建 Agent 均在进入持久化前失败；
- 跨 Server、removed 或未纳管 Computer 无法用于创建；
- 使用同 Server、已纳管但暂时离线的 active Computer 仍可创建，Agent 保持
  stopped/unknown；启动时准确返回 `computer_offline`；
- 停止态 Agent 可以迁移到另一台可用 Computer，运行态迁移被拒绝；
- 任何更新都不能清空 Computer 绑定；
- 有活跃 Agent 的 Computer 删除被拒绝；
- tombstoned Agent 可以保留指向 removed Computer 的历史引用；
- Assignment revision、幂等结果和 IM 身份创建行为保持正确；
- SQLite、TDSQL、OpenAPI 兼容检查、生成检查及前后端测试全部通过。
- TDSQL 审计报告可证明分区清单 hash、总数和逐 Server 覆盖完整，无在线广播查询。
