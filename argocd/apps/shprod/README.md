# Shanghai Production Apps

这个目录放上海正式环境的子 `Application` 清单。

额外约束：

- 只允许已经在北京验证过的服务进入
- secret 变更必须经过受保护流水线和受保护变更路径
- bot PR 不能自动合并，必须有人审批准入

当前已切 live deploy-facing 入口的服务：

- `admin-gateway`
- `ai-gateway`
- `ctl`
- `frontend`
- `gateway-dashboard`
- `lightclaw-auth`
- `nextgen-dashboard`
- `payment`
- `sandbox`
- `service-gateway`
- `subscription`

当前仍保持 skeleton / 待后续纳管：

- `session`
- `frontend-ds`
