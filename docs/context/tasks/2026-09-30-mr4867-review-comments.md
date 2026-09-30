## goal
处理工蜂 MR !4867 的 8 条 AI 评审评论，在不改变既定产品行为的前提下修复成立的问题。

## non_goals
- 不改变首页视觉设计、反馈入口目标或部署配置。
- 不 commit、push、回复或解决远端评论。

## requirement_ids / requirement_refs / requirement_excerpt
- `wisp/mono2!4867`：处理评论页显示的 8 条 AI 评审意见。
- CR follow-up：处理移动端 mascot、静态资源缓存、死代码、ScrollTrigger 注册和导入脚本前置依赖；门图比例交设计确认。

## interface_refs / data_structure_refs
- `PRODUCT_FEEDBACK_URL` 必须继续表示站内 `/support`。
- 首页动效的 dispose 事件与 door peek 状态值保持不变；无人发布或监听的 door handoff/ready 事件可以删除。

## history_context
- `current_design_refs`：`docs/context/domains/site-environment-routing.md`、MR !4867 当前补丁。
- `relevant_evolution`：MR 将国内反馈入口统一到站内 `/support`，并新增国际首页动效。
- `superseded_refs`：无。

## acceptance
- 动画触发器不再依赖 DOM 非空断言。
- 图片采样不会访问图像边界外的 buffer。
- 事件与 door peek 状态使用集中常量且行为不变。
- 反馈链接维持内部路由；资源生成失败仍以非零状态向调用方传播。
- 聚焦测试、lint 与类型检查通过。
- 390px 视口下 `.scenes__mascot` 不挤压场景标题。
- 同名替换的视觉资源 URL 带版本参数。
- 未接线的 companion journey CSS 和 door handoff 事件链路移除。
- OpenCraft vendored Agent Console manifest 与 frontend 源修订保持一致。

## affected_paths
- `frontend/next-site/international-home-stage-motion.ts`
- `frontend/next-site/international-home-motion.ts`
- `frontend/next-site/international-home-door-peek.ts`
- `frontend/scripts/prepare-home-door-peek.mjs`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`

## required_context
- `service-frontend`
- `site-environment-routing`
- `tapd-gongfeng-delivery`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@2c9356c12` | 前端门禁与硬规则 | 确定验证范围 |
| `docs/context/project/services/frontend.md@2c9356c12` | 前端服务边界 | 确定最小有效验证 |
| `docs/context/domains/site-environment-routing.md@2c9356c12` | 双站与 locale 路由 | 判断反馈链接评论是否成立 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2c9356c12` | MR 写操作边界 | 不自动 commit、push 或回复评论 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@2c9356c12` | 前端测试邻接 | 检查相邻动效测试 |
| `.agents/skills/gongfeng/SKILL.md@workspace` | 工蜂评论读取流程 | 通过已登录浏览器只读获取评论 |
| `opencraft/AGENTS.md@625dc7dc1` | OpenCraft vendored 同步规则 | 通过标准脚本更新机械生成 manifest |
| `origin/master@1076ded3c` | 当前 CI guard 契约 | 确认 `test:embedded-ci` 来自主干并通过合入 master 取得 |

