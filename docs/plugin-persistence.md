# 插件持久化契约

状态：2026-10-13 client-local 与首个 [Host 通用文档 API](host-document-storage.md) 已实现，九个自有 Node SQLite 库已接入 [共享生命周期](sqlite-lifecycle.md)。Native 适配、其他 Host 实现与历史所有 origin 找回仍未交付；无账本旧库可能备份后移开重建，不承诺所有历史数据无损升级。

## 当前最小 API

```ts
const state = await api.storage?.open("preferences");
if (!state) return; // 当前运行时未提供该能力
const current = await state.read();
const result = await state.compareAndSet(current.revision, { collapsed: true });
// 冲突时 result.updated=false，调用方检查 result.snapshot 再决定是否重试。
```

本地直接 open；远端先 `const remote = await api.storage.forHost(hostId)`，随后同样 open 和 `read / compareAndSet / subscribe`。两者不自动同步或互相回退。普通使用无版本参数；内容升级在 open 的一次性 options 中声明 version、initialValue、连续纯转换及 checksum。checksum 校验声明与历史一致性，当前没有新增打包器独立证明函数源码对应 checksum，不宣称代码完整性或安全沙箱。

每个 namespace 是一份原子 JSON 文档：连同元数据最多 1 MiB、嵌套最多 32 层；写空文档保留 revision。暂无查询 DSL、分页或任意批量脚本接口。更大数据等待真实领域需求，不扩充基础 API。

文件职责：`extension-contract/src/storage.ts` 定接口；`document-storage` 管共用文档端口/校验和独立 SQLite 子入口，`extension-runtime/src/persistence.ts` 保留已有类型名称投影；`scoped-storage.ts` 管激活和句柄，`document-migrations.ts` 管内容升级，`persistent-extension-stores.ts` 适配现有设置/安装仓库。Electron 的 `extension-data-ipc.ts` 管 IPC；Web 的 `indexeddb-extension-persistence.ts` / `client-extension-persistence.ts` 管 IndexedDB 和平台选择/旧库读取。Host RPC 与 client adapter 分开，见 Host 专题。

Electron profile 下新增 `opencraft-extensions.sqlite`，设置和安装记录也走稳定 Main 存储；Web 用产品命名空间 IndexedDB。已移除原来的两套独立 IndexedDB 设置/安装写入类。旧库只从当前可访问 origin 导入一次，拒绝未知/重复记录，不覆盖新库、不删除旧库。**过去其他随机 Electron origin 的数据没有自动扫描迁入**，历史全量找回仍是发行切换的单独门禁。

## 1. 决策

插件默认使用宿主提供的异步 JSON/KV 数据接口，不依赖 SQLite、IndexedDB、Drizzle 或文件路径。本期保留 node:sqlite，不引入 ORM。数据接口保持窄职责，不扩大权限、文件和凭据的访问边界。

| 数据 | 唯一 authority | 物理实现 |
|---|---|---|
| 当前安装/浏览器本地的插件设置与状态 | Client-local 平台存储 | Electron Main SQLite；Web IndexedDB |
| 某个执行 Host 上的插件业务数据 | 该 Host | Host SQLite；Web/Electron 都经授权 RPC 访问 |
| 可重建副本 | 对应客户端 replica owner | 原有平台 adapter；与插件唯一数据分开 |
| 凭据/令牌 | Host 凭据服务 | 现有私有数据库，不进入普通插件 KV |

客户端本地与 Host 数据是不同存储区域，不是同一数据的自动镜像。Host 离线返回 unavailable，不回退到本地 KV；切 Host 不迁移数据。客户端本地不承诺跨设备同步。账号/工作区共享存储未授权建立，后续如需要必须有独立服务 authority。

## 2. 插件身份与 API 边界

宿主按已解析的插件 ID、可信 storage area 和激活代次签发 scoped handle；插件不能在请求里指定别人的 pluginId，也不能提交任意路径/SQL。Host handle 必须绑定明确 Host 身份及权限，不能在异步请求途中追随“当前选中的 Host”。

默认能力是小型 JSON 文档：读取、带预期 revision 的整份原子提交和变更订阅。删除业务 key 通过提交去掉该 key 的新文档完成，文档保留 revision。只接受 JSON 值，超限在执行前拒绝，不截断数据。SDK 不传浏览器 transaction、Node 连接或函数到远端。

采用**命名空间级 revision**保护 read-modify-write，事务内检查 expectedRevision，提交变更后递增。删除也参与 revision，禁止“无记录→revision 归零”造成 ABA。领域已有细粒度 CAS 不因此被重写；共享插件接口与现有业务 store 的数据身份分开。

