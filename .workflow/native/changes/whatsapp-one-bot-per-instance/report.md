# WhatsApp 同实例单 Bot 占用验证

## 实现

- CTL 使用实例内文件锁为 WhatsApp 建立独立于微信的占用记录；扫码前认领、扫码成功确认、断开后释放。
- 首次读取时将 Hermes 0.21.3 默认 Profile 的既有 WhatsApp 会话归给主 Bot；迁移只执行一次。
- Bot 列表返回 WhatsApp 占用方；当前 Bot 的通道页展示同实例限制、占用 Bot 名称与管理入口，并禁用连接。
- 更新六种国际站文档源语言、控制台六种 locale 文案及正式设计文档。

## 通过

- `CGO_ENABLED=0 go test ./pkg/instance ./main/api -run 'TestChannelBindingScript|TestWhatsAppBindingAdoptsLegacy|TestDeleteInstanceBot|TestListInstanceBots' -count=1`。
- 前端聚焦 Vitest 两个文件 78 项通过。由于本机 `localhost` 解析失败，临时配置把测试服务器与 jsdom URL 指向 `127.0.0.1`；临时文件已删除。
- `pnpm check`：i18n、文档同步和 typecheck 通过，TypeScript 171 条既有诊断、0 条新增。
- `pnpm build:global`：Next.js 编译、静态生成及 SEO 检查通过。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` 与 `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` 通过。
- 国际站 en-us、zh-sg、zh-hant、id-id 的 WhatsApp 文档产物已核对。`git diff --check` 通过。

## 环境限制与边界

- 全量前端 Vitest 在多个既有模块失败，设置页测试的直接错误为第三方组件 CSS 导入触发 Node `ERR_UNKNOWN_FILE_EXTENSION`；持续出现无关失败后终止全量运行。
- 原生 CGO Go 测试遇到本机链接器 `_SecTrustCopyCertificateChain` 错误。`CGO_ENABLED=0 go test ./...` 因 SQLite 需要 CGO、缺少 rootless Docker 而失败。受影响的 CTL 包与 API 包聚焦测试通过。
- 未连接真实 WhatsApp 账号做端到端扫码。约束范围是同一 LightVela 实例，不跨实例按号码去重。
- 本报告记录本地验证结果；用户后续已授权提交 MR，不授权合并或发布。
