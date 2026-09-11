# Multi-Bot Hermes Source Verification

## 执行的验证命令

- `CGO_ENABLED=0 go test ./pkg/instance -run 'Test(BuildHermesProfile|ParseLastJSONLine|ProjectHermesProfiles|HermesNativeProfileID|ChannelBindingScript|ShellQuote|ConfigureQQChannelRoutesNamedHermesProfile|FinishWeixinLoginSuccess|.*Weixin)' -count=1`
- `CGO_ENABLED=0 go test ./pkg/logic/objectid ./pkg/model/factory ./pkg/model/channelloginsession ./main/api -count=1`
- `CGO_ENABLED=0 go test ./pkg/instance -run '^$' -count=1`
- `CGO_ENABLED=0 go test ./... -run '^$' -count=1`
- `go test ./internal/gateway/... -count=1`
- `pnpm exec vitest run --config vitest.config.ts <11 个多 Bot/Profile 相关测试文件>`
- `pnpm check`
- `pnpm build:cn`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- 使用临时 Git index 执行 `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`
- `rg` 检查 `instance_bots|instance_channel_bindings|instancebot|instancechannelbinding`
- 本机 Hermes venv 从 `/tmp` 导入并执行 `hermes_cli.profiles.list_profiles()` 与 `get_profile_dir()`。
- 浏览器检查 `http://127.0.0.1:5174/agents/channels/?bot=...`，打开并关闭创建 Bot 弹窗。

## 结果

- CTL Bot/Profile、微信登录与文件锁相关聚焦测试通过；API 全测试通过；本次相关包编译通过。
- service-gateway 全部 gateway package 测试通过。
- 前端 11 个相关测试文件、217 个测试通过。
- `pnpm check` 通过，TypeScript 为 `0 new`；国内站生产构建通过并生成 96 个静态页面。
- 文档校验、完整变更集 change-impact 校验与 `git diff --check` 通过。
- 最终源码中没有新 Bot/Channel Binding migration、DAO 或表引用。
- Hermes 当前实现可直接列出 default 与命名 Profiles；默认和命名目录解析符合设计。
- 5174 返回 HTTP 200；创建弹窗的主 Bot 复制选项、说明、高级设置和右下角按钮正常。

## 已知非阻断项

- 未设置 `CGO_ENABLED=0` 的 Go 测试在本机 Go 1.26/macOS 上因 `SecTrustCopyCertificateChain` 链接失败。使用 `CGO_ENABLED=0` 后，本次相关测试通过；CTL 全仓空跑继续在既有 SQLite 测试初始化处因 go-sqlite3 需要 CGO 而失败。
- 一次 `pnpm test -- ...` 因现有脚本未透传文件过滤，误跑全量并命中仓库已有失败后被终止；改用 `pnpm exec vitest run` 精确验证相关文件，217 个测试全部通过。
- 当前 5174 前端仍访问未发布新嵌套路由的线上 `api.lightvela.com`，因此真实刷新恢复 Profile 列表只能在 CTL 与 service-gateway 发布后验证；本次没有获得发布授权。

## 结论

通过。无数据库迁移方案已完成实现并通过当前可执行的相关门禁；发布后仍需补一次公网 Bot 列表与刷新切换回归。
