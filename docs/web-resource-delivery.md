# Web 资源交付设计

状态：默认单包。用户在内部npm发布命名问题解决后，确认保留字体图片优化，恢复自包含交付；此前默认PDF资源拆包的决定被替代。

## 默认交付

Web npm 包包含核心界面、PDF预览模块及其worker、CMaps、字体、WASM和许可证。PDF保留浏览器动态导入，首次打开前不加载预览模块；部署、安装和PDF打开均不需要第二个npm资源包。

Web中文使用系统字体，Inter和代码等宽字体保留Latin/Latin Extended子集，其他文字由系统字体兜底。Skills图片只压缩打包副本，不改机械同步源。Electron与嵌入式移动runtime保持资源内置。

## 部署目标与发行身份

公共发行默认主包为 `@opencraft-app/opencraft`。私有registry可通过 `OPENCRAFT_NPM_PACKAGE_NAME`、`OPENCRAFT_NPM_RESOURCE_PACKAGE_NAME` 和 `OPENCRAFT_NPM_REGISTRY` 配置发行命名；打包器把身份固定到归档和全部runtime入口，安装unit使用实际包路径，下载覆盖实际scope的registry。

独立网站连接既有daemon，使用运行时注入的 `local` / `local-codex` Host；Headless服务器使用durable Host及 `/apphost` 能力。两者是不同构建目标，不能因共用npm包名而互相安装。部署侧须使用各自频道、版本和固定归档；网站更新事务在启动候选前核对execution profile，拒绝错误目标并保留原网站。

更换发行命名须升级固定bootstrap。新版私有入口兼容公共命名的旧安装和回退；旧已打包入口不会因改环境变量或仅更新worker自动获得新名称。具体内部频道和流水线步骤由下游产品维护，不写入公共发布配置。

## 可选拆包与历史兼容

只有显式设置 `OPENCRAFT_SPLIT_WEB_RESOURCES=1` 才生成独立资源包。该模式保留用于既有安装兼容或明确需要资源按需交付的环境，默认发布流程关闭。普通完整包不生成资源引用或资源准备meta。

显式拆包时，主包绑定资源的精确packageName/version/buildId/SHA512；服务器取得、校验、原子缓存并同源提供，浏览器不接触registry凭据，用户PDF内容不上传。失败只影响PDF预览，允许重试；可用 `runtime/prefetch.mjs` 预装。历史索引与缓存继续保留，支持旧页面和回退，不因默认改为单包而删除。

## 发布与验证

每个目标一次构建、一个自包含归档。候选发布与正式频道分离，按实际版本/buildId/SHA512回读和下载核对；失败重试复用原归档，不覆写同名同版本。

独立网站包发布前在隔离状态目录真实启动固定入口，核对核心HTTP、profile和版本身份。不同目标的部分发布失败分别记录与重试，不把另一目标的发布成功覆盖为失败，也不误移动其频道。

验收包括最终tgz测量、内置PDF全部资源及许可证、无资源源时真实PDF渲染、浏览器检查/安装/回退，以及执行进程连续性。源码合入、候选发布和实际网站运行分别记录。

## 相关文档

- [Web部署与更新契约](web-deployment.md)
- [多端构建矩阵](build-matrix.md)
