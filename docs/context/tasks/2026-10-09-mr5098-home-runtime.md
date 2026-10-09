---
id: task-mr5098-home-runtime
type: task
scope: 修复 MR 5098 标题脚本顺序冲突及首页 runtime 生成源漂移。
triggers: ["mr5098", "首页标题空格还原", "评价轮播生成源"]
owner: skipzhang
authority: primary
source_of_truth:
  - frontend/scripts/import-international-homepage.mjs
  - frontend/scripts/international-home-feature-locales.mjs
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.0
precedence: project
derived: false
---

# MR 5098 首页运行时修复

## goal
修复标题动画与空格还原的加载顺序冲突，并确保重新生成 runtime 保留新版评价轮播与卸载逻辑。

## non_goals
- 不合并 MR、不发布生产、不修改后台及 GitOps。
- 不处理附件中与本次两项问题无关的页脚、指针组件和样式清理。

## requirement_ids
- MR !5098：P1 标题加载顺序、P2 新版评价生成源。

## requirement_refs / requirement_excerpt
- 用户明确要求修复 [MR !5098](https://git.woa.com/wisp/mono2/-/merge_requests/5098/)，标题动画一段负责到底，覆盖两种加载顺序；用户评价只保留新版。
- 当前 MR 源分支 `frontsandbox/homepage-review-20261008`，基线 `607313473c6111416b1bc5377ec1c371306d896c`；用户给出的只读 CR 基于 `d3e617c`。

## interface_refs / data_structure_refs
- `lightvela-home-dispose`：清理标题还原定时器、轮播定时器与观察器、事件监听。
- `normalizeHeroRuntime`：生成时统一标题动画，保留 100ms 初始延迟、30ms 字符间隔、500ms 字符动画与 80ms 段间隔。
- 评价 `.tcard` 是本地化数据源及无 JS 静态回退；JS 交互只有新版 `.vcar`。

## history_context
- current_design_refs：`frontend/docs/homepage-bilingual-20260929.md`、`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`。
- relevant_evolution：最新 MR 已删除 769–899px 旧标题规则；本次不重新修改字号。
- superseded_refs：用户给出的 d3e617c 只读 CR；修复以最新 607313473 为基线。
- 生成一致性检查发现能力卡 replay 也只改在产物，随新版轮播一起回写模板，确保 runtime 完整逐字节一致。

## acceptance
- 两种加载顺序都保留标题字符节点至该行动画结束，然后恢复自然词边界。
- 移动端、减少动态偏好立即使用自然文本；卸载后不执行延迟文本改写。
- 执行 importer 的实际 runtime 构造代码后，生成结果与产物逐字节一致。
- 轮播推进、减少动态偏好和完整卸载通过测试；13 张 128px 头像列入保留清单。
- 七种国际语言及各屏宽视觉检查；前端 check、相关测试、构建、变更影响检查。

## affected_paths
- `frontend/public/lightvela-intl-home/runtime.js`
- `frontend/public/lightvela-intl-home/assets/feature-motion.js`
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/scripts/international-home-feature-locales.mjs`
- `frontend/scripts/international-home-runtime-generation.test.mjs`
- `frontend/next-site/__tests__/home-hero-headline-order.test.ts`
- `frontend/next-site/international-home-runtime.tsx`（缓存版本）

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`frontend/AGENTS.md` | 仓库与服务规范 | 隔离工作区、验证、授权边界 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR 交付路由 | 读取实际分支及认证 |
| `docs/context/project/services/frontend.md` | 前端产品路由 | 生成真源与国际首页边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 相邻文件核对 | 生成器与测试契约 |
| `frontend/DESIGN.md` | 动效和 UI 规范 | 保留布局及既有交互 |
| `frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md` | 首页接入约束 | 保留本地模块、七语言与脚本生命周期 |
| `.agents/skills/gongfeng/SKILL.md`、`DEPENDENCIES.md` | 工蜂工具使用 | 使用已有 mcporter 连接，不输出凭据 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 任务记录 | 可恢复交接 |
| `.agents/context/change-impact.json` | 影响范围 | 本次未命中架构文档映射 |
| `docs/context/tasks/optimization-queue.md`（已推送其他需求分支） | 队列核对 | MR 5098 不属于 OPT-001–010，未改既有队列或 TAPD 状态 |

## evidence
- 标题回归测试修复前两种顺序均失败，修复后通过。
- 首页相关 Vitest 6 文件 119 条通过；语言生成器及 runtime 生成测试通过。
- runtime 生成测试 4 条通过：完整产物逐字节一致、新鲜标题源生成、轮播卸载、高清头像保留。
- 截图与视觉明细：`/data/mr5098-evidence/`。

## risks / validation
- 原始批准的静态源目录未在当前环境找到，用户明确回复「算了」后跳过完整 HTML/资产重导入；runtime 构造执行及逐字节一致性已独立验证，未把它宣称为完整首页导入成功。
- OpenCraft 同步只读检查报告既有 sourceRevision 漂移：`e6870332` 对 `752126dc`，与原 MR 描述相同；本次未改 `frontend/src/` 同步范围。
- `pnpm check` exit 0：TypeScript 166 current / 171 baseline / 0 new / 5 resolved；i18n 0 错误、47 条现有告警。
- 独立 `pnpm install --frozen-lockfile --offline` exit 0；最终测试在独立依赖上复验。
- `next build --webpack`（global）exit 0；随后执行 package build 的全部静态产物后处理，SEO 42 条路由通过。
- 首页 Vitest 119/119、语言生成器 25/25、runtime 生成 4/4，合计 148 条通过。
- 完整样式和本地资源下，国际七语言 × 11 屏宽、国内 × 11 屏宽共 88 项：0 JS 错误、0 标题出屏、0 不换行空格残留。屏宽 320/390/640/768/769/820/899/900/1024/1280/1440；七语言截图 contact sheet 已逐一查看。
- 文档 validator 通过；Context contract 23/27，4 个既有失败；context-audit 单测 33/33。最终 Context validator 的本任务文件错误为 0；全仓现有错误 7008 条，不宣称全仓治理通过。
- 提交前自查：保持标题时序与布局；生成模板和产物匹配；轮播监听与定时器清理；素材引用保留；无新增阻断问题。

## decisions
- 用户「修一下 MR」「可以」授权修复并交付原 MR；不重复请求提交推送批准。
- 标题文本还原由动画流程按该行最后字符的结束时间负责，保留原始 delay 数值。
- 仅迁回新版轮播，不恢复旧 marquee 的 JS 滚动控制。

## handoff
本地隔离 worktree `/data/mono2-mr5098-fix-20261009`，验证完成，向原源分支追加提交；推送前已回读远端仍为 607313473。不合并、不发布。

## stage / verified / unverified
- stage：本地验证及提交前 CR 完成，下一步提交推送原 MR。
- verified：两种加载顺序、时序边界、卸载、runtime 完整生成一致性、148 项测试、88 个视觉组合、check 和 global 构建。
- unverified：完整 HTML/资产重导入按用户「算了」跳过；公开分支预览发布状态未验证。

## discard / restore / next_action
- discard：复用外部 node_modules 的初始 check/build 结果；静态服务失效时的裸 DOM 截图。最终结果均来自独立依赖及浏览器直接读取本地资源。
- restore：读取本 Task Pack 和 `/data/mr5098-evidence/`，源分支 frontsandbox/homepage-review-20261008。
- next_action：提交并以 fast-forward 推送原 MR 源分支，回读工蜂实际提交。
