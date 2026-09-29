# Host 通用文档存储 API

状态：2026-09-18 已实现首个 Local Agent Host 服务、AppServer client adapter 和插件 SDK 入口。Host 只提供 API，不加载插件代码；其他引擎/远端 Host 必须实际实现该协议才可使用，不以“已连接”推断支持。

## 使用方式

```ts
const remote = await api.storage?.forHost(hostId);
if (!remote) return;
const state = await remote.open("preferences");
const before = await state.read();
const saved = await state.compareAndSet(before.revision, { collapsed: true });
// 冲突时读取 saved.snapshot，调用方决定是否重试。
```

与 client-local 的 open 返回同一种文档句柄。`forHost` 只绑定明确、已初始化的 Host client，不隐式启动/重连，不跟随界面当前 Host，不把断线后的写入转存浏览器。无本地持久化 adapter 的运行时仍可单独提供 Host 文档能力；不是先造一个内存本地库来伪装支持。

## 协议与数据

| 方法/通知 | 参数/结果 | 语义 |
|---|---|---|
| `storage/documents/capabilities` | `{}` → protocolVersion=1、authority=host-session、maxDocumentBytes | 不创建数据库，只声明当前服务契约 |
| `storage/documents/read` | `{scope}` → record 或 null | 不存在不写默认值 |
| `storage/documents/compareAndSet` | `{scope, revision, version, value}` → `{updated, record}` | 同一事务内检查 revision、写值并递增；冲突返回当前记录 |
| `storage/documents/changed` | `{scope, revision}` | 成功提交后广播给该 Host 的授权客户端，不携带内容 |

record 为 `{revision, version, value}`；version 是调用方的数据格式版本，不是 Host 软件或物理 schema 版本。空 JSON 文档仍保留 revision。版本倒退在底层事务内拒绝；较旧 revision 仍按普通 CAS 冲突返回。不存在删除数据库、任意 SQL、路径、脚本上传或执行迁移函数的 RPC。

每份文档含包装最多 1 MiB、深度 32；JSON、scope、整数范围和未知参数均在服务端校验。安全错误码：`-32601` 未支持/未配置，`-32602` 无效参数，`-32040` 存储不可用，`-32041` 大小限制，`-32042` 格式降级拒绝。不得返回底层异常中的路径或内容。

## 所有权与授权

- 首个服务沿用 Local Agent Host 的单用户 token WebSocket 鉴权：拥有已授权 Host 会话的客户端可以访问该 Host 的通用文档空间。未通过握手的请求不可到达 API。
- logical client ID 只用于多路复用和通知路由，不是身份认证。调用方传入 principalId、路径或 SQL 参数直接拒绝。
- SDK 自动构造 `plugin/<extensionId>/<namespace>`，namespace 不允许越级分隔符。它用于隔离正常调用和避免误写，**不是抵御恶意 trusted 插件/已授权原始客户端的安全边界**。没有新增多租户行级 ACL 或按插件独立授权机制。
- Host 文件位于已解析的 `dataDirectory/opencraft-host-documents.sqlite`；未配置绝对数据目录就不提供该能力。Feature 不自己从 homedir/cwd 猜根，桌面路径仍由平台 Directory identity resolver 决定。
- 它与 Electron profile 的 `opencraft-extensions.sqlite` 完全分离。Host A/B 相同 scope 不共享数据；client-local 与 Host 数据不是镜像。
- 凭据继续走既有 Host 凭据服务；通用文档接口不取代认证或 Connector secret owner。

## 生命周期、迁移与失败

适配器固定 AppServerClient 身份及 connectionGeneration。每次操作前和响应后都验证该绑定；断线、Host client 被替换或插件卸载后，旧句柄失效，需要显式再次 forHost。订阅只处理当前连接通知；重连不自动重放写请求。

适配器借用应用连接，只清理自己的通知/状态监听和 AbortController，不关闭其他会话正在使用的 Host client。插件退出由现有 Cordis scope 收敛；已发出的写入取消/超时可能已在 Host 提交，不能据此声称回滚。重新连接后按 revision/内容核对；无隐式离线写队列。

插件 payload 迁移仍在客户端做纯 JSON 转换，Host 只接收最终值、格式版本和 CAS，不执行插件函数。数据+版本+迁移声明摘要作为同一份文档提交。SQLite 的物理 migration 由 Host/平台源码负责。共享 SQLite 基线沿用第一阶段 SQL/hash，提取实现没有改表名或重写历史。

## 文件职责

- `packages/document-storage/src/contract.ts`：平台无关 JSON、record、CAS、大小/版本校验；根导出不含 Node 依赖。
- `packages/document-storage/src/sqlite.ts`：SQLite driver、基线账本与事务；Electron 和 Host 共用，显式 `/sqlite` 子入口。
- `packages/appserver-protocol/src/host-storage.ts`：手写的一方扩展协议，不修改上游 generated 文件。
- `apps/local-agent-host/src/storage/host-document-service.ts`：服务端参数/错误边界、固定路径和提交通知；main 只装配路由与关闭。
- `packages/workbench-runtime/src/host-document-persistence.ts`：能力检查、协议响应校验、连接代次和借用资源清理。
- `extension-runtime/src/scoped-storage.ts`：绑定插件身份的 forHost，复用已有文档 API 和 Cordis lifecycle。

不建设 Host 插件安装器或后台插件框架；没有新增第三方依赖。纯协议与 Node backend 分入口，Expo/Web 不拉入 SQLite 内建模块。

## 验证与剩余范围

`test:host-storage` 覆盖真实 Host token 拒绝、无引擎可达性时的原始 RPC、CAS/格式降级/参数限制、重启持久化，以及 SDK 的 Host A/B 绑定、无本地实现也能使用远端、断线/替换失效、旧 Host 拒绝和不关闭借用 client。

`smoke:host-storage` 使用真实 Chromium 双标签、真实 SDK/AppServer WebSocket/Host/SQLite；仅引擎握手由隔离替身提供。检查远端通知、并发冲突、Host A/B 分离、停机不落本地、显式重连后恢复同一记录。没有真实账号、云机器或付费推理。

未宣称：所有 Host 已支持、新安装包已发行、跨设备自动同步、通用备份恢复、多租户 ACL、插件任意后台任务或跨库原子事务。其余 client-local/历史 origin 边界见 [插件持久化](plugin-persistence.md)。
