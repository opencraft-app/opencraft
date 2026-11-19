# User plugin：先建立机制，不迁移第一方功能

用户在 2026-11-10 明确收敛：「都是第一方插件 不用迁移 先建立 user plugin 机制」，随后更正为「几乎都是第一方」。此前客户端第一方迁出试作已撤出，未提交或推送；`plugins/`、OA 和其余第一方装配保持现状。已合入的 product pack 通用能力保留，但没有因此迁出或自动启用任何现有功能。

## 两条现有安装路径

浏览器中的 URL 安装继续由原 ExtensionManager、安装记录、制品存储和公共 API 边界持有，已有安装、启停、重载与卸载能力。本轮不另建管理器，也不提高 URL 插件的权限。

服务器所有者安装的受信任用户插件放在本地文件系统，容器内默认 `<OPENCRAFT_DATA_DIR>/user-plugins`，也可显式设置绝对路径 `OPENCRAFT_USER_PLUGIN_DIRECTORY`。该位置必须在持久卷，独立于镜像和发行版本；`dataDirectory` 根目录仍须为部署用户私有的 0700。普通用户不能通过网页提交这个可信目录、`trust` 或 `replaces` 来取得内部权限。

容器 Gateway/Headless 和既有 Web worker 都读取相同的 ABI 1 `plugins.json`；Headless 现在通过独立的 inert `opencraft-user-plugins` JSON 引导信息交付目录，避免覆盖 Host 选择、认证或连接配置。客户端兼容旧 Web worker 在 deployment config 中交付的目录。静态资产经过原 Gateway 准入，仅发布索引中插件自己的公共前缀，拒绝目录穿越、符号链接逃逸和孤立未安装目录。

## 最小可用示例

仓库 `examples/user-plugins` 包含自包含 ESM 示例与已计算摘要的索引。首次验证时将该**目录内容**放入一个独立的持久测试目录，并让候选 Gateway 的 `OPENCRAFT_USER_PLUGIN_DIRECTORY` 指向它；不要覆盖已有插件目录或改运行容器文件。目录如下：

```text
user-plugins/
  plugins.json
  public/user.hello/plugin.mjs
```

索引 schemaVersion 为 1，每项包含 extension `manifest`、`entry: "<id>/plugin.mjs"`、`sha256` 和 `replaces`（普通插件为空）。单个模块上限 512 KiB，索引上限 2 MiB/128 项；代码须自包含，默认导出原 trusted extension definition。不是 React/Node 依赖解析器或多文件 NPM 安装器；普通 JS 加静态资源先沿既有 ABI，未实现的包格式不冒充已支持。

在原设置插件目录中，服务器所有者安装的代码现在显示为“已安装”，不再因复用 managed builtin loader 而被标成内置。`origin` 表达 bundled/user 安装来源，不猜作者。浏览器控制启停，状态由原安装记录持有；服务器文件移除仍归部署所有者，浏览器不会显示可删除宿主文件的按钮。插件配置/数据仍归原 storage API，不写进发布代码目录。

## 更新、失败和边界

此阶段不是热替换：先准备文件，原子替换索引，再沿原受管 Gateway 激活流程读取；操作期间使用既有部署锁，不在生产目录写一半后直接重启。应用升级或回退不删除插件目录。本次验证的是新机制支持的版本之间切换，历史不支持目录的容器不能靠已有文件自动获得能力。模块执行/激活失败仍由原 ExtensionManager 隔离，目录格式或摘要损坏会拒绝候选启动并保留文件，交付层须保留健康旧实例。

尚未新增本地包上传 UI、宿主写入 API、自动后台启用、页面内热重载、服务端 Node 执行插件或多租户写入授权。下面的 craft 目录发现复用同一生命周期，不为用户插件引入第二套管理器或隐式宿主权限。

## Hands craft 目录

