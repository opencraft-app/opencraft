# 当前执行计划：LightVela 场景任务安装器 v1

> TAPD：[#135720398](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091135720398)
> 分支：`frontsandbox/scenario-task-installer`
> 规模：M

## 任务清单

- [x] 1. 新增 `scenario-tasks` 场景配置和 builder。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/scenario-packs.ts`、`frontend/src/pages/marketing/scenario-tasks/scenario-task-builder.ts`
  - 验收方式：四个首发场景都能生成 name、prompt、一次性 schedule、周期 schedule、deliver 和最近执行匹配结果。
- [x] 2. 为 `scenario-task-builder` 补单元测试。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/__tests__/scenario-task-builder.test.ts`
  - 验收方式：覆盖 A股非投资建议、AI 动态无 LightVela 启发、一次性/周期 schedule 和 recent run 匹配。
- [x] 3. 新增 `ScenarioTaskGrid` 和场景卡。
  - 角色：Implementer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioTaskGrid.tsx`
  - 验收方式：`/agents/automations` 能展示四张场景卡，现有模板/添加入口仍可用。
- [x] 4. 新增 `ScenarioInstallModal`。
  - 角色：Implementer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`
  - 验收方式：按场景填写少量字段，展示默认频率、网页 / 最近执行回传和试跑摘要，提交后返回 draft。
- [x] 5. 新增 `ScenarioRunPreview` 和 `ScenarioEnableConfirmModal`。
  - 角色：Implementer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioRunPreview.tsx`、`frontend/src/pages/marketing/scenario-tasks/ScenarioEnableConfirmModal.tsx`
  - 验收方式：展示试跑中/成功/超时/失败状态，成功或超时后可进入常态任务确认。
- [x] 6. 在 `AutomationsPanel` 中接入 Cron 创建和轮询。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/openclaw-automations-panel.tsx`
  - 验收方式：点击“先跑一次”创建一次性 Cron，轮询最近执行，确认后创建周期 Cron，并刷新已生效任务。
- [x] 7. 更新 i18n 字典。
  - 角色：Developer
  - 影响文件：`frontend/src/i18n/generated/zh-CN.json`、`frontend/src/i18n/generated/en-US.json`、`frontend/src/i18n/generated/zh-to-key.json`
  - 验收方式：`pnpm i18n:extract` 和 `pnpm i18n:check` 通过。
- [x] 8. 运行目标验证。
  - 角色：Reviewer
  - 影响文件：测试与类型检查输出
  - 验收方式：目标单测和 `pnpm check` 通过；若浏览器烟测受登录态限制，明确记录未覆盖项。
- [x] 9. 在场景安装步骤中复用微信 / QQ 扫码通道回传。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`、`frontend/src/pages/marketing/scenario-tasks/scenario-task-builder.ts`、`frontend/src/pages/marketing/openclaw-automations-panel.tsx`
  - 验收方式：已扫码接入微信 / QQ 时可选择对应回传目标；未接入时禁用并跳转通道页；试跑和常态 Cron 共用同一份 deliver。

## 验收重点

- 四个场景全部首发。
- 试跑采用一次性 Cron + 最近执行。
- 试跑结束后可以添加为常态化自动任务。
- 无外部通道时默认网页 / 最近执行，不阻断试跑。
- 已扫码接入微信或 QQ 时，可以把试跑和常态任务结果推送到对应通道。
- 不影响现有模板、添加、编辑、暂停、恢复、删除和最近执行。
