# 人设页弹窗滚动与滚动条检查

## goal

统一人设页弹窗的滚动行为：内容在弹窗内滚动，弹窗打开时背景不滚动，短视口仍能访问全部操作。预览反馈显示滚动条会贴着圆角被裁；按用户要求隐藏弹窗滚动条，保留滚轮、触控和键盘滚动。

## non_goals

- 不修改人设内容、业务流程或弹窗打开方式。
- 不发布到生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户反馈（2026-09-28）：“人设-弹框滑动条样式不全”；明确指向“人设解读”。
- 后续要求：“按照优化后的逻辑，检查下人设这里所有弹窗对应的滚动事件吧”。
- 预览反馈：“滚动条看起来还是会被裁”；随后明确要求“直接不展示滚动条”。

## interface_refs / data_structure_refs

- `agent-buddy-panel.tsx`：人设预览、删除确认、结果提示及其他弹窗入口。
- `agent-buddy-draw-modal.tsx`：抽卡主体和抽取结果解读。
- `agent-buddy-soul-test-modal.tsx`：人格测试题目和结果。
- `agent-persona-upload-modal.tsx`、`agent-custom-persona-file-modal.tsx`：Radix 上传和编辑弹窗。
- `frontend/src/styles.css`：人设弹窗滚动条与背景滚动锁定。

## history_context

- `current_design_refs`：`frontend/DESIGN.md` 弹窗结构规则、`frontend/src/styles.css` 既有 Skill 弹窗滚动条样式。
- `relevant_evolution`：两个“人设解读”内容区原有 `overflow-y-auto`，缺少完整滚动条样式；其他自定义弹窗的背景锁定和短视口滚动行为不一致。
- `superseded_refs`：无。

## acceptance

- 内容超出弹窗高度时，滚动条不可见，滚轮仍作用于弹窗内的内容区，背景页面保持静止。
- 自定义弹窗关闭后恢复背景滚动；嵌套弹窗存在时保持锁定。
- 短视口可访问抽卡、人格测试和确认弹窗的全部内容。
- 完成前端检查、聚焦测试、构建和浏览器行为验证。

## affected_paths

