# 北京预发布统一回归基建实现计划

## 目标

按已批准的设计实现统一 Go 回归 runner。第一阶段交付可在 OrbStack 和北京集群内运行的
`preprod_release_gate`，覆盖渠道交付、正式 Plan 准入、外部 Key、普通/SSE 推理和 traffic
Deployment 无损滚动，并输出 JSON/JUnit 报告。

## 1. 框架、Secret 和报告

- 新建 `test/regression/framework`，实现结果式 Case 注册、能力检查、依赖跳过、Scenario、
  RunContext、资源记录和终态 cleanup phase。
- 实现不可格式化 Secret、统一 sanitizer、结构化安全 logger。
- 实现 JSON/JUnit 同源报告和 Kubernetes termination 摘要。
- 测试依赖失败、cleanup_failed、失败保留、四类 Secret 泄漏路径和 JSON/JUnit 一致性。

## 2. 安全客户端

- 新建 `test/regression/clients`，实现 LLMGateway control/internal、OpenAI traffic 和 Kubernetes
  客户端。
- HTTP 错误只保存 method/path/status/受控 message，不记录 Authorization、原始请求或完整响应。
- Kubernetes 客户端实现 Deployment/PDB/Pod/ReplicaSet 读取、Lease、resourceVersion JSON Patch、
  ConfigMap 报告和 rollout 观测。
- 测试冲突、Lease 丢失、响应脱敏和目标资源校验。

## 3. 控制面与基础流量 Case

- 实现 `platform_is_ready_to_serve`、`channel_config_reaches_target_sets`、
  `tenant_can_be_onboarded`、`tenant_can_receive_an_api_key`、
  `issued_key_can_complete_chat`、`issued_key_can_stream_chat`。
- 正式准入固定走 assignment -> users/ensure -> ApplySubscription，并在订阅后复核 Set。
- 注册租户删除 cleanup，等待异步删除终态；失败时保留现场。
- 使用受控 HTTP 行为桩测试每个 Case 的输入、输出和错误边界。

## 4. 滚动升级 Case

- 实现 `active_requests_survive_traffic_rollout` 和 `platform_returns_to_healthy_state`。
- 同时运行统一入口 SSE、指定旧 Pod 直连 SSE 和普通请求采样。
- 使用 Kubernetes Lease 串行化回归，JSON Patch 触发滚动，持续验证 generation、annotation 和
  Pod template 指纹。
- 校验直连 Pod Terminating 后流仍继续、统一入口无断流、分阶段最小样本及最终健康。

## 5. Fixture、清单和入口

- 把 pacer 抽成独立 Go 服务，复用 `kagent-dev/mockllm`，增加 OrbStack/生产回归 fixture 清单。
- 增加 runner ServiceAccount/RBAC、Job 模板、Scenario 配置和 `run.sh` 报告收集。
- OrbStack traffic 清单补齐生产滚动参数、标签和 PDB。
- 在生产模板契约测试中锁定 RBAC、fixture 和 Job SecretKeyRef。

## 6. 验证

- 单元/HTTP：`go test ./test/regression/...`
- 全仓：`go test ./...`、`go vet ./...`
- OrbStack：20 秒缩短版 `preprod_release_gate`。
- 北京：3 分钟完整 `preprod_release_gate`，确认双 SSE、普通流量、真实滚动、报告和清理。
