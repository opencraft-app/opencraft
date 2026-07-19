# 北京预发布统一回归基建设计

## 目标

建设一套统一的 Go 回归 codebase，让本地开发、Kubernetes Job 和北京预发布使用同一组行为契约。每个 Case 证明一个用户或运营结果，Scenario 只负责组合 Case。第一期同时覆盖控制面准入、渠道交付、外部 Key、普通推理、SSE 和流量面滚动升级。

这套基建不修改 new-api，不发明通用测试 DSL，也不把测试逻辑继续拆成互不相干的 Shell 脚本。

## 核心原则

1. Case 使用结果式命名，描述“平台证明了什么”，不暴露内部 API 或组件分层。
2. Case 可独立执行，也可由 Scenario 按依赖关系组合。
3. 同一个 Go runner 支持本地 CLI 和集群内 Kubernetes Job，但 Case 可以声明执行能力要求；需要直连 Pod IP 的滚动 Case 只能在集群内运行。
4. 每次运行拥有唯一 `run_id`，所有测试资源都可定位、可去重、可回收。
5. 成功后自动清理本次运行创建的测试资源；失败时保留业务现场，便于排障。预置回归 fixture 不属于单次运行资源。
6. 测试使用开源 `kagent-dev/mockllm` 与受控 SSE 节奏器，不消耗真实上游额度。
7. 不增加正式环境硬拦截。runner 在执行前输出目标集群、Namespace、控制面、流量面和目标 Deployment，调用方对目标负责。

## Codebase 结构

```text
test/regression/
  cmd/runner/                 # 唯一可执行入口
  framework/                  # Case、Scenario、上下文、依赖、清理和报告
  cases/                      # 行为 Case
  scenarios/                  # 内置 Scenario 注册
  clients/                    # LLMGateway、OpenAI、Kubernetes 客户端
  fixtures/                   # mockllm、独立 SSE pacer 和回归渠道 bootstrap
  manifests/                  # ServiceAccount、RBAC、Job 模板
  run.sh                      # 本地渲染、提交 Job、收集报告
  README.md                   # 中文运行手册
```

`framework` 不依赖具体业务 API。业务调用只存在于 `cases` 和 `clients`，避免执行器演变成另一个控制面。

## Case 契约

每个 Case 实现稳定接口：

```go
type Case interface {
    ID() string
    Dependencies() []string
    Run(context.Context, *RunContext) Result
}
```

`RunContext` 保存本次运行的不可变配置、共享客户端、已创建资源和清理栈。Case 不读取全局环境变量，也不自行退出进程。Case 的重试必须有明确超时，并把最后一次错误写入 Result。

Case 还声明 `Capabilities()`。`active_requests_survive_traffic_rollout` 要求 `kubernetes_api` 和 `cluster_pod_network`；runner 在本地进程缺少这些能力时于 Preflight 明确失败，不尝试把开发机流量直接发往北京 Pod 网段。北京预发布和 OrbStack 的完整 Scenario 均由本地 `run.sh` 提交集群内 Job 执行。本地直接运行 runner 主要用于非滚动 Case、报告调试和 `cleanup --run-id`。

第一期 Case：

| Case ID | 成功标准 |
| --- | --- |
| `platform_is_ready_to_serve` | control/traffic/mock/pacer 可达；目标 Set 已准入；回归 Plan 和渠道 fixture 已就绪；流量 Deployment 至少 2 副本；滚动策略、PDB 和退出窗口符合契约。 |
| `channel_config_reaches_target_sets` | 专用回归渠道包的当前 revision 在所有目标 Set 上交付，远端 channel 指纹一致且检查无 drift。 |
| `tenant_can_be_onboarded` | 唯一测试租户先写入目标 Set assignment，再通过 `users/ensure` 固化 binding，最后通过正式 Plan 订阅接口完成 new-api 用户创建、订阅和权益发放。 |
| `tenant_can_receive_an_api_key` | 租户获得可解析、可路由且归属正确 Set 的外部 Key。 |
| `issued_key_can_complete_chat` | 外部 Key 通过统一流量入口完成非流式 OpenAI-compatible chat，并收到 mock 标记。 |
| `issued_key_can_stream_chat` | 外部 Key 完成一次基础 SSE chat，事件格式、终止标记和最短持续时间正确。 |
| `active_requests_survive_traffic_rollout` | 同一个 Case 并发维持普通请求和单连接 3 分钟 SSE，再触发 `llmgateway-traffic` 滚动；普通请求无错误，原 SSE 连接持续到正常终止。 |
| `platform_returns_to_healthy_state` | 更新后目标副本全部 Ready、旧 Pod 消失、PDB 健康、容器无重启、健康端点恢复。 |

