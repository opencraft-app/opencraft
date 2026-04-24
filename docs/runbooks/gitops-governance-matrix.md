# GitOps Governance Matrix

## Beijing Sandbox

目标：

- 更快迁移
- 更快验证
- 更低流程阻力

允许：

- 更宽的 GitLab CI 触发权限
- bot PR 自动合并（若平台决定启用）
- 更快的服务 onboarding 节奏

不允许：

- runtime 直连 `SSM`
- 迁入 Argo 后继续把脚本当主入口

## Shanghai Production

目标：

- 最小变更面
- 清晰审批
- 强审计

强制要求：

- protected branch
- protected environment
- protected pipeline
- 少数维护者可执行 `SSM -> sops` 变更
- bot PR 必须人工批准，不能自动合并

验证：

- 非授权 actor 推进 secret/deploy 变更失败
- 审批链和审计链完整

## Shared Rules

- 架构相同，不做测试/正式两套不同平台
- 差异只体现在治理强度，不体现在技术拓扑
