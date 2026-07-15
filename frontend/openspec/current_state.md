# 当前需求状态

## 自动任务支持调用 Skill

- 阶段：增量开发完成（Task 22：收紧 Skill 下拉菜单高度与纵向间距）
- 规模：M
- 执行模式：single_agent
- 开发分支：`frontsandbox/pablozhong-0714-automation-skill-invocation`
- 产品来源：已确认 PRD《自动任务支持调用 Skill》
- 产品父单：[TAPD #136120761](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091136120761)
- OpenSpec：
  - `openspec/proposal.md`
  - `openspec/spec.md`
  - `openspec/plan.md`
- 规划门禁：通过
- 实现状态：创建、编辑、详情、中英文国际化、快捷清除、默认提示、稳定性说明 Tooltip 及表单控件圆角统一均已完成；稳定性说明 Tooltip 已改为 Portal 浮层，不再受弹窗滚动容器裁剪；Skill 下拉菜单高度与纵向间距已收紧；Skill 选择与任务说明保持独立

## 已确认方案

1. 抽取共享 Hermes 已安装 Skill 查询/解析模块。
2. 创建独立的可搜索单选 Skill 组件。
3. 创建任务时传零个或一个 Skill slug。
4. 编辑任务时用三态语义区分保持、替换和清空。
5. 详情展示可用、不可用和未知状态，不自动解绑或静默降级。
6. Skill 列表失败不阻断普通任务创建。

## 验证结果

- 目标测试：5 个文件，184/184 通过。
- 静态检查：`pnpm check` 通过。
- 国际化检查：`pnpm i18n:check` 通过，1507/1507。
- Task 13 组件验证：已选择 Skill 时提供独立清除按钮，图标 hover/键盘聚焦切换为叉号，点击后清空选择且不展开下拉。
- Task 15 组件验证：未选择 Skill 时展示“选择你希望 Agent 稳定调用的技能”，沿用灰色占位样式和单行截断。
- Task 15 验证：选择器组件测试 16/16、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。
- Task 16 组件验证：名称输入框和 Skill 选择框使用与任务说明一致的 `rounded-md`，下拉菜单容器保持原样；选择器组件测试 17/17 通过。
- Task 17 组件验证：选择、切换或清除 Skill 均不修改任务说明，也不请求 SkillHub 提示词内容；目标测试集 5 个文件 183/183 通过。
- Task 17 浏览器回验：当前浏览器插件初始化仍失败（`Cannot redefine property: process`），未能直接点击本地页面；组件交互测试已覆盖相同链路。
- Task 18 组件验证：“调用技能”帮助按钮通过 `aria-describedby` 关联 Tooltip，并支持 hover 与键盘 focus；目标测试集 5 个文件 184/184 通过。
- Task 18 浏览器回验：浏览器插件仍受同一初始化错误阻断，未能直接回验悬浮效果。
- Task 19 组件验证：Tooltip 已替换为最新确认文案，帮助图标与交互保持不变；选择器组件测试 15/15 通过。
- Task 20 组件验证：任务说明占位文案已补充“使用 xxx 技能”示例，Skill 选择仍不会自动修改任务说明；选择器组件测试 15/15 通过。
- Task 21 组件验证：Tooltip 通过 Portal 挂载到 `document.body` 并使用 fixed 定位；hover 缓冲、键盘 focus、`aria-describedby` 与文案可选择能力保持不变；选择器组件测试 15/15、`pnpm check`、`pnpm i18n:check` 与 `git diff --check` 通过。
- Task 22 组件验证：Skill 列表最大高度由 16rem 收紧到 12rem，搜索区、列表和选项纵向间距同步缩小；选择器组件测试 15/15、`pnpm check` 与 `git diff --check` 通过。
- Task 22 浏览器回验：本地浏览器连接仍受已知初始化错误（`Cannot redefine property: process`）阻断，未能自动点击回验；当前本地预览可刷新后直接目测新间距。
- 国内站浏览器：已安装 Skill 搜索/选择、创建带 Skill、普通任务无 Skill、详情、编辑替换/移除、空态、失败态和不可用态通过；mock 页面无控制台错误。
- 国际站浏览器：英文创建、错误态、已安装 Skill 详情和编辑回显通过；mock 页面无控制台错误。
- 交付状态：代码、验证和提交范围均已确认，目标分支为 `frontsandbox/pablozhong-0714-automation-skill-invocation`。

## 下一步

展示 Task 22 增量差异并取得确认后，提交并推送到 `frontsandbox/pablozhong-0714-automation-skill-invocation`，更新现有工蜂 MR。

## 上一个已归档需求

「LightVela 场景任务安装器 v1」已于 2026-07-14 归档（21/21 任务完成）。详细记录：`openspec/changes/2026-07-14-scenario-task-installer.md`。