## evidence
- 工蜂评论页：8 条 AI 评论，按严重程度排序。
- `frontend/src/constants/product-feedback.ts`：`PRODUCT_FEEDBACK_URL = "/support"`。
- `pnpm exec vitest run --config vitest.config.ts next-site/__tests__/international-home-door-peek.test.ts next-site/__tests__/international-home-motion.test.ts`：2 个文件、27 个用例通过。
- `pnpm typecheck`：166 个既有诊断、171 个 baseline、0 个新增、5 个已消除，退出码 0。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：0 errors、0 warnings。
- `git diff --check`：通过。
- CR follow-up：生成器测试 25/25、动效测试 26/26、TypeScript 0 个新增诊断。
- 本地国际站 `http://localhost:5174` 在 390×844 视口检查：场景标题与卡片正常，装饰 mascot 未进入移动端布局。
- 远端流水线反馈：`opencraft guard` 因 `UPSTREAM.json` 的 `sourceRevision` 漂移失败，期望 `2c9356c12539d4352ed453117e917756368729f8`。
- `npm --prefix opencraft run sync:mono2-agent-console`：同步 130 个 Agent Console 文件，仅生成 `UPSTREAM.json` 的 `sourceRevision` 更新。
- `npm --prefix opencraft run check:mono2-agent-console`：Verified 130 mono2 Agent Console files，退出码 0。
- 第二轮远端流水线反馈：`opencraft guard` 使用主干 guard 调用 `npm --prefix opencraft run test:embedded-ci`，但 !4867 分支未包含该脚本；合入 `origin/master@1076ded3c` 后脚本存在。
- 合入 master 后 `npm --prefix opencraft run sync:mono2-agent-console` 将 `UPSTREAM.json.sourceRevision` 同步为 merge commit `414ca8fe622b3ede88262b7412bdf88ad609d74b`，随后 `check:mono2-agent-console` 通过。
- `npm --prefix opencraft ci --ignore-scripts --no-audit --no-fund --loglevel=error`：added 1358 packages in 47s。
- `npm --prefix opencraft run test:embedded-ci`：142 tests passed，0 failed。
- master 合入后复验：生成器测试 25/25、动效测试 26/26、`pnpm typecheck` 166 current / 171 baseline / 0 new / 5 resolved。

## risks
- 动效触发器缺失时应跳过局部动画，不能导致首页初始化失败。
- 资源生成脚本必须保留失败退出语义，不能只记录错误后继续成功退出。

## validation
- 相关 Vitest 测试：通过。
- TypeScript baseline 检查：通过，0 个新增诊断。
- 文档校验与 `git diff --check`：通过。
- OpenCraft Agent Console vendored 检查：通过。
- OpenCraft embedded CI 测试：通过，142/142。
- Lint：仓库当前 `frontend/package.json` 无 lint script，已安装依赖也不提供 eslint/biome/oxlint/prettier 可执行文件，无法运行独立 lint 门禁。
- Staged change-impact：本轮未 stage，故不运行 staged-only 门禁。

## decisions
- 采纳 DOM 安全、采样边界和常量化评论。
- 不采纳两个“反馈 URL 可能为外链”评论：仓库权威常量明确为 `/support`。
- 不采纳吞错式 try/catch 建议：top-level await 已会以非零状态传播 sharp 失败。
- 移动端隐藏纯装饰性的 scenes mascot，不缩小后占用标题空间。
- 门图 `viewBox="0 0 964 966"` 与 `meet` 保持不变，等待设计 owner 确认。
- i18n 评论已在当前分支失效：`en-US` 的“用户反馈”为 `User Feedback`，无需改动。
- OpenCraft guard 按标准生成流程只更新 `UPSTREAM.json.sourceRevision`，不手改 vendored 源文件。
- `test:embedded-ci` 缺失属于 !4867 分支落后主干 CI 契约，采用合入 `origin/master` 取得脚本与对应测试，不在 MR 分支手写占位脚本。

## scan_scope
- `frontend/next-site/`
- `frontend/scripts/prepare-home-door-peek.mjs`
- `frontend/src/components/site/`
- `frontend/src/constants/product-feedback.ts`
- `opencraft/scripts/sync-mono2-agent-console.mjs`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`

## scan_output
- 使用 `rg` 精确核对评论涉及的事件、状态、DOM 查询与反馈 URL。

## handoff
- 当前状态：本地已合入 `origin/master@1076ded3c`，并追加 master merge 后的 OpenCraft manifest 同步提交；前端定向测试、typecheck、OpenCraft vendored 检查与 embedded CI 测试均通过。
- 下一步：推送当前 HEAD 到 `feat/home-visual-and-domestic-feedback`，等待远端流水线重跑。
