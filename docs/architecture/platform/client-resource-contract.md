# Client resource contract

[Storage and preferences](./storage-and-preferences.md) · [Mobile data coordination](../../mobile-data-architecture.md)

状态：2026-10-26 设计基线。本文定义 Web/PWA、Electron 和移动端共用的资源语义；它不规定各平台使用同一种数据库，也不把离线能力扩展成离线执行。

## 目标

客户端资源层只解决四件事：资源属于哪个身份范围、谁是权威、如何持久化与恢复、旧异步结果如何失效。请求、分页、重试、服务端权限和执行回执仍由各领域 owner 持有。

会话列表使用远端展示副本；会话草稿、Bot Composer 草稿和未发送消息已通过具名本地文档端口接入同一平台 adapter，业务 owner 和发送状态机保持唯一。

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

资源 ID 由领域 owner 定义。会话列表按 `host + hostRevision` 隔离；会话草稿沿用 `editor slot + semantic target`，Bot 草稿沿用 Composer target，均不因重连/Host recipe revision 更换原件身份。发件箱沿用账号/部署/Host profile/thread 分区的现有队列文档，每条消息持有稳定 `commandId` 和 `clientMessageId`。存储不替业务层重新定义消息身份。

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
  read(): Promise<LocalSnapshot<T> | null>;
  clear(ownerToken: LocalClearToken): Promise<void>;
};
```

草稿、用户明确保存的本地设置和未送出的本地内容属于本地原件。调用方必须保留输入直到选定 adapter 接受并提交写入；CAS 冲突、格式降级、配额和数据库错误必须返回给调用方。IndexedDB 的事务成功只表示当前浏览器存储接受了写入，不承诺系统永不回收；不增加额外的 `storageEvicted` 业务状态。通用缓存淘汰不得删除本地原件；账号退出时由其 owner 按明确策略清除或保留，不能静默处理。

### 既有消息发件箱

不增加通用持久命令框架。`conversation-outbox` 是本地文档，其业务语义仍由 chat-runtime 的既有发件箱 owner 持有。队列接受写入后才返回 custody/清输入；发送前先接受 sending 写入，再核对当前账号验证、Host、连接和基线。持久 sending 恢复为 unknown；未知送达只按精确服务端回执消解，不能自动重放。附件/上下文等未支持的离线输入不纳入队列；删除、执行及安全操作也不能通过缓存获得权限。

### 具名文档迁移

`ClientLocalDocuments` 只开放 conversation-draft、composer-draft、conversation-outbox。版本化字符串文档使用 CAS；null 是保留 revision 的删除标记，防止未能移除的旧源复活。旧 localStorage/sessionStorage 逐记录导入，新事务接受且旧值未改变才移除旧源；失败保留旧数据，不把旧源作为新写入的第二真源。

草稿按最近接受的非空原件恢复既有编辑槽；保留有效 history 引用和多个独立槽位，输入容量/附件归属不变。并发页面从同一 revision 编辑时拒绝覆盖。读取迟到不替换已经输入的新内容。账号撤销先同步封闭旧 handle，再排队定向清理；远端副本淘汰不能清除这些原件。

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

Electron IPC 开放 thread-catalog 远端副本 v2 和上述三个本地文档 v1；Main 在打开固定 SQLite 前校验具名资源、authority、版本和预算。本地格式只接收字符串/null；远端每文档 1 MiB，本地 envelope 16 MiB 并保留各 owner 更紧的原有预算（包括 Bot 草稿 4M 字符）。枚举和本地清理只作用于明确指定的已接入领域；远端清理仍限 thread-catalog。IPC 只接纳受信任的工作台主 frame，账号 namespace 仍是应用组合根提供的展示分区，不代表 Main 已认证该账号，也不授予服务端操作权限。

三种 adapter 必须通过同一组 contract tests：重开恢复、CAS 冲突、schema 版本、账号切换、迟到写入、远端淘汰、本地原件保护、数据库/配额失败。adapter 不复制业务 fetch、分页或权限判断。

写入成功的含义由 adapter 决定：Electron/移动端 SQLite 可验证事务提交并支持普通进程重启恢复；Web/PWA IndexedDB 只提供浏览器本地写入和后续读取能力，浏览器清理、配额回收或用户清站后需要按存储缺失重新恢复。业务层不得把 IndexedDB 写入称为备份或永久保存。

## 当前接入范围

Web/PWA IndexedDB、Electron Main SQLite 已消费同一 contract。原生移动端继续通过同一端口接适配器，不复用 Electron IPC；本轮不声称已接入其安装包。Web 离线壳、草稿及发件箱各自验证；SW 只保证已准备版本的静态启动资源，不接管业务数据。

同一浏览器未退出的上次账号可以在断网冷启动时恢复自己的本地数据分区。该 marker 只选择展示/编辑数据；验证状态保持 false，不恢复 token、Actor、执行能力或发送权限。联网重新验证同一账号后才恢复正常发送准入；明确登出/换账号撤销旧分区。

## 明确不承诺

该 contract 不承诺离线模型执行、离线权限判断、离线支付/验证、iOS 立即后台发送，也不把一次成功恢复称作服务端已接受。离线启动只证明应用壳和允许展示的本地数据可用。
