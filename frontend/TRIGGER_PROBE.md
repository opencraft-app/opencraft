# Frontend Trigger Probe

这个文件只用于触发 `frontend/**` 路径级变更，帮助重新拉起前端相关发布或验证流程。

约束：

- 不承载产品逻辑
- 不承载运行时配置
- 仅作为无行为变化的触发探针文件使用

Trigger note 1:

- 用于在 release-frontend 路径修正后，再次触发 frontend 目录级更新。

Trigger note 2:

- 用于在 Node 22 / pnpm 自举修复后，再次触发 frontend 目录级更新。

Trigger note 3:

- 用于在 frontend 发布链改为直接通过 npm 安装 pnpm 后，再次触发 frontend 目录级更新。

Trigger note 4:

- 用于在 frontend 发布链彻底绕开 corepack shim 后，再次触发 frontend 目录级更新。

Trigger note 5:

- 用于在 CI 展示名中文化后，再次触发 frontend 发布流水线。

Trigger note 6:

- 用于在国内正式 API base 切到 `api.lightvela.com`、master 跳过 GitOps Docker 镜像构建后，再次触发 frontend 发布流水线。

如果只是为了触发前端发布链路，优先更新本文件，而不是混入真实功能改动。
