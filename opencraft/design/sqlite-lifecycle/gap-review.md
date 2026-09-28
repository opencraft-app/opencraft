# 持久化实现差距审查

日期：2026-09-18。范围：当前源码相对 docs/plugin-persistence.md 与 docs/sqlite-lifecycle.md。结论：待实施；不能作为新契约已交付验收。没有修改实现、依赖或用户数据。

## 现有问题，优先修复

### P1：Electron 插件设置与安装记录缺少稳定存储 authority

appserver-runtime-context.tsx:965、1037 无条件使用 IndexedDB 插件设置/安装适配。Electron main.ts:526 使用随机 loopback 端口，端口变化意味着新 origin，原 IndexedDB 无法被新 origin 直接读取。Main 当前仅有 UI preferences 与 Connector configuration 的专门 SQLite store，尚无相应扩展设置/安装桥。现有 extension-settings 重启测试复用同一 fake IDBFactory，只证明同一个数据库命名空间重开，不覆盖真实 Electron origin 变化。

这是源码路径确认的重启风险，本轮未用真实用户窗口复现。实施需要 Main 私有持久化与明确旧 origin 数据接管方案；不能换 adapter 后把旧 IndexedDB 留下就声称迁移完成。

### P1：插件设置没有跨实例 CAS 或失效同步

ExtensionSettingsStore.settings-store.ts:110 的 revision 是内存通知计数；set 使用单实例 Promise 队列，IndexedDB adapter.put 是无条件 put。多个实例互相不可见，不检测旧基线写入。

隔离 fake IndexedDB 复现：两个 store 打开同一库；A 写 1 后 B 仍读 0；B 写 2 成功，A 仍读 1，而数据库为 2。没有操作任何用户库。此结果证明现有并发语义，不冒充真实多标签浏览器验收。

### P1（升级路径）：Web 缺少完整 blocked/versionchange 处理

indexeddb-extension-settings-storage.ts:40 和 indexeddb-extension-installation-persistence.ts 只处理初始化升级/成功/失败，没有 blocked、旧连接 versionchange 关闭与失效状态。Connector configuration 的 open 同样缺失。未来升 DB version 时，旧页可阻塞新版本打开；上层 await 存储初始化没有形成可观察的“需关闭旧页/刷新”状态。不是当前 version=1 启动必然出错。

## 新契约尚未实现的部分

1. **通用插件 storage API**：extension-contract/index.ts:364 和 runtime 的 api 构造没有 storage；不存在 scoped namespace handle、区域授权、Host 存储 RPC、原子批次、分页快照和卸载后存储句柄撤销。现有 activation identity 与失效机制可复用，不应再造激活模型。
2. **两层迁移**：没有通用 SQLite 迁移账本/旧库接管/恢复流程。ConnectorDatabase constructor 仍以 CREATE TABLE IF NOT EXISTS 初始化；routing 的局部 ALTER 不是统一生命周期。SettingsSchemaContribution.schemaVersion 仅校验整数，未持久化到设置记录，也没有转换链。payload 不兼容目前可能投影默认值，而不是保持原数据并阻止不兼容写入。
3. **插件生命周期的存储集成**：已有停用隐藏 contribution 而保留设置测试，但还没有 storage 层的代次撤销、迁移前 drain、升级失败/回退保护、显式清除区域，以及提交中失联的确认规则。
4. **验收闭环**：现有测试不涵盖无版本旧库、跨版本/中断迁移、未知新 payload、磁盘/配额错误、checksum、Web 多标签、installed Electron origin 变化或同一个插件在两种物理后端上的完整 contract suite。

## 可复用基础

- ExtensionSupervisor 的 activation identity、generation、陈旧调用防护和逆序清理。
- ExtensionSettingsStore 的字段校验、persist-before-publish、单实例排队和停用保留。
- 现有 UI preferences / Connector 专用 Main SQLite + Preload adapter，以及 Connector 的持久 CAS；不能把这些领域 store 当作已经存在的通用插件存储。
- 各平台 replica 存储和测试结构；可重建 replica 与唯一数据仍必须分开。

## 验证

- `npx tsx --test tests/extension-runtime.test.ts tests/extension-settings.test.ts tests/extension-installations.test.ts`：22/22 passed；日志 /tmp/opencraft-storage-gap-tests.log。
- 两个真实 ExtensionSettingsStore + IndexedDbExtensionSettingsStorage，共享隔离 fake-indexeddb：复现 stale reader + 无冲突后写覆盖。
- `git diff --check` 通过。
- 未跑全部 gate/typecheck；本轮没有实现变更，以上证据不能替代未来升级或实机验收。

## 实施次序建议

先解决 Electron 设置/安装稳定存储与 Web 多标签生命周期；再交付一个 local scoped KV 的双后端纵向切片（包含持久 CAS、旧格式升级和同一 contract suite）；最后补 Host RPC/区域授权、插件更新/卸载存储生命周期和剩余数据库升级。复杂 SQL 插件能力、自动回滚、导出/同步是明确 non-goals，不计为本期 gap。
