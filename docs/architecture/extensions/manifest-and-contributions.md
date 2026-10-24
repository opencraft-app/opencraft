# Extensions: Manifest and contributions

[Architecture index](../../plugin-architecture.md) · [Documentation index](../../README.md)

## 7. 公共 Manifest 与 API

### 7.1 当前 Manifest V1

可安装可信模块导出 `OpenCraftExtensionDefinition`。以下是当前合法的 Manifest；
完整字段以 [ExtensionManifestV1](../../../packages/extension-contract/src/index.ts) 为准。

```ts
const manifest = {
  manifestVersion: 1,
  id: "example.hello",
  name: "Hello extension",
  version: "1.0.0",
  apiVersion: 1,
  trust: "trusted",
  platforms: ["web", "electron"],
  activationEvents: ["onStartupFinished"],
};
```

当前 `apiVersion` 是数字，Host 仅接受 1；平台值为 `web | electron | expo`。
`dependencies` 是必须已经 active 的扩展 ID，不是版本范围解析或下载请求。
不能从声明 activation event 推定已有完整惰性调度；平台声明也不代表该平台已有安装器。
`engines`、`requestedPermissions`、`provider/sandboxUi entrypoints` 属于后续设计，
不是当前 V1 可消费字段。可信产品编译入口与用户安装的模块 URL 是不同的装配边界。

### 7.2 当前公共 API

公开类型 `OpenCraftExtensionApiV1` 提供：

- 生命周期：`signal`、`identity`、`subscriptions`；
- 数据：可空 `storage`、可选 `localPreferences`；能力存在性以实际宿主为准；
- 贡献：`commands`、`settings`、`views`、`navigation`、`sidebar`、`workbench`、
  `themes`、`bots`、`window`。

此处的 View/Workbench 注册描述支持的贡献，不承诺加载任意 React UI。
`window.showAnnouncement` 只提交数据，由应用拥有窗口、焦点、Portal 与销毁。
现有可信产品装配可访问更多内部接口，不属于可下载模块的公共 ABI。

公共 API 不提供根 Cordis Context、React Component、Query client、
AppServer Transport、可变 Replica、文件系统或 Electron IPC。
可信模块仍运行在 Renderer realm；这不是隔离执行宿主。
数据与生命周期语义见 [插件持久化契约](../../plugin-persistence.md) 与
[可运行示例](../../../examples/extensions/README.md)。

#### 7.2.1 稳定性契约与后续目标

V1 只做向后兼容增加；删除成员或改变语义须提出 V2 与迁移路径。
当前已有 API 1/平台兼容拒绝、失败清理和安装恢复测试，不代表下列目标全部实现：

- API/engine 版本范围协商、机器可读跨端 capability discovery；
- 完整依赖解析、声明式权限授予、隔离宿主及版本化 RPC；
- 发布 SDK、统一旧版本兼容样本和跨端完整 contract suite；
- API 废弃诊断与公开迁移窗口。

新增公共能力须带现有消费者兼容与生命周期证据，不能直接把产品内部 Context、
React props 或生成协议类型变成稳定 SDK。贡献方法见 [贡献指南](../../../CONTRIBUTING.md)。

### 7.3 发行、解析与 Artifact

当前 V1 先提供明确标记为可信开发通道的 `module-url`。它用于团队内部和插件 SDK
成形前的快速迭代，不冒充正式 Marketplace 安装：

```text
module-url
  -> download bounded self-contained ESM + SHA-256
  -> validate dependencies and evaluate saved bytes
  -> validate manifest + platform + API version
  -> persist disabled InstallationRecord
  -> activate one Supervisor generation
  -> persist enabled=true only after activation succeeds
```

新安装把产物独立保存为摘要寻址文档、安装记录只保存引用；进程重启不重新下载已固定的源 URL。
该内容校验不是签名或发布者信任校验。只有显式 reload 请求候选版本；候选激活或保存失败保持
原安装指针，并尽可能恢复本进程旧定义。清理失败报告 failed，不能保留不存在的 active 状态。

安装事务分为三层所有权：Installation Repository 保存用户意图，Module Loader
解析工件，Extension Supervisor 保存活跃实例；三者由 Extension Manager 串成唯一事务。
启用是“先激活、后保存 enabled”，停用是“先保存 disabled、后卸载”，所以刷新永远以明确的
用户意图恢复，而不会把半成功运行态误当成安装事实。损坏记录和单插件加载失败会隔离，不阻塞
Workbench 启动。Web 端记录保存在产品命名空间内的 IndexedDB；入口必须开启 CORS、使用
HTTPS（当 OpenCraft 由 HTTPS 提供）并自行 bundle 私有依赖。外部模块只得到冻结的公共
`OpenCraftExtensionApiV1`，不会得到内部 Cordis seam。

最小入口是一个无需私有 OpenCraft import 的自包含 ESM：

