# Frontend Trigger Probe

这个文件只用于触发 `frontend/**` 路径级变更，帮助重新拉起前端相关发布或验证流程。

约束：

- 不承载产品逻辑
- 不承载运行时配置
- 仅作为无行为变化的触发探针文件使用

Trigger note 1:

- 用于在 release-frontend 路径修正后，再次触发 frontend 目录级更新。

如果只是为了触发前端发布链路，优先更新本文件，而不是混入真实功能改动。