Case 的公开 ID 一旦进入发布门禁就视为兼容接口。内部包名可以使用 `control`、`traffic`、`kubernetes`，但报告中只出现结果式 Case ID。

## Scenario

Scenario 是有序 Case 列表和参数覆盖，不支持循环、条件表达式或任意脚本。第一期内置：

### `tenant_onboarding_gate`

```text
platform_is_ready_to_serve
channel_config_reaches_target_sets
tenant_can_be_onboarded
tenant_can_receive_an_api_key
issued_key_can_complete_chat
```

### `model_delivery_gate`

```text
platform_is_ready_to_serve
channel_config_reaches_target_sets
tenant_can_be_onboarded
tenant_can_receive_an_api_key
issued_key_can_complete_chat
issued_key_can_stream_chat
```

### `zero_downtime_release_gate`

```text
platform_is_ready_to_serve
channel_config_reaches_target_sets
tenant_can_be_onboarded
tenant_can_receive_an_api_key
active_requests_survive_traffic_rollout
platform_returns_to_healthy_state
```

### `preprod_release_gate`

完整组合全部 Case，作为北京预发布基础回归入口。依赖已成功的 Case 共享同一个租户、Key 和渠道，不重复创建资源。清理是 runner 的终态 phase，不进入 Case DAG；报告仍将清理结果作为独立 JUnit testcase 展示。

## 滚动升级回归

滚动 Case 的执行顺序固定：

1. 获取 Kubernetes Lease `llmgateway-regression-traffic-rollout`；Lease 被其他回归持有时等待或失败。Lease 只串行化回归任务，人工发布由后续 generation/template 指纹检查检测，不能声称被 Lease 阻止。
2. 记录 Deployment `resourceVersion`、generation、ReplicaSet、Pod UID、容器重启数和 PDB 状态。
3. 启动普通请求探测器并完成至少 10 个滚动前成功样本。
4. 建立两条 3 分钟 SSE：先通过统一 `trafficURL` 建立用户路径长流，再以默认 30 秒尾部余量启动直连基线 traffic Pod IP 的长流并记录其 Pod UID。两条连接都必须在 patch 前收到首个有效事件；错开起点用于覆盖 Kubernetes 不保证旧 Pod 删除顺序的情况。
5. 重新读取 Deployment 并确认 generation/resourceVersion 未被其他发布改变，再用 JSON Patch 的 `test /metadata/resourceVersion` 前置操作写入唯一 `llmgateway.io/regression-run` annotation。发生冲突立即失败，不覆盖他人发布。
6. 记录 patch 后的唯一期望 generation 和 Pod template 指纹。持续确认 generation、template 指纹和 annotation 没有再次变化；出现 generation+2 或指纹变化即判定外部发布干扰并失败。
7. 等待被直连的基线 Pod 进入 Terminating；此时绑定该 Pod 的 SSE 必须仍在接收事件。继续保持普通请求和两条原 SSE，直到它们正常结束、新 ReplicaSet Ready、所有基线 Pod UID 消失。
8. rollout 完成后继续取得至少 10 个普通请求成功样本，再校验 Pod、PDB 和最终健康状态。
9. Lease 每 `TTL/3` 续租；续租失败或 holder identity 丢失立即取消 Case。所有返回、panic 和 context cancel 路径都通过 deferred cleanup 尝试释放 Lease。

SSE 的 3 分钟由常驻回归 fixture `llmgateway-regression-pacer` Deployment/Service 控制。回归渠道的 `base_url` 固定指向该 Service，pacer 再调用 `cloud-mockllm`。mockllm 生成 OpenAI-compatible 事件，pacer 只控制事件释放节奏，不伪造模型响应。OrbStack 和北京预发布部署同一 fixture，因此本地 CLI 不需要把本机端口暴露给集群。

统一入口 SSE 与每个基线 traffic Pod 的直连 SSE 都必须满足：HTTP 200、`Content-Type: text/event-stream`、除唯一且最后的 `[DONE]` 外每个非空 `data:` payload 都可解析为 JSON、响应包含预期 mock marker、首事件发生在 patch 前、每条流的实际 HTTP 请求数恰好为 1。禁止客户端重连。所有直连流都必须完整结束，且至少一条必须以事件时间晚于对应 Pod 的 `deletionTimestamp`，证明 drain 期间原连接仍在收流；统一入口流证明 Service/CLB 路径没有断流。配置 `sseDuration: 3m` 时，每条流的服务端事件时间跨度和客户端连接时间都必须不小于 175 秒。

滚动采样窗口定义为“JSON Patch 成功”至“全部基线 Pod UID 消失”。因为被直连的基线 Pod 必须等待连接完成，该窗口在 3 分钟场景中应覆盖至少 120 个普通请求样本。SSE 可以先于 Deployment rollout complete 正常结束；正确契约是被直连 Pod 不能在对应 SSE 正常结束前消失。