并发冲突不静默 last-write-wins，不自动重放带副作用回调。整份文档读取提供同一 revision 的快照。数据库事务成功后发布 namespace 失效通知，消费者重新读取 revision，不广播数据或 secret；不保证跨 IPC 的通知晚于应答到达。

一次提交是一个区域、一个插件命名空间的原子边界；不提供跨 Host/客户端/插件事务。调用方请求取消、连接中断或响应丢失不等于写入回滚；按当前 revision/数据重新读取确认，不盲目重复业务动作。

这些限制在可信宿主/RPC 边界执行。可信 V1 JS 的命名空间约束不是恶意代码 sandbox；社区插件是否在隔离运行时执行仍遵循主插件架构，不宣称本接口解决代码隔离。

## 3. 设置、数据和专属 SQL

- **设置**继续使用现有 ExtensionSettingsStore 的 schema 校验、串行写入和保存后通知。实现时补齐其持久化适配/边界，不新增第二个设置真源，不把领域凭据当普通 setting。
- **通用数据**使用上述 KV 契约，适合插件配置以外的小型状态。namespace 为宿主授权区域内的插件私有空间，不是一张供插件直接修改的核心表。
- **Tasks 领域行存储**：内建 `opencraft.tasks` 的任务与多会话关联使用独立 `tasks.sqlite` 的 tasks/task_conversations 结构化表，经后端打包的 typed domain API 访问。后端事务负责 CAS、排序、变更通知和 schema 基线；客户端不提交 SQL、不修改通用文档表。旧卡片库不迁移、不删除。详见 [Tasks 存储](../plugins/tasks/README.md)。
- **Host 只提供 API**：不建设 Host 插件装载器、安装/激活服务或插件专用 SQL 能力。插件经已有 token 授权的 Host API 使用文档存储，不能上传 JS、SQL 或转换函数，不通过断线落本地替代。首个 Local Host 的权限粒度是整个 Host 会话，不宣称按插件或多租户安全隔离。
- **secret**只引用既有 Host 凭据身份及授权能力。不得给 Web 插件一个返回所有 token 的通用 KV；仍遵守“凭据只存数据库”。

## 4. 两层迁移，分别负责

**物理结构升级归平台。** SQL 用有序 SQL 与迁移账本；IndexedDB 用原生 database.version/upgrade transaction。插件不能增加宿主表/索引，不能占用 IndexedDB 的全局数据库版本。

**插件内容格式升级归插件，执行与提交归宿主。** 每个 `(区域, pluginId, namespace)` 有独立 payloadVersion，插件随制品提供不可变的有序纯 JSON 转换。宿主在对该 namespace 开放业务读写前验证旧版本和转换链。

小数据迁移先取得有 revision 的一致快照，在数据库事务外运行同步、无网络/IO的纯转换，再由宿主在一次事务内 CAS 提交数据、payloadVersion 和成功记录。竞争失败后有界重新读取/转换；不能在 IndexedDB transaction 内等待网络。相同数据+迁移必须产生相同结果，不依赖当前时间、随机数或插件启动次数。

转换链缺失、checksum 不一致、未知较新 payload 或校验失败时，该 namespace 阻止写入并报告不兼容；保留原数据，不能退回默认值覆盖。插件迁移不阻塞无关插件；超出快照/批次限额的数据不硬塞通用 KV，另建有 checkpoint 的业务回填流程。

成功记录和数据同事务；异常不提前写“已升级”。插件 packageVersion、SDK 最低版本、payloadVersion、底层 schema version、CAS revision 相互独立。插件更新但 payload 未变时不做无意义重写。

## 5. 升级、卸载与回退

- 停用/重载：撤销旧激活 handle 与订阅，停止接收新操作；已进入提交阶段的操作先收敛，结果不能通知新的激活实例。保留数据。
- 复用 Cordis Context/Fiber、activationId/generation 与 dispose/drain；插件可自行创建 Worker，并在 activate 中通过 `api.subscriptions.add(() => worker.terminate())` 登记清理。不强制每插件一个 Worker，不把同源 Worker 当作安全沙箱或持久后端。
- 更新：独占该插件生命周期，停止旧写入者，再准备存储和新版激活。schema/内容迁移未通过，不开放新版业务。
- 回退：代码回退不等于数据回退。初期不自动恢复快照覆盖升级后新写入；未知新格式拒绝旧插件写入。需要恢复时停 owner、保留当前数据、明确说明损失范围后再执行。
- 卸载：默认保留数据供重装；清除本地或 Host 数据是另外的显式操作，列出区域且不得清除其他插件数据。删除 secret 按凭据服务的引用和授权策略处理，不由 KV 清理顺带执行。
- 导入/导出、跨设备同步、任意文件备份和自动插件回滚不是首轮能力。

