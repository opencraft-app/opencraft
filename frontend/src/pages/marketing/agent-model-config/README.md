# 模型配置展示边界

入口 AgentModelConfigPanel 保留 useModelConfig、连接身份/fingerprint、探测 revision、草稿和所有保存/删除动作。use-model-config 与 client 不因展示拆分改变。

- ModelProviderGroupView：受控展开、标题/角色摘要、添加触发器和 children；没有探测 effect。
- ConfiguredModelRowView：显示名称/角色、调用端计算的禁用条件与三项 actions；身份与主/备用判定在入口。
- ConfiguredProviderModelForm：保留固定 anchor、ownedOperation、requestRevision、取消 probe、Toast 和草稿；ConfiguredProviderModelFormView 只渲染已计算的 options/labels/values 与 callbacks。
- ModelConnectionResultView：受控结果 Dialog，按 labels/rows 展示，关闭恢复触发器。
- ModelActionTooltip 为共享 AgentTooltip 的兼容入口，不再自行计算位置或维护 Portal。

删除确认使用 AgentConfirmDialog：原 remove 返回 true 才关闭，false 留窗重试；成功后焦点去配置列表标题。丢弃草稿与取消行为仍由原容器处理。不要把其他模块的关闭时机套到模型流程。

验证入口：__tests__/model-config-panel.test.tsx 与 model-action-tooltip.test.tsx；业务协议覆盖仍在 use-model-config 和 client 相邻测试。
