# 产品插件持久包

本内部版迁入了受信任产品工厂的代码包能力：Vite 构建、原 ExtensionSupervisor 激活/撤销、Web/Headless 服务读取与本地文件系统持久快照。主体和插件仍允许紧密协作、同构建发布；本轮不建立独立 SDK、插件进程或热替换系统。

## 本次范围

来源为 mono2 `env/join` 实现提交 `81d4e3cab5d436f851b02748d95e2ebbcbc175e2` 的通用核心差异，原登记提交 `9f636a372a80c024c3cf1eeda42c7da3188c6f20`。迁入时去除 `opencraft/` 目录前缀，适配内部版真实 Headless/Compose 路径；不合并 mono2 历史、管家资料或 `.40` 宿主配置。此次基线为内部版 `origin/env/local` 的 `45eecf7dd3e5eb205f585924f04ff8c384840618`。

内部版没有来源产品的 `join.proj-overview` 插件，因此不迁入其页面和产品注册。本轮仅接入通用能力；现有 `products/join/web.ts` 的 OA 装配及服务端身份保持原路径，不能宣称现有 OA 已外置。

## 接入与所有权

产品在 Vite 配置中调用 `productPluginPacks(definitions)`，每项显式给出 `id`、`version`、`entry`、`registration`、`implementationRoots` 与同一 canonical catalogs 派生的 `locales`。`registration` 在开发时转导出原工厂，在正式 Web 构建时替换成小型加载注册器；不要为 Electron/嵌入路径隐式开启此 Web 交付格式。原工厂继续实现 `ServerWorkbenchExtension`，由原 owner 传递 `fetcher`、`getClient` 和激活信号。

插件和主体在同一模块图内构建，React/Context/Intl 等共享依赖保留相同 URL 和模块身份。构建拒绝未替换的注册入口以及产品实现泄漏到主体图。启动语言数据由同构建的 catalogs 投影，核心语言初始化不依赖插件网络请求；执行代码、样式和资源仍由外置包持有。

Vite 输出 `product-plugins.json` 与不可变插件命名空间。Web 包和 Headless 包在封装时把完整闭包拆到 `runtime/product-plugins`，移除主体根中的插件专属文件。摘要登记在 Web 包 `package.json.opencraftWeb.productPlugins` 或 Headless `manifest.json.productPlugins`；Compose 沿用 Headless 包和清单，不另建发行 authority。

Web worker 和 Headless/Compose Gateway 在监听前校验所选包并准备快照。Headless 默认使用 `<OPENCRAFT_DATA_DIR>/product-plugin-packs`，Web worker 使用既有持久 Web 状态目录；可用绝对路径 `OPENCRAFT_PRODUCT_PLUGIN_CACHE_DIRECTORY` 指定已挂载位置。容器内该目录须位于持久数据卷，不能指定镜像内临时目录。

持久目录保存按 inventory SHA256 命名的不可变代码快照，不按扫描结果激活，也没有可写的 latest 指针；当前已选择发行仍是唯一选择来源。准备过程使用异步文件 IO、逐文件校验、同步落盘和原子改名。声明的包缺失/损坏、共享模块不匹配或旧 URL 被改写时拒绝新启动，交付层沿原流程保留/回退健康实例。旧页面仍可读取已保留依赖；本轮没有自动 GC。

HTTP 读取保留既有访问准入；当前静态资源优先，缓存补齐插件专属和旧页面依赖。未知插件路径返回 404，不回落 SPA。卸载只删除插件自有样式和贡献，主体样式不受影响；这属于受信任的同源代码加载，不是安全沙箱。

## 验证与交付

`npm run test:product-plugin-packs` 覆盖真实 Vite 图、严格工厂导出、共享模块身份、CSS 图片闭包、生命周期和失败、拆包/摘要/HTTP、Web worker 与 Headless 两次启动后的持久读取。Headless 缺失选定 inventory 的负例在资源启动前拒绝。原扩展与 Headless 测试入口也纳入相应回归。

真实浏览器可用 `OPENCRAFT_TEST_PRODUCT_PLUGIN_BROWSER=1` 运行同一构建测试，按已有环境设置 `OPENCRAFT_CHROMIUM_EXECUTABLE`；它从拆包后的 HTTP 服务加载，检查 390 触控/1440、浅/深四态的共享模块、CSS 生效与卸载。业务页面、OA 服务、账户或物理手机未参与该合成工厂验证。

普通合入 `origin/env/local` 后记录精确提交；源码合入不等于部署。本次不启动 `.40` 已停用的 CI，不操作运行容器或公开 GitHub 上游。

本批验收（2026-11-10）：9 项包相关回归、8 项原 Headless 装配/关闭回归和 32 项原 Join 测试通过；真实 Chromium 四态外置加载、主题样式、单模块身份和撤销通过。新增 TypeScript 严格检查、Join 类型检查和独立平台边界检查通过；完整 Join Web 与 Gateway 构建通过，浏览器兼容检查 1065 文件 0 问题。聚合 `check:boundaries` 在既有 hover 规则的两个未改文件上失败（workspace-resource-panel.scss、design-system-web/button.tsx），不冒称全仓 gate 通过。

调用机使用独立 `npm ci` 安装，未借用其他工作树依赖。初次测试因调用机没有编译器、node-pty 未构建而中止；之后核对并采用调用机已安装运行时的同版 node-pty 1.1.0 原生输入（SHA256 `e333c757f0ef06400e4658d0784b3aa4bb0e6a6d37f67d777761eb3f1cefcea6`），修复环境后重新验收通过。该输入和任何构建产物均不提交。
