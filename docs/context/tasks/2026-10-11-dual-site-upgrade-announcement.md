---
id: task-dual-site-upgrade-announcement-20261011
type: task
scope: 双站首页限时系统升级公告。
triggers: ["10 月 11 日系统升级公告", "双站升级公告"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/components/site/maintenance-announcement-banner.tsx
status: active
reviewed_at: 2026-10-11
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---

## goal

在 LightVela 国内站和国际站首页发布 2026-10-11 22:00 至 2026-10-12 06:00 的系统升级公告。

## non_goals

- 不执行系统升级或更改升级窗口。
- 不修改公告条布局或全站公告范围。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户本轮请求：参考此前升级公告，今晚 10 点到明早 6 点安排升级，国内站和国际站都发。

## interface_refs / data_structure_refs

- `frontend/src/components/site/maintenance-announcement-banner.tsx`：公告 ID、文案、过期时间和关闭记忆。
- `frontend/next-site/international-home-runtime.tsx`：双站 V2 首页公告挂载。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：当前 `master` 上的 9 月 23 日系统升级公告提供相同的双站文案与过期机制。
- `superseded_refs`：无。

## acceptance

- 两站首页分别显示北京时间和新加坡时间的 10 月 11 日 22:00 至次日 06:00 系统升级公告。
- 曾关闭 9 月公告的用户仍可看到新公告。
- 10 月 12 日 06:00（UTC+8）后公告自动隐藏。
- 前端 i18n、lint、类型检查、测试通过；发布后核对两站线上显示。

## affected_paths

- `frontend/src/components/site/maintenance-announcement-banner.tsx`
- `frontend/src/components/site/__tests__/maintenance-announcement-banner.*.test.tsx`
- `frontend/src/i18n/generated/*.json`
- `docs/engineering/domains/site-environment-routing.md`

## required_context

- `site-environment-routing`、`release-gitops`、`frontend-product-surface`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md` | 双站边界 | 分别验证两站 |
| `docs/context/domains/release-gitops.md` | 发布边界 | 不把源码变更当作线上发布 |
| `docs/context/project/services/frontend.md` | 前端验证 | 选择门禁 |
| `frontend/AGENTS.md` | 服务规则 | 前端修改与验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | i18n 邻接 | 生成字典并检查翻译 |
| `frontend/openspec/changes/2026-07-06-frontsandbox-hermes-agent-upgrade-announcement-0706.md` | 历史方案 | 复用公告条 |

## evidence

- `pnpm i18n:check` 与 `node scripts/i18n-zh-hant.mjs --check`：通过，8 个语种均无待翻译项。
- `pnpm exec vitest run --api.host 127.0.0.1 ...`：3 个文件、48 项测试通过。
- `pnpm check`：通过，TypeScript 0 个新增诊断。
- `pnpm build:cn`、`pnpm build:global`：均通过。
- 当前 frontend 未配置 `lint` 脚本；`pnpm lint` 返回 Command not found。
- 待记录远端与线上状态。

## risks

- 两站独立交付；合并或构建成功不能证明两站线上公告已出现。发布后分别核对生产首页。

## validation

- `pnpm i18n:check`、`pnpm lint`、`pnpm typecheck`、聚焦测试。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions

- 沿用先前系统升级的通用措辞，避免编造具体升级对象。
- 北京与新加坡时区同为 UTC+8；过期时间设为 UTC 2026-10-11 22:00。

## scan_scope

- `frontend/src/components/site/`、`frontend/next-site/`、`frontend/src/i18n/`。

## scan_output

- 精确搜索命中现有公告组件、双站 V2 首页挂载及相邻测试。

## handoff

- 本地验证完成；待提交、发布与线上双站核验。
