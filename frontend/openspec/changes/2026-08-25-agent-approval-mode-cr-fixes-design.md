# Agent 审批模式 CR 修复设计

## 背景

MR !3288 已将 Hermes `approvals.mode` 接入国内站 Agent 高级设置。事后评审确认三个用户可见问题：LightVela 出厂值 `off` 与 Hermes 默认值 `smart` 的差异未在恢复弹窗说明；未知审批模式会拖垮整页读取；已处于 `off` 时缺少持续风险提示。

## 目标

- 恢复「安全」分组前，明确告知审批模式将恢复为「智能审批」。
- Hermes 返回未知审批模式时，只将该字段降级为不支持，不影响其他高级设置。
- 当前审批模式为 `off` 时，展示低强度、非阻断的风险提示。
- 锁定不支持字段不会被恢复操作写入，以及同步重复保存会被互斥保护。

## 方案

### 恢复默认

保留 `hermes config unset approvals.mode` 和恢复后验证有效值为 `smart` 的既有行为。仅当待恢复分组是「安全」时，将通用弹窗说明替换为：

> 恢复后审批模式将变为「智能审批」（当前为「关闭审批」）。

其他分组继续使用现有通用说明。恢复操作仍即时生效，不重启 Gateway。

### 未知审批模式

Python reader 遇到 `approvals.mode` 非 `smart | manual | off` 时，将 `approvalMode` 加入 `unsupportedKeys` 并保留内部合法兜底值供快照解析。页面隐藏审批下拉框并显示「当前 Agent 版本不支持」，不得展示或写入猜测值；其他六项设置继续可用。

### 关闭审批提示

当有效审批模式为 `off` 且该字段受支持时，在审批模式行展示 amber 辅助提示：

> 当前不会请求危险命令审批

提示不使用阻断弹窗，不改变现有从其他模式切到 `off` 时的二次确认。

### 审批模式说明文案

将安全分组和审批模式设置项的两句中性说明分别调整为：

> 管理 Agent 执行高风险操作时的审批方式。

> 设置 Agent 执行高风险操作时的审批方式。

安全分组说明、`off` 常驻提示和关闭审批二次确认继续保留「危险命令」，避免削弱真实风险状态的警示强度。

## 测试

- reader：未知审批模式返回正常快照，且仅 `approvalMode` 在 `unsupportedKeys`。
- panel：安全恢复弹窗展示实际 `off → smart` 结果；现有 `off` 展示风险提示，其他模式不展示。
- reset：同组混合支持状态只 unset 受支持字段，不返回误报 partial。
- panel：同一 React flush 内的重复保存只调用一次保存函数，锁定 `saveInFlightRef` 互斥。
- panel：安全分组与审批模式设置项均展示「高风险操作」新说明，两句旧说明不再出现。
- 运行审批模式焦点测试、i18n、类型检查、双区域构建和 diff 检查。

## 非目标

- 不修改 LightVela 镜像的出厂 `approvals.mode: off`。
- 不接入 `approvals.destructive_slash_confirm`、`cron_mode` 或 `mcp_reload_confirm`。
- 不重构通用设置类型体系、测试 polyfill 或历史计划文档。
