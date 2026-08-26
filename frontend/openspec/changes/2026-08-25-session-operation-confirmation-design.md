# Agent 会话操作确认设计

## 背景

LightVela 的 Agent 高级设置已经在「安全」分组提供「审批模式」，用于配置 Hermes `approvals.mode`。Hermes 另有布尔配置 `approvals.destructive_slash_confirm`，控制用户执行 `/new`、`/reset`、`/clear`、`/undo`、`/exit --delete` 或 `/quit --delete` 等可能清空、撤销或删除会话内容的命令前是否需要确认。LightVela 镜像当前将该值预置为 `false`，但用户只能进入终端修改。

本次在同一「安全」分组增加可视化开关，并将该分组的「恢复默认」语义统一为恢复 LightVela 预置值。不得继续把安全分组恢复成 Hermes 官方默认值。

## 用户体验

「安全」分组保留现有「审批模式」，并在其下新增开关：

- 名称：`会话操作确认`
- 说明：`新建会话，或清空、撤销、删除会话内容前，先向你确认。`
- 开启：写入 `approvals.destructive_slash_confirm: true`
- 关闭：写入 `approvals.destructive_slash_confirm: false`

开关遵循现有设置页的加载中、保存中、Agent 非运行态和版本不支持禁用规则。关闭开关前展示风险确认，明确关闭后相关会话操作将直接执行；开启时使用现有开关确认交互。保存成功后回读并展示实际生效值。

国内站和国际站复用同一套高级设置面板及行为，不增加区域差异。

## 配置模型与数据流

扩展现有 typed common-settings 框架，新增布尔字段 `destructiveSlashConfirm`，映射 Hermes 配置键 `approvals.destructive_slash_confirm`，并加入 `security` 分组。

读取链路沿用现有批量读取命令：

1. 使用 `hermes config get approvals.destructive_slash_confirm --json` 获取有效值。
2. 缺少显式配置时按 Hermes 官方默认值 `true` 解析，并记录为默认状态。
3. 返回值不是布尔值时视为读取错误，不猜测值。
4. 当前 Hermes 不支持该键时，只将 `destructiveSlashConfirm` 标记为不支持，其他设置继续可用。

保存链路为：

1. 执行 `hermes config set approvals.destructive_slash_confirm true|false`。
2. 不重启 Gateway；Hermes CLI 与 Gateway 在处理相关会话命令时读取该配置。
3. 重新读取完整高级设置快照。
4. 仅当回读值与目标值一致时报告成功；写入成功但回读失败时沿用现有部分成功反馈。

不直接编辑 YAML，不新增独立设置模块，也不引入新的依赖或后端接口。

## 安全分组恢复默认

「安全」分组的恢复目标固定为 LightVela 预置值：

```yaml
approvals:
  mode: off
  destructive_slash_confirm: false
```

执行恢复时：

1. 对受当前 Hermes 支持的安全字段分别执行 `hermes config set`，不得对它们执行 `hermes config unset`。
2. 不重启 Gateway。
3. 回读并验证 `approvalMode === "off"`、`destructiveSlashConfirm === false`。
4. 某一字段不受支持时跳过该字段，但仍恢复其余受支持字段。
5. 任一写入或回读验证失败时沿用现有失败或部分成功反馈，不把未验证结果报告为成功。

安全分组仅在所有受支持字段均已等于上述 LightVela 预置值时禁用「恢复默认」按钮。其判断不再依赖 `defaultedKeys`。记忆和上下文管理分组继续通过 `config unset` 恢复 Hermes 默认值，行为保持不变。

恢复确认弹窗明确说明将恢复为「关闭审批、关闭会话操作确认」，避免继续显示「智能审批」或笼统的 Hermes 默认值文案。

## 错误与兼容处理

- 配置读取失败：保留现有整页读取失败与重试体验。
- 单字段不支持：只读降级该字段，显示「当前 Agent 版本不支持」。
- 保存失败：开关保持回读前状态并显示字段错误。
- 保存部分成功：提示用户刷新确认，不假定配置已经生效。
- 安全分组恢复部分成功：更新可回读快照并提示部分失败。
- 并发保存、恢复、Agent 状态变化：沿用现有请求 ID 和 in-flight 防重保护。

## 测试与验收

按 TDD 先补失败测试，再写最小实现：

- typed model：字段、分组、布尔校验、配置键映射、读取默认值与版本不支持降级。
- command：构造严格的 `config set ... true|false` 命令；该字段不要求 Gateway 重启。
- save：保存后回读验证，覆盖成功、失败和部分成功。
- reset：安全分组写回两个 LightVela 预置值且不执行 `unset`；记忆和上下文分组行为不变。
- panel：设置名称、说明、开关状态、关闭确认、禁用状态、错误反馈和恢复弹窗文案。
- region：国内站与国际站继续渲染同一安全设置。
- i18n：补齐简体中文、繁体中文、英文和印尼语生成资源。

完成前至少运行相关 Vitest、`pnpm i18n:check`、`pnpm i18n:zh-hant:check`、`pnpm check`、`pnpm build:cn`、`pnpm build:global` 和定向 `git diff --check`。

## 不在本次范围

- 不修改 LightVela 镜像的现有预置值。
- 不修改 Hermes 上游对破坏性会话命令的识别范围。
- 不接入 `approvals.cron_mode`、`approvals.mcp_reload_confirm` 或其他安全配置。
- 不调整 `approvals.mode` 的三个可选值和普通保存行为。
- 不提交、推送或创建 MR，除非用户另行确认。
