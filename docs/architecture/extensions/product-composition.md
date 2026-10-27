# Extensions: Product composition

[Architecture index](../../plugin-architecture.md) · [Documentation index](../../README.md)


Headless 的 IM 与企业微信为两层可选服务端插件：IM 持有交换机绑定、来源策略和运行时
回复上下文，企业微信依赖 IM 消息 contract 并持有协议连接；核心保留自然人、准入、会话
和执行权威。私有配置显式装配，无配置不连接，不属于浏览器可安装扩展的信任范围。
配置与恢复边界见 [IM switchboard](../../im-switchboard.md)。

> 开发入口：[当前插件边界、API 与贡献路径](../../extension-development.md)。本文同时保留目标拓扑和迁移历史；目标设计不是已实现 API。当前类型以 `packages/extension-contract/src/index.ts` 为准，示例以 `examples/extensions/hello.mjs` 为准。

GitHub上游迁移要求公开Application/Headless/Relay通过产品装配端口接入下游产品/企业身份，
不能无条件导入私有插件；移除配置中的必需身份提供者必须保持拒绝，核心Actor、
成员与资源授权不下沉到产品。当前拆分尚在实施，已知直接依赖与验证不变量见
[upstream transition](../../upstream-transition.md#boundary-migration-record-and-remaining-review)，不把菜单开关当依赖隔离。

Web supervisor 通过 `WebWorkbenchSupervisorOptions.serverExtensions` 接收可信工厂，
仅在服务端工作台接入时加载；通用默认列表为空，不把 Headless 等同于企业身份。
原有 ExtensionSupervisor 继续拥有激活、失败回滚、贡献撤销和释放；产品不另建账户
注册表或替换 credentialScope/readStateScope。构建 owner 可通过
`OPENCRAFT_SERVER_EXTENSIONS_ENTRY` 显式指定本地 JS/TS 装配文件（相对 OpenCraft
workspace root）；缺失文件或 URL 拒绝构建，无配置时不探测下游目录。
该选择只改变装配入口，不证明下游产品或全部私有实现已脱离公开依赖闭包。

客户端本地缓存只消费核心 `ClientPersistenceScope` 的 namespace、固定 Host 会话记忆
分区及同步变更通知，不读取下游产品 region/profile/credential 字段。产品提供只读投影，
保留既有持久键及账号撤权时序；应用卸载仅释放订阅，不旋转持久 namespace。
此端口不是 Actor、readStateScope 或远端授权证明；资料刷新可改变记忆分区，不能据此
清除输入草稿。

`@opencraft/client-product` 提供可信客户端产品生命周期：Application 在创建 Cordis 和
应用元数据之前调用可选 `bootstrap`；Supervisor 创建唯一产品 session，先借用缓存端口，
再按产品返回顺序经既有 ExtensionSupervisor 激活，随后等待可选 preflight，最后启动
配置 Host。session 贡献可选 builtin 描述，仍由现有 ExtensionManager 读取用户持久意图。
启动失败逆序回滚；正常卸载先释放扩展和缓存订阅，再释放产品 session，不另建生命周期管理器。
Bot 管理通过 session 的可选 `botManagement` 声明 provider 准入与空态提示；省略准入
表示所有启用 profile，显式空列表表示不开放候选。核心按目录实际能力选择唯一管理
目标，不修改当前聊天 Host；产品声明不是权限授予。下游产品可在自己的 client plugin
保留云端专用策略，核心不解释私有 provider ID 或账号语义。


默认 Web/Electron 入口不选择私有产品，保留本地与远端 Host；本地缓存按服务器和可选
平台账户的不透明 scope 分区，明确 null 不回退旧 identity。没有账户贡献的 local 分区
仅属于本地客户端，不声称代表服务器登录身份。产品若拥有凭据代次，须提供自己的
ClientPersistenceScope，不能用本地 fallback 取代凭据撤权。
构建 owner 通过 `OPENCRAFT_CLIENT_PRODUCT_ENTRY` 显式选择本地装配文件，校验方式
与服务端扩展入口一致，无配置不探测下游。产品登录回调、账号创建、平台/Hermes
装配、嵌入预检和 Collaboration 描述归下游客户端产品插件；产品构建入口也由下游
提供。客户端及 Collaboration 私有包的实现、锁和测试由下游产品工作区拥有，核心不再安装
这些私有包；产品保留原包名与导出。平台/Hermes、账号SDK、三个私有共享快照
和原生产品源码也归下游；核心保留通用接口与原工作台。私有测试随owner迁移，混合
测试保留通用断言；云桌面provider三条原依赖限制由产品默认检查执行。显式私有构建
原生别名和smoke工具仍在过渡，不能据此宣称全部拆分或来源核实已完成。

Web构建预设由可信本地Vite配置组合：核心导出`createWorkbenchWebConfig`，拥有通用
能力和平台约束；下游持有私有功能选择、Next环境定义、SDK去重、允许域名、开发代理
身份与产品outDir。产品名不隐式选择私有行为；产品runner使用核心自己的Vite版本及
原预览桥、noVNC补丁、真实构建图兼容检查。私有包边界检查与发布命令也归产品，
公开核心不再提供指向下游Web目录的CLI别名。原生Bot仍使用同一产品配置及原内存
打包契约，不从远端获取执行代码。此归属变化不等于来源授权已核实。

下游产品的嵌入 element、Root、账号/物理连接 adapter 及产品集成测试由下游
`products/<product>` 拥有。构建通过 `OPENCRAFT_EMBEDDED_PRODUCT_ENTRY` 显式选择本地文件，
默认公开 Web/Electron 不附带私有嵌入图；嵌入专用 target 未配置入口直接失败。
产品构建保留原 loader URL、element API、绘制/连接与释放时序。通用绘制、发送、
音频、连接和面板 helpers 仍属于核心，不复制组件、不以空实现代替完整客户端。

普通中继的可部署边界见 [relay deployment](../../relay-deployment.md)：`apps/relay-server`
独立启动，`plugins/relay-connect` 可选出站连接；企业身份 验签、JWE 与员工字段映射属于
下游产品的企业插件，通用 Principal/成员/角色/撤销属于核心包。实例只接收固定 issuer、
公钥、实例与 Origin 范围的短期凭证；中继注册权不产生业务管理员权限。启用核心准入后，
认证插件缺失保持拒绝，不能以停用插件绕过成员授权。

## Trusted product Thread metadata and badges

The renderer-neutral `SingleContributionRegistry` in `extension-runtime` owns the
exclusive registration lifecycle for identity avatars, Thread badges and Thread
list grouping. Web adapters validate their own contribution shapes. Preparation
is side-effect free; competing prepared contributions arbitrate again at commit.
Each commit has a distinct registration identity, so an old disposer cannot
remove a later registration even when the plugin reuses the same object. The
public snapshot stays stable between changes and unloading restores `null`.
Priority-based account entrances and multi-item registries keep their own semantics.

`threadBadge` is an internal React contribution for one optional product-owned
Thread adornment. Shell owns layout, identity and overlay exclusivity; the product
owns data and content. The trailing slot takes its content width, stays right-aligned
with the existing row-menu gap, and consumes no space for absent content. 企业身份
uses it for the last three server-array participants plus a circular “…” on overflow;
the full participant Popover and creator provenance remain product-owned.

Codex Host accepts an optional Thread metadata factory against its existing shared
SQLite and native-history port. The provider observes native results/notifications,
owns explicitly advertised metadata RPCs and releases before Host storage closes.
It does not intercept model input, claim native execution ownership or add another
message identity store. Headless composition installs the optional product factory
alongside its configured identity presentation; other deployments remain unchanged.

Headless startup consumes a trusted compiled identity composition, not enterprise
imports. The adapter returns verified providers, optional request presentation and
Thread metadata, owned storage outcomes and a disposer. Core retains local/OIDC
login, membership, Actor authority and execution lifetime. External provider
principals identify verified humans; a product can further restrict eligibility
through its explicit `isHuman` predicate. Session credentials continue through
the separate Actor path and cannot masquerade as browser human identities.
The managed site owns its numeric employee binding rules, token/allowlist parsing and existing
presentation/preferences assembly outside the replaceable upstream prefix.
Standalone and managed packaging choose their entry explicitly; importing an
application module never starts an extra CLI/listener. See
[server authentication](../../server-authentication.md#headless-composition-contract).

`threadListGrouping` is an optional trusted presentation contribution in
`extension-react`: the plugin provides mode descriptors, stable group identities,
metadata watching, ordered Thread references and collapse actions. Shell owns
the display-mode dropdown/context menus, group chrome and existing navigation.
Null mode or contribution retirement restores the Shell taskflow list.
An optional filter descriptor and filterThreads/setFilterEnabled expose personal
filtering through Thread references only. Shell owns title/server filters, the
chip and hidden-row count; product identity tests and account preferences stay
inside the plugin. When personal filtering is enabled, only confirmed creator/participant membership
matches; unresolved metadata and ready empty creator/participants data are excluded.
Shell adds no unknown-membership status row or expansion control.
When 企业身份 has no display identity, it omits the optional filter descriptor; Shell
hides its chip and menu group without changing the stored preference or hiding rows.
Product-specific creator semantics, account ordering and preference schemas stay
in the plugin. The optional `api.localPreferences` port supplies generic
product/extension/account isolation and activation fencing; see
[persistence](../../plugin-persistence.md#8-插件的账号本地呈现偏好).

## Application branding

`extension-contract` declares renderer-neutral `ApplicationBrandingContribution` and
`APPLICATION_BRANDING_CHANNEL`. A trusted plugin registers one declarative descriptor;
Web validates same-origin asset URLs and consumes the existing single-contribution
registry. Commit owns cleanup, conflicting owners fail, unload/rollback restores the
OpenCraft fallback. Shell owns mark size, rail alignment and responsive geometry;
plugins own names and assets. A descriptor may set `showMarkOnMobile: false`
to keep its wordmark without a mobile drawer mascot; omission preserves the mark.
The Shell consumes the descriptor without knowing a product name. Embedded
renderers do not mutate host document metadata.

Product branding packages belong to their downstream workspace. The public Web
supervisor has no product branding imports. A trusted client product may return
managed builtins through its existing session; `ClientProductContext.defaultExtensions`
contains the resolved website/build defaults at creation time. Persisted
extension-manager choices still win. This list is not an authorization grant.
The Web supervisor owns the manager and its rollback/disposal; Electron does not
load Web-only builtins. Product composition owns names, assets and default policy.

Plugin package metadata `opencraft.extensionId`, `webBranding` and `webAssets` declares
initial HTML branding and public resources. The generic Vite adapter serves/copies
packaged plugin assets under `/plugin-assets/<directory>/`; it selects initial title
and links only for the explicitly selected branding plugin and rejects multiple owners.
The public adapter only sees packages installed inside its declared workspace.
A downstream config may use the same adapter against its own plugin directory,
so packaged assets support runtime website selection without becoming public-core
assets. Electron/embedded builds omit the Web metadata adapter.
Runtime registration is authoritative after startup: Shell updates document title and
one effect owns favicon/manifest/touch links, restoring predecessors on cleanup. A
runtime-only deployment may show neutral bootstrap metadata before activation; select
the same plugin at build time for matching pre-JavaScript title/install metadata.

Separately, a downstream build may select `OPENCRAFT_PRODUCT_PUBLIC_DIR`, a trusted
local directory resolved relative to the core workspace. The generic Vite adapter
serves its current files in development and emits their original bytes at the
same relative URLs in builds. Core defaults select no such directory. Missing or
nonlocal roots, symbolic links and collisions with core public files or generated
outputs fail instead of overriding another owner. Development requests read the
current directory, including newly generated files; preview serves the fixed built
output through Vite rather than changed source files. `copyPublicDir: false` retains
the packaged native document's exclusion of public assets. This build input is
not runtime website configuration, a remote code loader or browser-controlled input;
plugin branding still uses the separate declaration and lifecycle above.

The optional `share` declaration contains a public HTTPS origin, a same-origin
image path and a public product description. Build and runtime adapters share one
metadata projection for Open Graph/Twitter and `image_src`; initial HTML is readable
without JavaScript. Document cleanup restores previous metadata nodes as well as
links, and neutral/replacement brands remove the previous owner's share image.
Share titles are the public product name, never private conversation content.
This publishes crawler metadata, not an authenticated WeChat JS-SDK integration;
actual WeChat thumbnail selection/caching requires client verification.

Downstream managed site owns its preserved brand artwork and original asset URLs in
`products/join/plugins/join` outside the public core. Its client entry decorates the
existing account/engine product session with the managed `join.server` builtin;
its Vite config selects product-local branding metadata/assets. Explicit build
settings (including an empty list) override website defaults as before, while
persisted choices remain authoritative. The product owns its original brand
lifecycle, asset-size and desktop/mobile browser assertions; public generic tests
use synthetic plugin descriptors and the public fallback brand. This ownership
transfer does not grant redistribution rights to product artwork.

Verification: `tests/identity/application-branding.test.ts` and
`tests/extensions/extension-installations.test.ts` cover generic validation, ownership,
rollback and persisted enable/disable. Downstream tests cover original product
metadata/assets and the same desktop/mobile activation/unload/replacement paths.

Tasks member profiles consume the existing optional `IdentityAvatarContext` and
`AvatarImage`. An explicit nullable `{kind,id}` reference is display data only;
Tasks never imports the 企业身份 implementation or derives identity from a name. The
product provider resolves photos; missing providers, unknown kinds and failed
images retain the caller's initials and geometry. Profile references cannot grant
authentication, access or ownership, and task assignment works without a provider.

### Startup registration and demand presentation

扩展元数据/provider 必须在路由恢复前可发现，管理页实现不属于注册依赖。Web 的 Required/Optional/Demand 阶段、共享账户/Host 生命周期、延迟组件失败重试和连接导入取消屏障，以 [Startup resource ownership](../platform/lifecycle-and-resources.md#startup-resource-ownership) 为当前实现契约；事件名 `onStartupFinished` 本身不保证模块已脱离关键图。构建应检查真实静态依赖，见 [启动资源门禁](../../startup-performance.md)。

### Provider-owned Composer commands

`HostConnectionProvider.composerCommands` is an optional trusted client adapter.
Plugins declare localized `prompt` or `action` suggestions and implement action
execution through a protocol port bound to the resident Host. The core presents
the declarations and dispatches only explicit standalone action submissions; it
does not choose engine command names or wire methods. Provider retirement/replacement
and Host/profile invalidation reject new calls, with accepted invocations drained
under independent provider leases. This does not grant plugin authorization or
change ordinary Thread submission and queue ownership.

### Removed product built-ins

The current product's built-in declarations are the authority for bundled extension availability.
A saved built-in absent from this product is not loaded or exposed in its extension catalog;
it does not become a failed installation. Its durable record is retained so a product switch
or later reintroduction preserves the user's enabled/disabled choice. Other bundled extensions
and installed module URLs still restore independently. The background task is named
`extensions.restore`; it is not owned by a particular optional product feature.