默认阈值：

- SSE 最短持续时间：配置时长减 5 秒，3 分钟场景即 `>=175s`；
- 普通请求间隔：1 秒；
- 普通请求必须有至少 10 个 patch 前、120 个滚动期间、10 个 rollout 后样本；
- release gate 不允许普通请求出现 HTTP 非 2xx、连接中断、响应体不完整或 marker 错误；
- rollout 总超时：15 分钟；
- 最终 Ready 等待：3 分钟。

## 数据与清理生命周期

所有名称使用 `reg-<run_id>-<purpose>` 前缀，并在支持的对象上保存 `run_id`。runner 每创建一个资源就立即注册对应清理函数，不能等整个 Case 成功后才登记。

`cloud-mockllm`、`llmgateway-regression-pacer`、回归 Plan 和回归渠道包是环境 bootstrap fixture，不由单次运行创建或删除。回归渠道包只包含专用 mock channel，不携带全局 Option。bootstrap 将回归模型倍率合并进唯一生效配置 `golden-channels`，再分别同步黄金配置和回归渠道。历史/测试包只作为草稿或存档，不参与自动纳管、准入和定时漂移检查。

- 成功：进入 cleanup phase，按 Key、租户和本次运行临时 Kubernetes 资源的反向顺序回收，并等待异步租户删除进入终态。稳定渠道 fixture 不回收。
- 失败：不执行业务资源清理，报告列出保留对象及查询方式；runner 自身的临时 goroutine、连接和本地文件仍必须关闭。
- 重跑：新的 `run_id` 不复用旧资源。提供独立 `cleanup --run-id` 命令清理一次失败现场。

若业务 Case 全部成功但 cleanup 中途失败，运行状态为 `cleanup_failed`，报告必须列出已经删除和仍残留的资源。此时不声称“完整保留现场”；`cleanup --run-id` 可幂等续跑剩余动作。

测试不会删除运行前已经存在的资源。每个清理动作必须验证资源的 `run_id` 或受控名称前缀，验证失败时拒绝删除。

## 报告

runner 同时输出：

- 人类可读逐 Case 结果；
- 完整 JSON 报告；
- JUnit XML，供 CI 和发布平台展示；
- 最终单行摘要，写入 Kubernetes termination message。

每个 Case Result 至少包含：`case_id`、状态、开始/结束时间、持续时间、错误类型、错误信息、关键观测值和保留资源。滚动 Case 额外包含分阶段请求数、状态码分布、连接错误数、SSE 持续时间、HTTP 请求次数、更新前后 Pod UID 和 rollout 时长。

完整外部 Key、管理 token、上游 Key 和 Secret 内容不得进入日志、JSON、JUnit、错误体或 termination message。报告只允许保存 `external_key_id`、不可逆 hash 前缀和 Set ID。

Secret 在进入 RunContext 时即包装为不可格式化的专用类型，client 错误不包含 Authorization、请求体或原始响应体，logger 只接受经过 allowlist 的结构化字段。统一 sanitizer 同时作用于错误构造、logger、panic recovery、报告序列化和 ConfigMap 写入失败路径，而不是只在最终序列化时补救。测试必须覆盖成功、HTTP 错误、panic 和报告持久化失败四条泄漏路径。

runner 结束时创建一次 `llmgateway-regression-report-<run_id>` ConfigMap，`data/report.json` 与 `data/junit.xml` 总大小不得超过 900 KiB，并同时写入 `status=complete` 和内容 SHA-256 annotation。ConfigMap 只在完整报告生成后创建，避免读取半成品；创建失败时 Job 必须失败，并在日志输出带固定 framing 的压缩摘要。

`run.sh` 创建带 `run_id` label 的 Job，等待完成后读取并校验报告 ConfigMap 的 hash，把 Job 日志、JSON 和 JUnit 收集到本地 `artifacts/regression/<run_id>/`。成功收集后删除 Job、报告 ConfigMap和临时资源；失败现场默认保留。该本地目录不提交 Git。

## Kubernetes 权限

回归 ServiceAccount 使用独立 RBAC，仅允许：

- 读取 Deployment、ReplicaSet、Pod、Service、EndpointSlice 和 PDB；
- patch 指定 Namespace 内带 `app=llmgateway-traffic` 的 Deployment；
- 获取、创建、更新 Kubernetes Lease；
- 获取并创建报告 ConfigMap。

