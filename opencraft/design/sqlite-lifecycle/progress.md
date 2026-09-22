# Progress

## 2026-09-18
- 用户将实现请求收窄为先设计；停止依赖安装与实现。
- 完成初始 SQLite owner 清单，创建设计计划。
- 未读取或修改真实用户数据库。
- 按用户追加请求完整 clone Paseo 到 ref/paseo，固定审阅 HEAD 3cc4ae28664493b2f1ad75a6a6ed1d318c76e944；未执行参考仓库脚本，工作树 clean。
- 对照 replica cache、Native/Web adapter、Agent JSON authority、设置迁移的失败重试测试与 workspaceId 回填。结论：借鉴分类和幂等，不照搬清缓存到权威库。
- 新增 docs/sqlite-lifecycle.md 设计草案及平台/文档索引链接；明确六个 Node SQLite owner、独立迁移版本、不可丢数据、过渡期旧客户端风险、文件拓扑、阶段验收。
- 当前 npm stable/RC 与 node-sqlite 指南不同，依赖版本/基线 API/锁事务行为列为实施前门禁；没有安装依赖。
- 文档 validator errors=[]、warnings=[]，staged impact passed（staging 为空），git diff --check passed。未运行实现测试、不宣称迁移功能完成。

## 设计定稿
- 用户补充 Web IndexedDB、插件兼容、BB/Obsidian 并要求定稿。
- 新增 docs/plugin-persistence.md；修订 sqlite-lifecycle.md 移除强制 Drizzle 目标，固定跨端语义、平台升级、保留驱动、有界 SQL helper 和插件迁移 owner。
- 同步 docs/README、platform-architecture 和 plugin-architecture，明确现有 V1 SDK 尚未具备目标 storage API；不新增空接口或依赖。
- 仅文档变更；最终 documentation validator errors=[]、warnings=[]，两份专题 17 个本地链接存在，git diff --check 通过。staged impact passed，但 staging 为空；不把该结果当作实现变更验收。

## 第一阶段实现与验证
- client-local scoped 文档、SQLite稳定profile存储、IndexedDB事务和版本协调、持久CAS、声明式纯内容迁移及现有设置/安装记录适配完成。
- Cordis已有激活/销毁流程接入存储：旧代次拒绝、在途提交drain、订阅清理，Worker继续用现有subscriptions登记，不造新后台框架。
- 17项存储专项通过；4个相关workspace类型检查通过；完整npm run gate退出0。最后边界校验和存储guard调整另跑聚焦测试/typecheck/真实smoke。
- 最新源码Electron构建通过；最终Electron报告 /tmp/oc-extension-desktop-pffNFI/report.json；真实Web双标签报告 /tmp/oc-extension-web-XRy1Bq/report.json。均隔离合成数据，无真实账号/推理。
- 尚未提交、推送、打包发行或替换 /Applications；历史其他origin数据不自动扫描，Host通用数据API及剩余旧库生命周期仍需后续切片。
- 交接前重跑扩展运行时+存储组合31/31通过，平台边界通过；文档validator无errors/warnings，显式责任路径影响检查通过并提示Owner review，staged检查通过但staging为空。这里只完成首个client-local切片，不把后续Host/历史恢复范围标成完成。

## Host API 切片
- 用户选定 Host 通用存储 API；按继续实现处理，沿用 AppServer，不加载 Host 插件。
- 有界检查：当前 Local Host 的 WebSocket token 鉴权后创建 local-user owner，适合 Host 会话级存储；不捏造客户端传来的 pluginId 权限证明。
- 新增共享文档模块以复用现有 SQLite 和校验代码；公共方法及适配器必须拒绝不支持/断线/Host 身份替换。
- 实现完成：3个RPC+变更通知、固定Host/connectionGeneration、SDK forHost、纯契约与Node SQLite共用模块，无Host插件运行时/SQL接口/第三方新依赖。
- 服务只使用传入的绝对dataDirectory，没有配置则不提供能力；按当前Host token会话授权，不宣称多租户/按插件ACL。文档格式倒退在底层事务内阻止，本地/Host共用该校验。
- 35项相关测试通过；完整OpenCraft gate第二次退出0；文档validator无errors/warnings，责任映射/平台边界/git diff --check通过。首轮gate的Metro转导出解析失败已通过直接导出纯contract修复，Expo Web/iOS均重验通过。
- 真实浏览器Host报告：/tmp/oc-host-storage-web-xxm5DA/report.json；最终桌面共享存储回归：/tmp/oc-extension-desktop-DykO1s/report.json。引擎握手为隔离替身，Host/协议/SQLite/浏览器为真实链路。
- 未提交、推送、部署、更新安装包或迁移真实用户数据。旧随机origin恢复、其他Host实现、Native验收和其他旧数据库全量迁移不在本切片完成范围内。
