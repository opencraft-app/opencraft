# Client resource contract

[Storage and preferences](./storage-and-preferences.md) · [Mobile data coordination](../../mobile-data-architecture.md)

状态：2026-10-26 设计基线。本文定义 Web/PWA、Electron 和移动端共用的资源语义；它不规定各平台使用同一种数据库，也不把离线能力扩展成离线执行。

## 目标

客户端资源层只解决四件事：资源属于哪个身份范围、谁是权威、如何持久化与恢复、旧异步结果如何失效。请求、分页、重试、服务端权限和执行回执仍由各领域 owner 持有。

首个资源是会话列表的远端展示副本。后续草稿和发件箱复用同一套身份与生命周期端口，但拥有独立的写入语义。

## 资源身份

核心持久化身份固定为：

```ts
type ClientResourceScope = {
  product: string;       // 产品身份
  deployment: string;    // 稳定部署/服务入口身份
  account: string;       // 稳定账号；未登录使用 installation scope
  host?: string;         // Host 稳定身份
  hostRevision?: number; // Host recipe/config revision
};
```

`region` 不属于核心 scope。当前 deployment 已经是隔离边界；只有某个下游产品确实在同一 deployment 内维护互不相容的区域账号空间时，才由该产品扩展自己的 scope，并且不能改变核心资源的 authority 语义。

`authEpoch` 和 `connectionGeneration` 是运行时栅栏，不是持久化身份：它们用于在读写前后拒绝登出、换账号、换连接后的迟到结果。把它们写进 key 会为每次重连制造孤儿副本，也不能替代账号撤销和显式清理。

资源完整身份为：

```ts
type ClientResourceIdentity = {
  scope: ClientResourceScope;
  name: string;
  id: string;
  schemaVersion: number;
};
```

资源 ID 由领域 owner 定义。会话列表的 ID 是 `host + hostRevision`；草稿的 ID 是 `host + hostRevision + thread`；发件箱的 ID 是稳定 `commandId`，不能使用数组下标或时间戳替代。

## 三种资源语义

### 远端展示副本

```ts
type RemoteProjection<T> = {
  authority: "remote-projection";
  observe(value: T, fence: ClientResourceFence): Promise<void>;
  read(): Promise<DisplaySnapshot<T> | null>;
};
```

服务端是权威。只有成功的远端响应可以 `observe`；请求失败不能清空旧值。完整成功的空响应可以替换旧值。副本可以按容量策略淘汰，恢复出的数据只能展示，不能授予发送、执行、删除、支付或权限操作。

### 本地原件

```ts
type LocalOriginal<T> = {
  authority: "local-original";
  commit(value: T, expectedRevision: number, fence: ClientResourceFence): Promise<AcceptedCommit>;
  read(): Promise<DurableSnapshot<T> | null>;
  clear(ownerToken: LocalClearToken): Promise<void>;
};
```

草稿、用户明确保存的本地设置和未送出的本地内容属于本地原件。调用方必须保留输入直到选定 adapter 接受并提交写入；CAS 冲突、格式降级、配额和数据库错误必须返回给调用方。IndexedDB 的事务成功只表示当前浏览器存储接受了写入，不承诺系统永不回收；不增加额外的 `storageEvicted` 业务状态。通用缓存淘汰不得删除本地原件；账号退出时由其 owner 按明确策略清除或保留，不能静默处理。

### 持久命令

```ts
type DurableCommand = {
  authority: "durable-command";
  commandId: string;
  idempotencyKey: string;
  target: ClientResourceScope;
  state: "queued" | "sending" | "unknown" | "acknowledged" | "failed" | "cancelled";
  expiresAt: number | null;
};
```

发件箱不是普通 local resource。只有后端明确提供幂等键、回执和冲突规则的命令才能进入发件箱；未知送达不能自动重放，过期和取消都必须保留可观察结果。付款、验证、删除和安全操作默认不进入发件箱。

## 运行时栅栏

```ts
type ClientResourceFence = {
  scopeRevision: number;
  authEpoch: number;
  connectionGeneration: number;
  isCurrent(): boolean;
};
```

每个外部异步读写都必须携带并在发起前、存储读取后、CAS 前后检查 fence。scope、账号、Host recipe 或连接代次变化后，旧结果只能被丢弃；不得写入新 scope，也不得通过旧缓存恢复新账号的交互权限。资源对象不能把 fence 作为可选参数。

跨运行时只传递无敏感值的失效事件：

```ts
type ResourceInvalidation = {
  identity: ClientResourceIdentity;
  revision: number | null;
  reason: "updated" | "revoked" | "session-ended" | "host-replaced";
};
```

原生层与 WebView 不共享 QueryClient 或内存资源对象。事件只触发重新读取/失效，不传 token、完整响应或执行能力。

## 平台施工边界

| 平台 | 物理存储 | 连接 owner | 允许的桥接 |
|---|---|---|---|
| Web/PWA | IndexedDB | 浏览器应用组合根 | Service Worker 只负责静态壳/HTTP 资源，不持有业务权威 |
| Electron | Main SQLite | Electron Main | Preload 暴露固定资源端口；Renderer 不给路径、不发 SQL |
| 移动端 | 原生/Expo SQLite | Native coordinator | WebView 只接收窄失效事件，不直接访问原生数据库 |

当前 Electron IPC 只开放已接入的 `thread-catalog` 远端副本，Main 校验资源名、authority、版本和写入预算；清理仅删除该资源名的远端数据，不影响本地原件或其他领域。底层 SQLite adapter 的本地原件能力不等于已向 Renderer 开放草稿写入入口；后续迁移按实际领域逐个接入。IPC 只接纳受信任的工作台主 frame，账号 namespace 仍是应用组合根提供的展示分区，不代表 Main 已认证该账号，也不授予服务端操作权限。

三种 adapter 必须通过同一组 contract tests：重开恢复、CAS 冲突、schema 版本、账号切换、迟到写入、远端淘汰、本地原件保护、数据库/配额失败。adapter 不复制业务 fetch、分页或权限判断。

写入成功的含义由 adapter 决定：Electron/移动端 SQLite 可验证事务提交并支持普通进程重启恢复；Web/PWA IndexedDB 只提供浏览器本地写入和后续读取能力，浏览器清理、配额回收或用户清站后需要按存储缺失重新恢复。业务层不得把 IndexedDB 写入称为备份或永久保存。

## 施工顺序

1. 稳定 shared contract、scope 和 fence；补三种 authority 的测试夹具。
2. 移动端实现 SQLite adapter 和 Native coordinator；先接会话列表展示副本。
3. 将草稿迁移为 `local-original`，保留当前草稿 owner 的容量、附件和账号撤销规则。
4. 仅对有后端幂等/回执合同的消息命令实现 `durable-command`。
5. Service Worker 完成离线启动壳；它与业务资源层独立验收。

## 明确不承诺

该 contract 不承诺离线模型执行、离线权限判断、离线支付/验证、iOS 立即后台发送，也不把一次成功恢复称作服务端已接受。离线启动只证明应用壳和允许展示的本地数据可用。