```js
export default {
  manifest: {
    manifestVersion: 1,
    id: "com.example.hello",
    name: "Hello",
    version: "1.0.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web"],
    activationEvents: ["onStartupFinished"],
  },
  activate(api) {
    return api.commands.register(
      { id: "com.example.hello.greet", title: "Greet" },
      () => "hello",
    );
  },
};
```

正式 Marketplace 仍采用下面的 Verified Artifact 链路；届时 `module-url` 保留为显式的
Developer Mode 来源，而不是自动升级为已验证包。

`local/git/npm/remote` 是来源描述，不是可直接执行的 URL。安装链路必须显式经过：

```text
CatalogEntry
  -> DependencyResolution + PlatformResolution
  -> VerifiedArtifact(hash/signature/manifest)
  -> ContentAddressedStore
  -> InstallationRecord
  -> Activation
```

规则：

- manifest、入口文件、资源清单和最终 hash 一起进入安装记录；
- 依赖图按 Profile/Host 生成确定性 lock，循环依赖和不兼容 API 在激活前失败；
- 社区扩展默认自行 bundle 私有依赖，只把版本化 OpenCraft SDK 视为 host-provided API；
- 插件不能共享主应用的 React、Cordis 或任意 npm 单例，避免 ABI/实例冲突；
- 正式 Marketplace 的 Web 安装不从任意 CDN `import()` npm 包；Verified Artifact 只能从
  受控独立 origin 加载；这不包含显式可信 Developer Mode 的 `module-url`；
- 更新先安装并验证新 Artifact，再创建新 Activation，贡献提交成功后才切换当前版本；
- 旧版本保留到新版本通过健康门，失败时回滚 Installation pointer；
- uninstall 先停用并撤销贡献，再删除 Installation；Artifact 的物理 GC 独立、可重试。

Artifact Store 是安装基础设施，不是业务状态，也不进入 Replica。远端 Host 的 Artifact
由该 Host 管理；浏览器客户端只取得 catalog/projection 和经过策略允许的 sandbox 资源。

## 10. Contribution 模型

### 10.1 所有登记都必须带 Owner

当前多个 Registry 只用裸 `string` 作为 key。目标接口必须携带来源：

```ts
export interface ContributionOwner {
  readonly activation: ExtensionActivationKey;
  readonly apiVersion: string;
  readonly trustTier: 0 | 1 | 2;
}

export interface ContributionRegistration<T> {
  readonly id: ContributionId;
  readonly owner: ContributionOwner;
  readonly value: T;
  readonly priority?: number;
}
```

规则：

- ID 必须位于 extension namespace；
- 完全相同 ID 不能静默覆盖；
- 只有明确定义的 replacement point 才允许 override；
- priority 只用于允许多实现的 provider，不用于绕过唯一所有者；
- owner 卸载时全部自动撤销；
- Registry snapshot 暴露 provenance，方便诊断“是谁注册了这个 View”。

### 10.2 公开贡献面

| 贡献面 | 社区扩展 | 可信内建 | 说明 |
| --- | --- | --- | --- |
| Commands / menus / keybindings | 是 | 是 | 执行经能力 API；冲突可诊断 |
| Workbench resources / views | 是 | 是 | 社区 UI 为 sandbox/declarative view |
| Settings schema | 是 | 是 | Host 生成字段 UI，值与页面位置分离 |
| Settings page / navigation / sidebar catalog | 声明式 | 是 | View 与入口分离；可信内建可登记平台 renderer |
| Bot identity / action | 是 | 是 | 数据提供方不拥有侧栏；Bot Panel 统一投影、置顶和拖拽 |
| Composer suggestion/provider | 是 | 是 | 返回 typed item；不取得编辑器实例 |
| Tool activity presentation | 受限 | 是 | 社区返回声明式卡片或 sandbox URI |
| Chat AST renderer | 受限 | 是 | 社区不能注册任意 React Component |
| Theme/icon/token extension | 受限 | 是 | V1 已支持双明暗语义 palette；不覆盖任意全局 CSS |
| Protocol projector / Resume strategy | 否 | 是 | 属于一致性和安全核心 |
| Replica reducer / Resume strategy / Auth | 否 | 是 | 属于一致性或凭据核心 |
| Connection provider factory | 否（V1） | 是 | 只产出 Transport；Application 持有实例并管理 lease |
| Browser engine / physical Surface | 否 | 是 | 社区只能请求 Browser capability |

### 10.3 View 恢复

Workspace checkpoint 只持久化：

```ts
interface ExtensionViewCheckpoint {
  readonly contributionId: ContributionId;
  readonly extensionVersion: string;
  readonly stateVersion: number;
  readonly state: unknown;
}
```

恢复时先解析 Extension，再做 state migration，最后创建 View。插件缺失、禁用或迁移失败
时显示稳定 placeholder，不能让整个工作台白屏。View 关闭只销毁 View instance，不自动
停用 Extension；Extension 停用会关闭或占位它拥有的全部 View。
