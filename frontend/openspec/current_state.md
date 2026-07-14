# 当前需求状态

## 自动任务支持调用 Skill

- 阶段：已完成（Task 7/7 已完成）
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
- 实现状态：创建、编辑、详情与中英文国际化已完成，目标测试、静态检查和双站浏览器验证均通过

## 已确认方案

1. 抽取共享 Hermes 已安装 Skill 查询/解析模块。
2. 创建独立的可搜索单选 Skill 组件。
3. 创建任务时传零个或一个 Skill slug。
4. 编辑任务时用三态语义区分保持、替换和清空。
5. 详情展示可用、不可用和未知状态，不自动解绑或静默降级。
6. Skill 列表失败不阻断普通任务创建。

## 验证结果

- 目标测试：5 个文件，178/178 通过。
- 静态检查：`pnpm check` 通过。
- 国际化检查：`pnpm i18n:check` 通过，1505/1505。
- 国内站浏览器：已安装 Skill 搜索/选择、创建带 Skill、普通任务无 Skill、详情、编辑替换/移除、空态、失败态和不可用态通过；mock 页面无控制台错误。
- 国际站浏览器：英文创建、错误态、已安装 Skill 详情和编辑回显通过；mock 页面无控制台错误。
- 交付状态：代码、验证和提交范围均已确认，目标分支为 `frontsandbox/pablozhong-0714-automation-skill-invocation`。

## 下一步

从 `frontsandbox/pablozhong-0714-automation-skill-invocation` 创建到 `master` 的工蜂 MR。

## 上一个已归档需求

「LightVela 场景任务安装器 v1」已于 2026-07-14 归档（21/21 任务完成）。详细记录：`openspec/changes/2026-07-14-scenario-task-installer.md`。
