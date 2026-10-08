## goal

收敛 OpenCraft iOS Shell 和内置 frontend Bot DOM 的状态与协议边界，并清理会误导后续 Agent 的旧底栏说明。

## non_goals

- 不改 Bot 业务规则、后端 API、支付或实名执行方式。
- 不引入 Unistyles、新全仓门禁或每次 UI 修改的强制截图要求。
- 不提交、推送、发布或声称真机验收。

## requirement_ids / requirement_refs / requirement_excerpt

- 本会话用户：“看一下 paseo 的代码……那些模块需要我们建设的？或者是提示词需要防腐烂”；随后“搞起来”。
- 本会话此前约束：HeroUI Native 优先、Expo Go 可运行、共享逻辑且网页／原生各自呈现、Bot 复用现有 frontend 代码、侧栏状态连续。

## interface_refs / data_structure_refs

- `opencraft/packages/mobile-bot-bridge/src/index.ts`：版本、runtime ID、双向消息、命令能力。
- `opencraft/apps/workbench-expo/src/runtime/mobile-shell-model.ts`：账号和 Bot 容器语义页面。
- `opencraft/apps/workbench-expo/src/runtime/mobile-visual-tokens.ts`：侧栏品牌色与几何，叠加共享 native token。
- `opencraft/apps/workbench-expo/src/runtime/mobile-account-editor-model.ts`：原生账号表单草稿与异步请求代次。
- `frontend/src/mobile-dom/entry.tsx` 与 `opencraft/apps/workbench-expo/src/components/mobile-bot-host.ios.tsx`：共享桥接两端。

## history_context

- `current_design_refs`: `opencraft/docs/mobile-shell.md`、`opencraft/docs/mobile-bot-bridge.md`、`opencraft/docs/mobile-data-architecture.md`。
- `relevant_evolution`: 当前 mobilefirst 分支已经移除底栏、保留原生抽屉并把 frontend Bot 功能打包为本地 DOM runtime；README 留有底栏旧段落。
- `superseded_refs`: README 旧底栏描述已在本任务替换；`ref/paseo` 只作为只读状态模型和文档卫生参考。

## acceptance

- 原生和 DOM 只消费一份类型化、可验证的 Bot 桥接契约；旧 runtime、错误版本和畸形消息无效。
- 账号返回和迟到网页导航由纯状态模型决定；已挂载 Bot 和抽屉不因账号页重建。
- 原生账号编辑草稿与后台资料刷新、短信请求结果分离；旧响应不覆盖当前输入。
- Expo 局部 `AGENTS.md` 与当前 README、正式文档一致；没有新增 CI 门禁。
- 桥接与状态聚焦测试、Expo/frontend 类型检查、DOM 构建与 smoke 通过。

## affected_paths

- `opencraft/apps/workbench-expo/`、`opencraft/packages/mobile-bot-bridge/`、`opencraft/docs/`、`opencraft/tests/`。
- `frontend/src/mobile-dom/entry.tsx`、两端 package manifest 和 lockfile。
- `frontend/src/mobile-dom/AGENTS.md`：跨服务入口的局部 Agent 提示。

## required_context

- Context Router 命中 `frontend-product-surface`，必读 `docs/context/project/services/frontend.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | P0 与 Task Pack 规则 | 权限和验证边界 |
| `opencraft/AGENTS.md` | Expo 容器现有约束 | 不变式与局部路由 |
| `docs/context/project/services/frontend.md` | Router 必读 | 前端所有权 |
| `frontend/AGENTS.md` | 跨 frontend 的最近入口 | UI 和类型规则 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接卡 | 检查 runtime 生成入口 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft 维护方法 | 状态所有权与证据 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 聚焦验证路由 | 选择测试范围 |

## evidence

- `rg` 限定 frontend mobile-dom 与 Expo host，确认旧字符串事件和 README 底栏段落。
- `npx tsx --test tests/mobile-bot-bridge.test.ts tests/mobile-shell-model.test.mjs tests/mobile-account-editor-model.test.mjs`：7/7 通过。
- `npm run typecheck --workspace @opencraft/workbench-expo` 与 frontend `tsc --noEmit`：通过。
- `npm run build:mobile-bot-runtime`、`npm run smoke:mobile-bot-runtime`：通过，主站 Bot 页面可挂载并反复切换，原生 create 命令进入既有流程。
- `frontend` 的 `vitest run src/repositories/__tests__/http-repositories.test.ts`：82/82 通过。
- `npm run bundle:ios --workspace @opencraft/workbench-expo`：4694 模块打包成功；未进行真机视觉验收。
- `validate_documentation.py`：0 个站内断链；`validate_change_impact.py --staged`：通过；`git diff --check`：通过。
- Cloudflare Tunnel 与 Metro 启动，外部 iOS manifest 和 bundle origin 轻量核验通过；按此前用户要求没有下载完整 bundle。预览 URL 为临时链接，运行时验证仍需手机打开。

## risks

- runtime 资产与 Expo Go 真机视觉仍需运行时验证；协议测试不能证明系统 WebView 行为。
- frontend pnpm 12 离线锁更新因现有 `@edgeone/makers-sdk` 镜像缺失而失败，本轮只增加同形态的本地 `file:` 锁条目，并以 frontend 类型检查与 DOM 构建校验。
- 现有分支含大量此前任务的未提交改动；本轮不重置或提交它们。

## validation

- `npx tsx --test tests/mobile-bot-bridge.test.ts tests/mobile-shell-model.test.mjs tests/mobile-account-editor-model.test.mjs`。
- Expo typecheck；frontend typecheck；Bot runtime build/smoke；文档与 change-impact 检查。

## decisions

- 共享 Bot bridge 是独立无运行时依赖的 workspace 包，避免把协议塞入账号 SDK。
- `runtimeId` 只用于拒绝旧消息，不代替会话授权；token 仍由现有受控启动路径提供。
- iOS 语义页面用纯模型，动画与手势继续由现有原生容器负责；不复制 Paseo 实现。

## scan_scope

- `frontend/src/mobile-dom/`、`frontend/src/pages/marketing/agent-settings-page.tsx`、`opencraft/apps/workbench-expo/`、`opencraft/docs/`。

## scan_output

- 有界 `rg` 显示 native/DOM 字符串事件、README 旧底栏和已有生成脚本；未做全仓文本扫描。

## handoff

- 已交接源码、局部 Agent 入口和临时 Expo Go 链接；没有 commit、push 或 MR。
- 真机手势、账号登录与 Bot 实际 API 行为未由本轮服务器端测试验证。
