# Extensions: Identity and execution

[Architecture index](../../plugin-architecture.md) · [Documentation index](../../README.md)

### 服务端请求身份端口

通用 HTTP/WS 网关只消费 `@opencraft/app-host-server` 的受信装配端口
`WorkbenchRequestIdentity`：`admissionStatus` 返回准入结果，`connectionContext`
提供已验证的 `TransportSubmissionContext`（返回 null 拒绝连接），`handle` 在核心
准入之后处理身份来源自己的 HTTP 路由。该端口不是 Renderer 可提交的身份，
也不是浏览器扩展安装 ABI。未知网关配置项及缺少方法的身份端口在启动时拒绝。

企业身份 插件拥有签名、解密、时钟容差、员工 sender 映射及旧 HTTP 别名；通用网关
不导入 企业身份。静态文档探针使用 `/__opencraft_access/admission`，无准入配置的匿名
部署也能返回 204；启用成员校验、Actor 约束或配置的身份提供者时仍须通过相应校验。
未注册的 `/__opencraft_*` API 返回 404，不能回落成成功的 SPA HTML。

断言验证器默认只对精确的核心 GET 准入探针读取原始方法/路径头。产品旧worker
兼容由可信Headless composition的`relayAssertionOptions.additionalAdmissionProbePaths`
显式提供，relay-connect只转交这份编译装配，不从私有relay JSON或HTTP读取路径列表。
验证器校验并快照额外路径；POST、query或未声明路径不做转译，签名/Host/Origin/
实例/期限/nonce和成员授权照常生效。受管站点声明自己的旧别名，核心不内置企业路由。

所有 WS 入口同时遵守核心准入与连接证明。证明缺失、过期或提供者抛错拒绝升级，
有限的证明期限必须是有效数值。已建立连接取成员证明与上下文期限的较早值，
到期先撤销消息接收再关闭；核心继续拥有 Actor、成员撤权和资源授权。
Headless 通过可信服务端 composition 创建身份适配器；受管站点的企业参数及插件实例化
位于下游入口。企业身份 实现、专属文案与集成验证由下游拥有，公开 workspace 不依赖它。
核心 Actor/Relay 验证使用合成签名身份提供者，保留准入、撤权和持久化覆盖；企业身份 原有
签名及员工元数据验证随产品运行。下游产品客户端其余依赖仍待隔离，不称完整拆分已完成。

### Relay 启动装配

`relay-server/application` 拥有通用配置校验、路由/签名、Hub、TLS 与监听生命周期。
可信启动代码通过 `createIdentity` 工厂提供 `IdentityProvider` 与 `close`；
配置只声明认证 origin、issuer、签名 key 和允许的 provider，不加载配置指定的模块。
配置了认证却缺少工厂、声明外 provider、未知字段或不完整 TLS 均拒绝；
默认 CLI 可以运行纯中转 Hub，但不能把缺失的网关提供者当匿名继续。
启动回滚与幂等退出均释放 Hub 状态锁、监听和身份资源。

下游产品拥有旧企业配置转换及私有插件创建，并通过打包函数的 `relayEntry`
显式选择编译入口。核心默认不探测父目录或引用产品；`packageWebServer` 与
`packageRelay` 的编译期入口参数不是 HTTP/浏览器可安装插件接口。
企业身份 已迁往下游；本边界仍不等于下游产品客户端私有目录已经全部迁出。

> 状态：R3 已落地 Trusted V1 内核；生态与 Restricted Channel 仍为 Proposed\
> 架构修订：R3（Extension-first 商业 Workbench）\
> 适用平台：Vite Web、Electron、Expo iOS/iPadOS、Expo Web\
> 本文同时包含已实现内核与后续公共扩展边界；以“实现账本”为准判断当前能力。

## 8. 三种执行策略

执行策略是 Deployment Policy，不是 Extension API 类型。同一个 Extension 工程可以在本地
开发时以 `trusted` 运行，进入未知来源市场后按产品策略改用 `restricted`。

### Internal

- 随 OpenCraft 发布；
- 与应用同进程并可使用内部 Cordis/React；
- 用于核心 Chat presenter、协议 projector、浏览器 Adapter；
- 不属于公共 SDK 兼容承诺。

### Trusted

- 用户明确启用的 local/workspace/signed Extension；
- 默认使用公开 SDK，但可以在平台允许时获得 Node/DOM 等宿主能力；
- 可以同进程 Cordis scope 运行，也可以放进专用 ExtensionHost 做故障隔离；
- 不要求逐项文件/网络权限 broker；用户的信任对象是整个 Extension；
- 即便有完全权限，也仍必须遵守 Activation owner、generation fencing、稳定 ID 和 disposer；
- 导入 OpenCraft 私有包属于 unsupported 行为，而不是 Host 宣称能够安全阻止的攻击面。

这就是 OpenCraft 第一阶段最适合 vibe coding 的模式：接口直接、可调试。

### Restricted（可选）

- 面向未知 Marketplace 来源、组织受管环境或需要运行外部 App UI 的场景；
- 可以使用独立 origin、utility process、远端 Host、iframe/WebView 和受限 RPC；
- 可以启用文件、网络、终端、剪贴板、凭证和 Thread 级 permission broker；
- Host 可以设置 CPU、并发、消息大小和心跳预算。

普通同源 Web Worker 只能做线程/故障隔离，不能被宣传为安全沙箱。只有产品真的需要
Restricted channel 时，才建设和承诺相应安全边界。

UI 呈现位置与执行策略正交：Trusted 插件也可以选择 iframe；Restricted Provider 也可以
只贡献宿主原生声明式卡片。

## 9. 可选访问策略

本地 Trusted Extension 不强制启用细粒度 Permission。若组织策略或发行渠道需要 Restricted
Mode，可以把“请求访问”和“实际授予访问”分离。这里的 Permission 是 Artifact 安装上限，
不是 Agent-facing Capability Spec：

```ts
type ExtensionPermissionRequest =
  | { readonly kind: "workspace.read"; readonly roots: readonly string[] }
  | { readonly kind: "workspace.write"; readonly roots: readonly string[] }
  | { readonly kind: "network"; readonly origins: readonly string[] }
  | { readonly kind: "terminal.execute"; readonly hostScopes: readonly string[] }
  | { readonly kind: "conversation.read" }
  | { readonly kind: "conversation.write" }
  | { readonly kind: "clipboard.read" }
  | { readonly kind: "clipboard.write" };
```

Restricted Mode 下的不变量：

1. manifest 只是请求，不是授权；
2. 用户、组织策略和 Host Policy 的交集才是 grant；
3. grant 单独持久化，可撤销，可按 Host/Workspace 收窄；
4. API 每次调用在 broker 端校验，不能只在安装时校验；
5. `activeThread`/`activeResource` 类临时授权不扩展成全局权限；
6. 插件看不到原始凭证，只能调用被授权的操作；
7. 权限改变会使旧 generation 失效并重新激活。
