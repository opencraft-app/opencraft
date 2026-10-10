# Server、Owner Member 与 Community 实施计划

## 1. 固定范围

依据 `18-Server-Member与Community实施设计.md`，本轮只实现：

- SQLite 单事务创建 Server、Owner Member、`#全员`；
- create/list/get Server；
- list/get Member；
- 腾讯 Community REST Adapter；
- `im.community.ensure` Worker；
- 10 秒内 201、否则 202 的混合响应；
- fake 腾讯端到端与真实腾讯 Canary。

不实现 TDSQL、XA、Saga、Invite、Member 修改/移除、普通 Channel/Topic。

## 2. TDD 实施顺序

### 阶段 1：OpenAPI 契约

- [x] RED：生成契约测试要求 createServer 同时存在 201/202；
- [x] GREEN：修改 OpenAPI、稳定错误码并重新生成；
- [x] REFACTOR：确认 59 operation 基线和 lint 不漂移。

### 阶段 2：领域 Port 与稳定标识

- [x] RED：Server command/result、Repository、Community Port 和资源标识向量；
- [x] GREEN：实现最小 Port、GroupID 与 Human Member handle 派生；
- [x] REFACTOR：保持应用层不依赖 Ent/HTTP。

### 阶段 3：SQLite 创建事务与查询

- [x] RED：真实 SQLite 覆盖八类记录、完整回滚、slug、幂等和 projection；
- [x] GREEN：实现 Ent Repository；
- [x] RED/GREEN：Server/Member 查询与 active membership 授权。

### 阶段 4：创建应用服务与混合等待

- [x] RED：创建、幂等冲突、IM 未 ready、201、202、终态失败、请求取消；
- [x] GREEN：实现 Service 和 operation 状态等待；
- [x] REFACTOR：等待不持有事务，Worker context 与请求 context 分离。

### 阶段 5：腾讯 Community Adapter

- [x] RED：create_group 请求、UTF-8 限长、业务错误、redirect；
- [x] GREEN：实现共享鉴权 REST 调用；
- [x] RED/GREEN：10025 后 get_group_info 对账与错误分类。

### 阶段 6：Community Worker

- [x] RED：lease、revision、ready skip、retry、失败、旧 owner；
- [x] GREEN：实现 Repository 与 Service；
- [x] REFACTOR：复用轮询 runner，不合并不同 operation 的领域逻辑。

### 阶段 7：HTTP、Bootstrap 与 CLI

- [x] RED：五个新增 operation 的认证、DTO、201/202 和错误出口；
- [x] GREEN：strict handler、显式路由和应用限流；
- [x] RED/GREEN：API + 两个 Worker 单进程装配与确定性 shutdown。

### 阶段 8：端到端与真实 Canary

- [x] fake 腾讯：注册 → Human ready → 创建 Server → Community ready → 查询；
- [x] 真实腾讯：独立 SQLite 和唯一 Canary 资源；
- [x] 记录脱敏资源 ID 和稳定结果；真实 Human ready，Community 因腾讯
  `10007` 权限不足未创建，不存在待自动删除的真实 Community。

### 阶段 9：最终门禁

- [x] `go test -p 1 ./...`；
- [x] `go test -race -p 1 ./...`；
- [x] `go vet -p 1 ./...`；
- [x] OpenAPI lint、fixture、module、凭证、生成漂移、gofmt。

## 4. 实施结果

- 本地 fake 腾讯闭环返回 `201`，Server、Owner Member、根 Channel 在同一事务中
  收敛为 `ready`；
- 真实腾讯 Canary 的 Human `account_import` 成功，账号 IM 状态为 `ready`；
- 真实 `create_group` 返回 `10007`。根据腾讯官方错误语义，它属于参数或功能权限
  问题，现已归类为不可重试并稳定返回 `tencent_unavailable`；
- Canary 同时发现带 `{serverId}` 的 ImplementedRoute 门禁误判。新增回归测试并
  修复参数路径匹配后，真实 `GET Server` 与 `GET Members` 均返回 `200`；
- race 复验捕获到观察器可能拼出“旧 Server + 成功 Operation”；现按
  Operation → Server 顺序读取，终态响应不会再携带旧的 `provisioning` 投影；
- Canary SQLite 与脱敏资源定位保留在
  `~/.chatserver/canary-20260730/`，真实 SecretKey 临时文件已经删除。
- 后续切换到开发版 SDKAppID `1600154578`，真实创建成功：
  Community `@TGS#_C_CHATSERVER_CANARY_1600154578` 与默认 Topic
  `@TGS#_C_CHATSERVER_CANARY_1600154578@TOPIC#_general` 均为 ready；
- 重复执行验证了腾讯真实 `10021` 已占用语义及 Community/Topic 回查路径；适配器
  不再依赖 `get_group_info` 不会返回的 `SupportTopic` 字段。

## 3. 安全

- SecretKey、UserSig 不进入源码、命令参数、日志或测试夹具；
- 真实配置文件必须普通、非 symlink、权限 `0600`；
- 腾讯错误只保留稳定 code；
- Canary 不读取或修改现有业务 SQLite；
- 真实 Community 不自动解散。
