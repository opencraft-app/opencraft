---
id: remove-cn-featured-anniversary-checkpoint-2026-10-07
type: task
scope: 国内站技能精选任务的历史恢复点。
triggers: ["domestic skills featured checkpoint", "SkillHub curation recovery", "skills page handoff"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-07-remove-cn-featured-anniversary.checkpoint.md
status: stale
reviewed_at: 2026-10-07
review_due: 2026-11-07
revision: 1.0.0
precedence: task
derived: false
---

## stage
国内站精选调整、OpenCraft 同步和 CR 修正已提交 MR !5059；待新一轮 CI。

## verified
- 国内精选首屏顺序为 find skill、提示词生成大师、`@indiv-ebandao/dev-expert`，周年活动卡不再显示。
- 育儿大师以 `@indiv-ebandao/parenting-expert` 追加到精选末尾，分类同名条目使用同一完整身份。
- 腾讯文档以 `@tencent-adm/tencent-docs` 放在第 5 位，分类同名条目使用同一完整身份；精选共十一张，末页两张。
- 定向 Vitest 73/73、`pnpm i18n:check`、`pnpm check`、`pnpm build` 和 `git diff --check` 通过。
- 三张新增技能的独立 WebP 横幅、中文详情、完整来源和安装身份已接入。
- 本地国内站预览运行于 `127.0.0.1:5175`，`/agents/skills/` 返回 HTTP 200，开发版 `_next/static`、腾讯文档横幅与同源 OpenCraft 脚本均返回 HTTP 200。
- 合入当前 master 后，聚焦测试 119/119、`pnpm check`、国内与国际站构建、OpenCraft 同步检查、插件类型检查和 i18n 测试通过。

## unverified
- 未验证线上页面；MR 已提交但尚未合并或发布。
- 线上页面仍使用旧版本，需后续提交与发布才会更新。
- 浏览器中的技能页显示“请先登录”；需用户正常登录后才能目视核对精选卡片。

## discard
- 复用主检出 `node_modules` 导致本地 workspace 包解析失败；已在 worktree 离线安装对应依赖。本机 `localhost` 解析失败，测试使用临时 `127.0.0.1` 配置，已清理。
- 默认 5174 端口由另一个 LightVela 工作树占用，未中断该进程；本任务预览使用 5175 端口。

## restore
- 工作目录：`/Users/pablozhong/.codex/worktrees/remove-cn-featured-anniversary/lightvela`。
- Task Pack：`docs/context/tasks/2026-10-07-remove-cn-featured-anniversary.md`。

## next_action
核对 MR !5059 新一轮 CI；用户可在本地预览正常登录后核对精选卡片。
