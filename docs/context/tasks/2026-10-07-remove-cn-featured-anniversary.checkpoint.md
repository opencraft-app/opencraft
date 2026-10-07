## stage
国内站精选卡片替换、追加育儿大师并把腾讯文档插入第 5 位完成，待用户审阅本地差异。

## verified
- 国内精选首屏顺序为 find skill、提示词生成大师、`@indiv-ebandao/dev-expert`，周年活动卡不再显示。
- 育儿大师以 `@indiv-ebandao/parenting-expert` 追加到精选末尾，分类同名条目使用同一完整身份。
- 腾讯文档以 `@tencent-adm/tencent-docs` 放在第 5 位，分类同名条目使用同一完整身份；精选共十一张，末页两张。
- 定向 Vitest 73/73、`pnpm i18n:check`、`pnpm check`、`pnpm build` 和 `git diff --check` 通过。
- 三张新增技能的独立 WebP 横幅、中文详情、完整来源和安装身份已接入。
- 本地国内站预览运行于 `127.0.0.1:5175`，`/agents/skills/` 返回 HTTP 200，开发版 `_next/static`、腾讯文档横幅与同源 OpenCraft 脚本均返回 HTTP 200。

## unverified
- 未验证线上页面；源码变更尚未提交或发布。
- 线上页面仍使用旧版本，需后续提交与发布才会更新。
- 浏览器中的技能页显示“请先登录”；需用户正常登录后才能目视核对精选卡片。

## discard
- 复用主检出 `node_modules` 导致本地 workspace 包解析失败；已在 worktree 离线安装对应依赖。本机 `localhost` 解析失败，测试使用临时 `127.0.0.1` 配置，已清理。
- 默认 5174 端口由另一个 LightVela 工作树占用，未中断该进程；本任务预览使用 5175 端口。

## restore
- 工作目录：`/Users/pablozhong/.codex/worktrees/remove-cn-featured-anniversary/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-07-remove-cn-featured-anniversary.md`。

## next_action
用户可在本地浏览器预览页正常登录，随后核对精选卡片；继续保留 5175 端口服务供查看。