- `frontend/src/styles.css`
- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/agent-buddy-draw-modal.tsx`
- `frontend/src/pages/marketing/agent-buddy-soul-test-modal.tsx`
- `frontend/src/pages/marketing/agent-persona-upload-modal.tsx`
- `frontend/src/pages/marketing/agent-custom-persona-file-modal.tsx`
- `docs/context/tasks/2026-09-28-persona-interpretation-dialog-scrollbar.md`
- `docs/context/tasks/2026-09-28-persona-interpretation-dialog-scrollbar.checkpoint.md`
- `docs/context/tasks/assets/2026-09-28-persona-interpretation-scrollbar-preview.webp`

## required_context

- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端样式与验证规则 | 限定实现和门禁 |
| `frontend/DESIGN.md` | 弹窗视觉约定 | 保持现有结构 |
| `docs/context/project/services/frontend.md` | 前端服务边界 | 确认双站共用改动 |
| `docs/context/domains/site-environment-routing.md` | 站点边界 | 不推断线上效果 |

## evidence

| 弹窗 | 原有行为 | 本次处理 |
|---|---|---|
| 人设预览、抽取结果解读 | 内容可滚动，滚动条贴近圆角；背景可继续滚动 | 隐藏滚动条并锁定背景，保持标题和关闭按钮固定 |
| 抽卡主体 | 无高度上限，短视口内容可能被裁；背景可滚动 | 限制高度并加入内部滚动，锁定背景 |
| 人格测试题目与结果 | 题目固定最小高度 620px，短视口可能被裁；用 JS 单独写入 body overflow | 题目按视口收缩并内部滚动；改为与其他自定义弹窗共用 CSS 锁定 |
| 删除确认、结果提示 | 短卡片无高度上限，长文案可能被裁；背景可滚动 | 加最大高度、内部滚动和背景锁定 |
| 上传人设、编辑人设文件 | Radix 已锁定背景，弹窗已有限高和内部滚动；文本框本身可滚动 | 隐藏弹窗外层滚动条；文本框保留原生滚动及向外滚动传递 |

- 首版 Chromium 样式预览虽显示轨道和滑块，实际预览页的人格测试弹窗中滚动条仍贴近圆角，视觉上被裁。改为 `scrollbar-width:none` 和 WebKit 隐藏规则，不改滚动容器的 `overflow-y-auto`。
- [生产 CSS 样式预览](assets/2026-09-28-persona-interpretation-scrollbar-preview.webp)用于检查滚动条不可见；预览是样式夹具，不是已登录产品页面截图。
- 390×520 Chromium 使用生产 CSS，且禁用浏览器自动隐藏滚动条：人格测试容器的 `scrollbar-width:none`、WebKit 滚动条 `display:none`、宽度 `0px`；长内容 `scrollHeight=1899`、可视高度 `458`，滚轮使内部滚动 `320px`、背景仍为 `0px`。
- 390×520 Chromium 生产 CSS 行为夹具：抽卡内容区 `clientHeight=464`、`scrollHeight=1100`；滚轮后内容滚动 350px，背景滚动 0px；滚到末端后背景仍为 0px。嵌套弹窗移除父弹窗时背景仍锁定，最后一个弹窗移除后恢复 `overflow:auto`。人格测试题目内容区 `clientHeight=458`、`scrollHeight=960`，滚轮可滚动。

## risks

- 滚动区域没有可见轨道；长内容仍需通过滚轮、触控板、触屏或键盘滚动。
- 浏览器行为夹具使用生产 CSS 和同构弹窗结构，仍需已登录产品页对真实内容做视觉验收。

## validation

- `pnpm check`：通过；TypeScript 诊断 171 条当前、171 条基线，0 条新增。
- `pnpm build`：通过，生成 106 个静态页面。
- 隐藏滚动条改动后，当前环境无 `pnpm` 命令，按 `package.json` 的 `check` 与 `build` 脚本逐项执行，全部通过；TypeScript 仍为 171 条当前、171 条基线，0 新增，构建仍生成 106 页。
- 五个相关测试文件：4 个文件通过；共 57 条通过，1 条人设页原有保存后提示文案断言失败，位置为 `agent-buddy-panel.test.tsx:755`。
- 原范围的单条人设详情预览重试用例通过；此前全量 `pnpm test` 在模型配置、侧边栏等多个其他模块失败。
- Chromium 生产 CSS 行为夹具通过背景锁定、内部滚轮、边界滚动、嵌套关闭恢复和短视口题目滚动检查。
- 隐藏滚动条改动后再次运行 Chromium 夹具，确认滚动条不可见且上述滚动事件仍通过。
- 隐藏滚动条改动后重新运行抽卡、人设测试两个聚焦测试文件：2 个文件、5 条用例通过。

## decisions

- 将同一 `lv-persona-dialog-scroll` 类用于全部人设弹窗的滚动容器，隐藏轨道与滑块，保留滚动事件；在 flex 内容区补 `min-h-0`。
- 自定义弹窗遮罩统一标记 `lv-persona-modal-scroll-lock`，通过 `:has()` 锁定 `html` 和 `body`；嵌套弹窗自动按当前 DOM 保持或释放锁定。Radix 弹窗继续使用自身锁定机制。

## scan_scope

- 人设页主组件及其抽卡、测试、上传、编辑五个弹窗组件；`frontend/src/styles.css`。

## scan_output

- 无额外扫描产物。

## handoff

- 首版已推送至 `frontsandbox/persona-modal-scrollbar` 供双站预览；隐藏滚动条的修正待更新到同一分支。真实登录态页面视觉验收仍待完成；全量测试的既有失败需独立归因。
