## goal
把单次定时任务的日期、小时和分钟选择整合为同一个弹层，统一周期态频率与时间项的尺寸和多时间点布局，并消除任务类型卡片的英文重复文案。

## non_goals
- 不修改定时任务的持久化格式或 Hermes 调度语义。
- 不提交 MR、发布或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图（2026-09-11）：日期位于左侧，小时和分钟位于右侧纵向选择，三者处于同一个下拉框。
- 用户截图（2026-09-11）：年、月、日、小时、分钟分别独立编辑，点击哪个只修改哪个，不再编辑整串日期时间。
- 用户截图（2026-09-11）：周期态的频率选择与时间项统一高度；时间项每行最多显示 6 个，加号尺寸保持不变。
- 用户截图（2026-09-11）：国际站任务类型标题与能力徽标不能同时显示 `AI-powered`；标题使用 `Agent task`，徽标保留 `AI-powered`。
- 用户截图（2026-09-11）：按间隔态的数值框与单位框缩小并保持等高。
- 用户截图（2026-09-11）：周期态选择每周或每月时，多选框与右侧时间框均和频率框对齐高度。
- 用户截图（2026-09-11）：周期态每天最多支持 18 个时间点，达到上限后禁用添加入口并显示对应提示。
- 用户截图（2026-09-11）：国际站任务列表页签用 `Tasks`，不再显示 `Current Jobs` / `Ended Jobs`。
- 用户反馈（2026-09-11）：弹窗及相关任务提示不再使用 `Job` / `Jobs`；英语统一为 `Task` / `Tasks`，西语、印尼语、日语、韩语和繁中使用各自语言中的“任务”含义。
- 用户截图（2026-09-11）：任务卡片的排期 hover 浮层在时间点较多时不得横向溢出视口。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-automations-panel.tsx` 的 `OncePickerDraft` 与 `OncePicker`。
- 保持 `YYYY-MM-DDTHH:mm` 输出格式、弹层内草稿状态以及取消/确认语义不变。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：`92657f5be` 已为该 Popover 设置高于表单模态框的呈现层级；`fbe72f2da` 已同步 OpenCraft 生成闭包。
- `superseded_refs`：无。

## acceptance
- 桌面端同一 Popover 左侧显示月历，右侧显示小时和分钟纵向滚动列。
- 相比首版组合选择器，整体占用面积缩小约 40%，同时保留清晰的文字和可点击区域。
- 窄屏保持同一 Popover，并将时间区收敛到月历下方。
- 当前小时和分钟有明确选中态，打开时滚动到当前值。
- 执行时间按年、月、日、小时、分钟拆成五个独立数字段，点击某段后输入只替换该段；离开整个控件时校验、确认并补齐两位格式，无效输入恢复上次有效值。
- 周期态的频率选择和时间项均为 32px 高；每日时间项每行最多 6 个，加号仍为 24px 且紧跟最后一个时间项。
- 国际站智能任务卡片标题显示 `Agent task`，能力徽标仍显示 `AI-powered`，筛选器与任务详情沿用同一任务类型译名。
- 按间隔态的数值框与单位框均为 32px 高，星期标签和其他控件尺寸不变。
- 周期态的每周/每月多选框和时间框默认均为 32px 高；选择项换行时多选框可自然增高，避免截断内容。
- 周期态每天最多支持 18 个时间点，保持每行最多 6 个，因此最多排列 3 行；达到上限时提示“最多支持18个时间点”。
- 国际站页签显示 `Current Tasks` / `Ended Tasks`，相关提示中的同名入口也统一使用 `Tasks`。
- 国际站弹窗显示 `Task type`、`Upstream Task` 等 Task 术语；西语等其他语言不残留英文 `Job`，也不使用“岗位、职业”等就业含义的误译。
- 排期 hover 浮层继续限制在 `min(360px, 100vw - 32px)`，长排期内容在浮层内自动换行，不再撑出视口。
- 键盘可通过 Tab 进入两列，并用方向键、Home、End 改值。
- 取消不提交草稿，确认更新 `YYYY-MM-DDTHH:mm`。
- Popover 继续保留 `z-[210]`。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/components/ui/popover.tsx`
- `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.global.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.es.test.ts`
- `frontend/src/pages/marketing/__tests__/automation-upstream-picker.id-ID.test.tsx`
- `frontend/src/i18n/generated/{en-US,es,id-ID,ja-JP,ko-KR,zh-Hant}.json`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/**`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `frontend-product-surface`
- `docs/context/project/services/frontend.md`
- `frontend/AGENTS.md`
- `opencraft/AGENTS.md`
- `opencraft/MONO2_MIGRATION.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@0cd79675c` | 路由器要求 | 确认双站前端与视觉验证边界 |
| `frontend/AGENTS.md@0cd79675c` | 最近服务规则 | 确认 lint/type/test/build 与截图要求 |
| `opencraft/AGENTS.md@0cd79675c` | 生成闭包边界 | 确认必须同步且不能手改生成层 |
| `opencraft/MONO2_MIGRATION.md@0cd79675c` | 生成闭包契约 | 确认同步命令与清单要求 |
| `docs/engineering/domains/agent-gateway-runtime.md@0cd79675c` | OpenCraft 正式设计 | 记录单次任务受控选择器不变量 |

## evidence
- 聚焦 Vitest：`automation-skill-picker.test.tsx`、`agent-automations-panel.test.ts`、国际站专用 `agent-automations-panel.global.test.ts`、西语词条回归与印尼语上游任务回归共 341 条通过，覆盖五段独立编辑、只改一段不影响其他段、失焦确认、非法输入恢复、周期态每日/每周/每月同高与六时间项布局、18 个每日时间点边界、按间隔态紧凑等高、长排期 hover 浮层换行，以及 `Agent task` / `AI-powered` 英文消歧和多语言 Task 术语。
- 多语言词条审计：英语、西语、印尼语、日语、韩语、繁中与定时任务相关的词条均无残留 `Job` / `Jobs`；西语测试夹具与生成词条完全一致，韩语不再使用“职位、职业”等就业含义。
- `frontend/pnpm check`：通过；TypeScript `174 current / 276 baseline / 0 new / 102 resolved`，i18n 结构检查通过（保留仓库既有 49 条 warning）。
- OpenCraft：`sync:mono2-agent-console` 与 `check:mono2-agent-console` 通过，125 个生成闭包文件一致；`@opencraft/plugin-lightvela-hermes` typecheck 通过。
- OpenCraft 全量 `gate`：边界检查通过，但全量 workspace typecheck 被当前 OpenCraft 环境/基线问题阻断，包括 Expo 依赖缺失、`@opencraft/design-system/modal` 解析失败及 `workbench-web` 既有类型错误；未进入后续全量测试与构建。
- 浏览器交互：1440x900 桌面与 390x844 窄屏通过；紧凑版桌面弹层为 `420x325`，较首版占用面积缩小约 40%；窄屏弹层 `clientHeight=442`、`scrollHeight=570`、可滚动至底部操作区。
- 状态交互：12:24 改为 13:25 后取消仍为 12:24；再次修改并确认后为 13:25；小时 13 上按 ArrowDown 后选中 14。
- 分段输入交互：在上海正式后端的 Chrome 域名代理预览中，年、月、日、小时、分钟分别成为可聚焦数字段；只把小时从 16 改为 07 后点击名称框，其余四段保持不变，打开选择器后小时 07 同步选中。未提交或创建真实任务；非法单段值在组件测试中验证为离开控件后恢复上次有效值。
- 周期态布局交互：在 5174 Chrome 域名代理预览中添加至 6 个每日时间项，6 项与 24px 加号保持同排；频率选择和时间项均为 32px 高。未提交或创建真实任务。
- 按间隔态布局交互：在 5174 Chrome 域名代理预览中切换到按间隔，数值框与单位框均为 32px 高，星期标签保持原尺寸。未提交或创建真实任务。
- HTML 报告：`test-artifacts/automation-time-picker/validation-report.html`（本地 mock auth，不代表真实后端或生产验证）。
- 文档完整性检查通过；暂存变更集的 change-impact 检查通过并正确要求 `wisp/mono2-maintainers` owner review；`git diff --check` 通过。

## risks
- Popover 变宽后可能在窄视口溢出：使用响应式单列回退且限制视口宽度。
- 纵向长列表可能打开在错误位置：挂载和选值时把当前项滚动到可视区中部。
- 自定义列表可能降低键盘可用性：使用 listbox/option 语义与 roving tabindex。

## validation
- 聚焦组件测试。
- `pnpm check`。
- OpenCraft 同步与漂移检查。
- change-impact 与文档检查。
- 桌面和窄屏浏览器截图。

## decisions
- 复用当前页面已有的双列时间选项视觉，而不引入新依赖。
- 桌面端左右布局；窄屏仍在同一 Popover 内改为上下布局。

## scan_scope
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/automation-skill-picker.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`

## scan_output
- 现有 graphify 图谱确认 `OncePicker` 由 `AutomationFormModal` 使用，并与两份自动任务测试相邻。
- 手动输入路由查询未命中额外 Context Pack；有界源码检索确认只需为现有 Radix Popover 包装导出 `PopoverAnchor`，未引入新的交互原语。

## handoff
- 实现与本地验证已完成；本次变更不包含合并、发布或线上回归。
