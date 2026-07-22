# 北京 LLMGateway 增量切换设计

## 目标

北京 `ctl` 同时保留旧 `ai-gateway` 与新 `LLMGateway`。首批仅允许业务用户
`usr_31b0bd10d198d7aa7012fbf0` 的新订阅和新实例进入 LLMGateway，其他用户保持
原有行为。

## 路由语义

- `user_subscription_gateway` 仍是已分配用户的归属真源。
- 新增 `CTL_LLMGATEWAY_NEW_USER_ALLOWLIST`，逗号分隔精确 user ID；`*` 表示允许
- 新增 `CTL_LLMGATEWAY_RENEWAL_MIGRATION_ALLOWLIST`，独立控制存量用户在续费时迁移；逗号分隔精确 user ID，`*` 表示全量迁移。
- 续费迁移先在 LLMGateway 准备订阅并对齐绝对到期时间，再由实例子任务后台执行 `provider save → model switch → gateway restart`。所有实例成功后，ctl 在同一事务提交 pass 续费和用户网关归属。
- 迁移为只前进语义：不撤销旧 key、不取消旧订阅；失败实例持续重试，旧系统资源自然过期。
  所有无归属用户。
- 白名单只决定“无归属用户”的首次分配，不覆盖已经持久化的归属。
- LLMGateway 配置不完整时整体禁用，即使用户在白名单中也继续走旧网关。
- 首批北京值只包含 `usr_31b0bd10d198d7aa7012fbf0`。

## 北京配置

- 控制面：`https://llmgw-control.lightvela.com`
- 流量面：`https://llmgw-inner.lightvela.com/v1`
- 默认模型：`auto`
- admin/internal token 从北京 LLMGateway Kubernetes Secret 复制到 ctl 的 SOPS
  Secret，不在 Git 中出现明文。

## 验证

- 非白名单新用户仍调用旧 ai-gateway。
- 白名单用户的新订阅、key 和实例配置使用 LLMGateway。
- 已记录为 `llm_gateway` 的用户移出白名单后仍保持原归属。
- 已记录为 `ai_gateway` 的存量用户不被白名单覆盖。
- 北京发布后分别对灰度用户和普通用户执行订阅、积分查询和推理冒烟。