服务器所有者可将同一个私有持久插件目录挂载给 Gateway 和 Hands（例如两者均为
`/var/lib/opencraft/user-plugins`），供已授权的 Agent 在 Hands 中写入。不要把整个
Gateway 数据目录挂给 Hands，也不要扫描任意用户项目来安装全站代码。文件服务能读写
一个工作区，不表示它获得此可信目录的写入权；共享挂载由部署所有者显式授予。

```text
user-plugins/
  plugins.json                    # 原管理员安装索引，可省略；不会被发现器改写
  crafts/
    user.craft-hello/
      manifest.json               # ExtensionManifestV1 + moduleSha256 发布标记
      plugin.mjs                  # 已构建的自包含 ESM，默认导出 definition
  public/user.craft-hello/<hash>/plugin.mjs  # 自动生成的不可变快照
```

把已封存的 `examples/craft-plugins/user.craft-hello` 复制到 `crafts/` 即可发现，不用改镜像。
Agent 编辑/构建完成后运行 `node <runtime>/craft-plugin.mjs <craft目录>`，工具自动计算
摘要并原子更新 manifest 中的 `moduleSha256`，不执行插件。未封存的代码变动不会替换
上一版本。Gateway/Web worker 在新文档或目录查询时读取，最多每秒刷新一次，并发请求
共享一次发现。当前标签页不自动重建应用：**刷新网页后**进入原插件管理器，首次显式
启用；后续刷新保留原启停意图并读取新版本。代码更新不重启 Gateway、Brain 或 Hands，
也不重新分配会话。没有页面内热替换或自动刷新正在聊天的页面。

发布时先在隐藏的临时目录准备完整文件，再原子改名；原地编辑时最后写 manifest。
发现器不执行服务端代码，校验模块语法、自包含约束、大小和稳定读取后生成摘要快照。
无效/未写完的更新保留进程内上一份有效目录，错误可在经过原准入的
`GET /__opencraft_plugin_catalog` 查询；首次启动的坏插件被隔离，其他插件仍可发现。
浏览器激活时再次校验摘要和 manifest。运行时激活失败由原管理器报告，不能保证
任意插件副作用回滚，也不把语法通过称作业务激活成功。

删除 craft 源目录会在下次发现时撤下入口；既有标签页的代际仍由原 Supervisor 持有，
不会偷偷卸载正在运行的插件。旧代码快照保留供更新后的旧读者使用，本轮无自动 GC。
索引损坏时活进程保留上一份目录，新进程仍按原规则拒绝无效管理员索引启动。

craft 模块只获得现有公开 API facade，不获得 `api.internal`、`replaces` 或品牌配置
入口。**这不是恶意代码沙箱**：ESM 仍在可信 Renderer 中执行，因此目录写入者必须受
部署所有者信任，不适用于互不信任的多租户自动安装。Vela 品牌及使用内部 React/服务
接口的旧业务插件仍走管理员安装/产品装配，不借 craft 入口扩大权限。

目录上限 128 项，manifest 64 KiB，模块 512 KiB；不读 `.env`、源码、其他资产或运行
`npm install`。多文件工程先由 Hands 构建成单个模块。此发现格式需要匹配的新 Gateway
与 Web，旧发行不支持版本化入口，不能只挂目录就宣称兼容。

验收覆盖持久文件跨候选启动、发布前缀/准入/逃逸拒绝、真实管理器启停/撤销与来源投影；真实 Chromium 通过 HTTP 引导、摘要校验和 Blob ESM 加载验证。测试使用合成插件和执行端，不涉及真实 OA、引擎任务或现网安装。

本批验证（2026-11-10）：76 项原扩展/装配/关闭及新机制回归通过；28 项含原 Web 安装/升级/回退回归通过；最后一轮 4 项（含独立引导转义、最新 HTML/HEAD/ETag 断言及 390 触控/1440 真浏览器）通过，这些组存在重复覆盖，不相加冒称独立数量。扩展运行时及新前端模块严格类型检查、平台边界、完整 Join Web/Gateway 构建通过，Web 兼容检查 1065 源文件 0 问题。没有声称运行全仓 gate、构建完整容器镜像或实机安装。