## 6. 拓扑与平台差异

```text
extension-contract         JSON DTO / scoped storage contract / typed failures
        ↓
extension-runtime          插件身份、激活生命周期、迁移与变更发布
        ↓
platform adapters          Electron Main IPC / Web IndexedDB / Host RPC
        ↓
physical storage           SQLite migration runner / IndexedDB upgrade
```

在现有 extension-contract/runtime 中补契约和编排，平台实现与各自 owner 共置；不新增包裹所有数据的超级 StorageService。复用现有 ExtensionSettingsStore；Node 多个数据库可共享 sqlite-node 的连接/迁移/备份原语，但业务 schema 共置。详见 [存储生命周期](sqlite-lifecycle.md)。

Web 多标签是必测路径：blocked 必须可见，versionchange 停止新写入并关闭旧连接，不自动刷新丢草稿；BroadcastChannel 只作失效通知，真实并发安全依赖事务/CAS。浏览器存储可能被用户清理或配额回收，客户端持久化不等于备份保证，不能承诺 Host 级耐久性。

## 7. 首轮交付与验收

1. 固定契约和测试：插件隔离、稳定身份、区域选择、JSON 限额、CAS、删除后 ABA、commit 后通知、过期 handle 拒绝。
2. 同一个内建插件 fixture 同时跑 Electron SQLite/Web IndexedDB：保存、重启、旧 payload 迁移、并发冲突、升级 abort；先做真实纵向链，不只提交空接口。
3. Host 数据验证：Web 访问远端 owner、断线不换存储、切 Host 不串数据、权限拒绝和应答丢失恢复。
4. 插件生命周期验证：停用保留、重载撤销、升级失败保留旧数据、未知新版本拒绝写、显式卸载清理范围。
5. 复用契约验证现有 settings 与领域存储不回归；Native 未完成真实 adapter 验收之前，不宣称支持。

已新增 client-local 与 Host 文档 API，无第三方新依赖/Drizzle。`test:extension-storage`、`smoke:extension-storage:web`、`smoke:extension-storage:desktop` 验证本地契约、真实多标签和真实源码 Electron；Host 链路另由 `test:host-storage` / `smoke:host-storage` 验证。未覆盖新签名发行包、历史所有 origin 找回、所有远端 Host 或 Native 插件持久化。当前实现入口：

- [当前 OpenCraft settings owner](../packages/extension-runtime/src/settings-store.ts) 和 [实际 storage contract](../packages/extension-contract/src/storage.ts)：运行时未装配时 storage=null。字段 schemaVersion 不等于通用文档版本，任意已有设置字段变更的内容迁移规则仍须由领域补齐。

## 8. 插件的账号本地呈现偏好

可选 `api.localPreferences.forAccount(accountKey)` 是独立的呈现偏好端口，提供同步 JSON `get/set/subscribe`。平台绑定 product、已解析的 extensionId 和插件提供的已验证账号 key；插件拥有 schema、默认值、切换账号时的读取与 UI 重置。该端口不存凭据、不授予资源权限，也不代替上述业务文档的 CAS。可信插件的账号命名空间不是恶意代码安全隔离。

当前 Workbench Web 的 `LocalAccountPreferences` 适配 localStorage，按产品/插件/账号隔离，单 key 整份 JSON last-write-wins；同页写入及同源标签页 storage 事件发布失效通知。清理、配额或访问失败由插件反馈，不能冒称已保存。不跨账号、Host 或设备同步；匿名仅保留临时 UI。extension-runtime 拒绝退休 activation 的读写并回收订阅。未装配的平台返回缺失能力，不能宣称 Native 或 Electron 稳定跨启动持久化。

内建 UI key 仍由 `UiPreferencesRuntime` 与既有 IndexedDB/Main SQLite authority 管理。首个消费者是 企业身份 的创建人分组显示模式与折叠状态，账号 key 使用 provider + staffId；Shell 不读写其偏好 schema。验证见 `enterprise-identity-creator-grouping.test.ts` 与 `smoke-ioa-creator-groups.ts`，后者覆盖真实插件激活、刷新、双标签通知及账号切换（身份/RPC/照片边界为替身）。