Kubernetes RBAC 不能按 label 或名称限制 Deployment patch 和 ConfigMap create，因此权限仍限定在预发布 Namespace。runner 在 patch 前验证 Deployment 名称、容器名和期望 label，并且只允许创建 `llmgateway-regression-report-<run_id>`；这是应用防护，不宣称由 RBAC 保证。Job 的创建、日志读取和删除由运行 `run.sh` 的外部身份完成，runner ServiceAccount 不拥有 Job 写权限。滚动使用 JSON Patch，所以 Deployment 只需要 `get/patch`，不授予 `update`。北京与 OrbStack 清单统一使用 `app=llmgateway-traffic`；实现阶段同步补齐 OrbStack 的滚动参数、退出窗口和 PDB。业务 API token 和 Kubernetes ServiceAccount 分离。

## 配置

runner 接受一个小型 YAML 配置，只包含目标和参数：

```yaml
scenario: preprod_release_gate
target:
  namespace: llmgateway
  trafficDeployment: llmgateway-traffic
  controlURL: http://llmgateway-control
  trafficURL: http://llmgateway-traffic
  mockURL: http://cloud-mockllm:8080
  pacerURL: http://llmgateway-regression-pacer:18082
  targetSets: [set-auto-000001]
  planID: regression-monthly
  channelBundleID: regression-mock-channel
  pricingBundleID: golden-channels
rollout:
  sseDuration: 3m
  requestInterval: 1s
  timeout: 15m
cleanup:
  preserveOnFailure: true
```

集群 Job 的 Secret 只通过 SecretKeyRef 注入。本地 CLI 从 `LLMGATEWAY_REGRESSION_ADMIN_TOKEN`、`LLMGATEWAY_REGRESSION_INTERNAL_TOKEN` 等受控环境变量读取，或由 `run.sh` 临时读取指定 Kubernetes Secret 后仅注入子进程；脚本不得 echo、写文件或拼进命令行参数。Secret 不进入 YAML、进程参数或报告。

允许命令行覆盖 scenario 和非 Secret 参数。配置解析后先打印目标摘要再执行，不增加生产环境硬拦截。Preflight 必须确认 `planID` 已同步至目标 Set，`channelBundleID` 只包含专用 mock channel且不携带全局 Option，并从 `pricingBundleID` 验证完整的 `CompletionRatio`、`ModelRatio`。租户准入严格按 `targetSets` 选择一个 Set，先调用内部 assignment API 写入 `backend=new/set_id`，再调用 `users/ensure` 创建 binding，然后调用正式订阅接口。由于目标 Set 在两次调用间失去准入时现有服务可能重新选择 Set，Case 必须在订阅后重新读取 binding/subscription，并断言最终 Set 仍属于 `targetSets`；发生漂移直接失败并保留现场。

## 现有测试资产收敛

- 复用 `set-upgrade-soak` 的 API client、统计窗口和 SSE pacer 思路，但将 pacer 抽成独立可部署 fixture，不直接依赖其 `package main`。
- 复用生产 smoke 的 mockllm fixture 和集群内地址约定。
- 第一阶段不删除现有 smoke/soak；新 runner 稳定后，让旧入口调用对应 Scenario，再删除重复实现。
- new-api Set 蓝绿 generation 回归继续由 `set-upgrade-soak` 承担；本设计首先验证 LLMGateway 自身 traffic Deployment 的无损滚动，两者不能混为同一个 Case。

## 失败处理

- Preflight 失败时不创建业务资源；环境 fixture 缺失直接失败，不在业务 Scenario 中隐式 bootstrap。
- Case 依赖失败后，后继 Case 标记为 `skipped_dependency`，而不是伪装成失败。
- 普通请求和 SSE 使用原始样本计算结果；重试只用于控制面最终一致性等待，不用于隐藏流量错误。
- rollout 冲突、Lease 丢失或超时后停止发起新请求，但等待当前采样器受控退出，再输出报告；不能把其他发布产生的新 ReplicaSet归因给本次 run。
- panic 由 runner 顶层恢复并写入失败报告；不允许只留下 Go stack 而没有 Case 上下文。

## 验收标准

1. `go test ./...` 覆盖依赖解析、清理顺序、失败保留、Secret redaction、Lease 互斥、报告序列化和分阶段请求统计。
2. OrbStack 清单补齐与北京一致的 traffic 标签、滚动策略、退出窗口和 PDB，并可运行 20 秒 SSE 的缩短版 `preprod_release_gate`。
3. 北京预发布可用 Kubernetes Job 运行完整 3 分钟 `preprod_release_gate`。
4. 回归期间真实触发 `llmgateway-traffic` 滚动，普通请求达到阈值，单连接 SSE 正常完成。
5. 成功后本次运行创建的测试业务资源清空，稳定 fixture 保持不变；故意制造失败后，报告准确列出保留现场，并可由 `cleanup --run-id` 回收。
6. 故意并发启动两个 rollout Scenario 时，只有 Lease 持有者能够 patch Deployment，另一运行明确失败或等待。
7. JSON 和 JUnit 对同一运行给出一致的 Case 状态和持续时间，ConfigMap hash 校验通过。
