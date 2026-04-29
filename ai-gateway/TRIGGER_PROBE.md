# AI Gateway Trigger Probe

这个文件只用于触发 `ai-gateway/**` 路径级变更，帮助重新拉起 ai-gateway 相关发布或验证流程。

约束：

- 不承载产品逻辑
- 不承载运行时配置
- 仅作为无行为变化的触发探针文件使用

Trigger note 1:

- 用于在 ai-gateway Docker build context 修复后，再次触发 ai-gateway 发布流水线。
