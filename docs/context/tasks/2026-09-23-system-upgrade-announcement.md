## goal
在国内站与国际站首页展示 2026-09-23 22:00 至次日 06:00 的系统升级公告，并在窗口结束时自动撤下。

## non_goals
- 不改变升级范围、发布流水线、维护操作或其他页面行为。
- 不引入远程公告配置中心。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-23）：国内站和国际站挂升级公告，时间为今晚 22:00 到次日 06:00。

## interface_refs / data_structure_refs
- `frontend/src/components/site/maintenance-announcement-banner.tsx`：公告 ID、区域文案、首页可见性、关闭记忆与过期定时器。
- 不变量：国内站使用北京时间，国际站使用新加坡时间；两者均为 UTC+8；旧公告关闭状态不得隐藏新公告。

## history_context
- `current_design_refs`：`frontend/openspec/spec.md`、`docs/context/domains/site-environment-routing.md`。
- `relevant_evolution`：`frontend/openspec/changes/2026-07-06-frontsandbox-hermes-agent-upgrade-announcement-0706.md` 记录双站公告、独立 ID 与到期自动撤下约定。
- `superseded_refs`：此前 `0907-hermes-agent-upgrade` 公告只用于确认既有实现方式。

## acceptance
- 国内站首页显示北京时间 2026-09-23 22:00 至次日 06:00 的系统升级公告。
- 国际站本地化首页显示新加坡时间的同一升级窗口，并使用对应 locale 文案。
- 2026-09-24 06:00（UTC+8）公告自动隐藏。
- 新公告不继承旧公告的关闭状态。

## affected_paths
- `frontend/src/components/site/maintenance-announcement-banner.tsx`
- `frontend/src/components/site/__tests__/maintenance-announcement-banner.*.test.tsx`
- `frontend/src/i18n/generated/*.json`

## required_context
- `site-environment-routing`
- `frontend-product-surface`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@d4c13062` | 双站边界 | 国内站与国际站分别验证 |
| `docs/context/project/services/frontend.md@d4c13062` | 前端服务门禁 | 选择聚焦测试、i18n 与类型检查 |
| `frontend/AGENTS.md@d4c13062` | 最近服务规则 | 保持最小改动并运行前端门禁 |
| `frontend/openspec/changes/2026-07-06-frontsandbox-hermes-agent-upgrade-announcement-0706.md@d4c13062` | 公告历史实现 | 复用现有双站公告与过期机制 |

## evidence
- 基线：`origin/master@d4c1306221d3b821a8aaaf08299c0f0d3da7af2a`。
- 聚焦测试：2 个测试文件、6 个测试全部通过。
- i18n：6 个目标字典缺失 0 条；结构校验错误 0；繁体转换 3023 条一致。
- 类型检查：171 条现有基线诊断，新增 0、解决 0。
- 双站构建：`pnpm build:cn` 与 `pnpm build:global` 均通过，分别生成 106 与 664 个静态页面。
- 本地实页：CN 首页展示北京时间文案；global 首页展示英文 SGT 文案；两站公告高度均为 36px，关闭后公告节点与 `lw-has-announcement` 均清理。
- `git diff --check` 通过；构建产生的字体噪音已排除。

## risks
- 国际站缺少翻译会回退中文；通过 i18n 门禁与英文组件测试规避。
- 截止时间换算错误会延迟撤下；通过 UTC 边界测试规避。
- 源码合并不等于生产生效；发布与线上验证单独记录。

## validation
- 公告组件 CN/global 聚焦测试。
- `pnpm i18n:extract`、补齐翻译后运行 `pnpm i18n:check`、`pnpm i18n:validate`、`pnpm i18n:zh-hant:check`。
- `pnpm typecheck`、`git diff --check`、change-impact staged gate。
- 发布后分别核验 `lightvela.com` 与 `lightvela.ai` 首页。

## decisions
- 使用中性的“系统升级”口径，避免在需求未指定时把升级范围误写为 Hermes Agent。
- 使用新公告 ID `0923-system-upgrade`，避免继承旧公告关闭状态。
- 复用现有公告组件，不改变布局与发布机制。

## scan_scope
- `frontend/src/components/site/maintenance-announcement-banner.tsx` 及其聚焦测试、i18n 字典。

## scan_output
- 无独立扫描产物。

## handoff
- 当前状态：实现与本地双站验证完成，用户已明确授权 commit、push 与创建 MR；尚未合并或发布。
- 下一步：提交并创建 MR，随后核验远端 SHA、MR 与 CI 即时状态；合并与发布不在本次授权范围内。
