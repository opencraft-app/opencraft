# 配置与维护展示边界

这些视图消费受控值、文案和 actions，不自行获取 Repository、Context、账户、Bot 或 SDK。

| 入口 | 展示接口 | 原容器保留 |
| --- | --- | --- |
| agent-channel-panel | ChannelCardView、ChannelMethodDialogView、ChannelCredentialDialogView | useChannelOperations、当前列表/配置、凭据草稿与 trim、QR/OAuth 分派、实例/Profile 参数 |
| agent-diagnostics-panel | DiagnosticLogView、MaintenanceActionCardView | bot/profile 命令、查询状态、50 行预览、100000 行流式导出、维护权限 |
| agent-common-settings-panel | CommonSettingRowView、AgentSection/AgentState/AgentConfirmDialog | snapshot、requestId、inflight、数值校验/草稿、保存/回读/重启、分组恢复 |
| agent-config/components/HermesQrCodeModal | HermesQrDialogView | imperative handle、flowId/statusRef、二维码解析、runWithProgress、OAuth、timeout |

通道卡片通过当前 Agents opt-in CSS 覆盖旧 lh-std 默认样式。独立消费者必须同时消费自身的 Agents scope 样式；Portal 节点带 agents-ui 标记，不能仅依赖页面祖先。

关闭策略由入口决定：

- 通道绑定成功才清空草稿并关闭，失败保留输入；断开等待原 deleteChannel 完成后关闭，包括返回失败。
- 高级设置先关闭开关/关闭审批/恢复默认确认，再提交原动作；开关 checked 始终来自 snapshot，不乐观切换。
- QR 关闭只隐藏本地 Dialog 并 reset UI；不递增 flowId、不取消远端执行，迟到的原成功事件仍按已有流程处理。
- 诊断选择时间仅更新受控范围；查询和导出保持显式按钮触发。

交互测试：__tests__/agent-channel-interactions.test.tsx、agent-diagnostics-interactions.test.tsx、agent-common-settings-panel.test.tsx，以及 agent-config/components/__tests__/HermesQrCodeModal.test.tsx。
