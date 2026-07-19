# 预发布统一回归

这套回归用同一个 Go runner 验证租户准入、套餐发放、渠道同步、普通请求、SSE、流量面滚动、单 Set 意外 Pod 故障、Fleet Campaign、自动回滚和 set-manager 接管。Case 名描述要证明的结果，Scenario 只组合 Case。

## 环境前提

- Namespace 中已有 `cloud-mockllm`、`llmgateway-control` 和 `llmgateway-traffic`。
- 已建立稳定套餐 `regression-monthly`，并同步到参与回归的 Set。
- 已建立渠道包 `regression-mock-channel`。它只包含回归渠道，地址为 `http://llmgateway-regression-pacer:18082`，暴露 `llmgw-regression-chat,llmgw-regression-long,llmgw-regression-upgrade-probe`。普通模型映射到 mockllm 模型；长流和升级探针模型必须保留原名，分别供 pacer 控制 SSE 节奏和隔离故障注入。
- `regression-mock-channel` 不携带任何全局 Option。三个回归模型的 `ModelRatio`、`CompletionRatio` 由唯一生效配置 `golden-channels` 管理，避免多个包互相覆盖 new-api 全局状态。
- `llmgateway-control-runtime` Secret 包含 `CLUSTER_ADMIN_TOKEN` 和 `INTERNAL_SERVICE_TOKEN`。

稳定套餐和渠道包可用 `bootstrap-fixtures.sh` 幂等登记。脚本会读取并保留 `golden-channels` 的完整配置，只向其倍率中补齐回归模型；回归渠道仍保存在独立无 Option 的包中。随后脚本把黄金配置、套餐和回归渠道同步到所有 active、已初始化的 Set：

```bash
LLMGATEWAY_REGRESSION_CONTROL_URL='https://control.example.com' \
LLMGATEWAY_REGRESSION_ADMIN_TOKEN='...' \
LLMGATEWAY_REGRESSION_TARGET_SETS='set-a,set-b' \
test/regression/bootstrap-fixtures.sh
```

## 集群内完整回归

```bash
LLMGATEWAY_REGRESSION_IMAGE='registry/llmgateway@sha256:...' \
LLMGATEWAY_REGRESSION_TARGET_SETS='set-auto-000001,set-auto-000002' \
test/regression/run.sh
```

脚本会明确打印当前 kube context、Namespace 和目标 Set，然后安装稳定 pacer/RBAC 并创建一次性 Job。成功时收集 JSON、JUnit 和 Job 日志到 `artifacts/regression/<run_id>/`，随后删除 Job 和报告 ConfigMap；失败时保留现场。

完整 `preprod_release_gate` 必须在集群内运行，因为它会直连基线 Pod IP 并通过 resourceVersion JSON Patch 触发 `llmgateway-traffic` 滚动。runner ServiceAccount 不拥有 Job 写权限，也不会读取或修改 new-api 数据库。

滚动前会先启动 Service 路径长流，再以默认 30 秒余量为每个基线 traffic Pod 各启动一条直连长流；触发滚动时所有流都处于进行中。所有直连流都必须完整结束，且至少一条必须证明其 Pod 进入 `Terminating` 后仍收到事件。这样不依赖 Kubernetes 选择旧 Pod 的删除顺序。

OrbStack 快速回归可缩短长流，同时缩短直连余量并提高普通请求采样频率：

```bash
LLMGATEWAY_REGRESSION_IMAGE='llmgateway:local' \
LLMGATEWAY_REGRESSION_TARGET_SETS='set-a,set-b' \
LLMGATEWAY_REGRESSION_SSE_DURATION='20s' \
LLMGATEWAY_REGRESSION_PINNED_STREAM_HEADROOM='3s' \
LLMGATEWAY_REGRESSION_REQUEST_INTERVAL='100ms' \
LLMGATEWAY_REGRESSION_ROLLOUT_TIMEOUT='5m' \
test/regression/run.sh
```

## Fleet Campaign 门禁

`fleet_release_campaign_gate` 使用已经登记的目标 Release，按配置的 Ring 顺序观察整个 Campaign。运行期间流量采样和控制面轮询使用独立节奏；任意一次真实模型请求失败、Ring 越序、同时升级多个 Set、generation 跳代或最终 Release 分布不一致都会失败：

```bash
LLMGATEWAY_REGRESSION_SCENARIO=fleet_release_campaign_gate \
LLMGATEWAY_REGRESSION_IMAGE='<llmgateway-runner@sha256:digest>' \
LLMGATEWAY_REGRESSION_TARGET_SETS='set-canary,set-stable' \
LLMGATEWAY_REGRESSION_TARGET_RELEASE_ID='release-v2' \
LLMGATEWAY_REGRESSION_EXPECTED_RINGS='canary,stable' \
test/regression/run.sh
```

## 破坏性 P0 门禁

`set_upgrade_rollback_gate`、`set_manager_takeover_gate` 和 `set_traffic_pod_failure_gate` 只能针对一个明确隔离的 Set；`control_plane_outage_gate` 也建议只选一个代表 Set。runner 镜像必须使用不可变 digest；升级类场景还要求 `TARGET_IMAGE` 是 new-api 的不可变 digest，可以与当前镜像相同。目的在于验证运行时状态机，而不是引入业务版本变化。

- `set_upgrade_rollback_gate`：Green Pod 先通过真实推理功能就绪检查，允许 new-api 在有界时间内加载定价缓存；随后主动让探针连续失败，证明未切流。第一段清障后重试原 failed run；第二段在切流后的回滚窗口注入失败并回到旧 runtime，清障后必须创建新 batch 完成发布，不能改写已经 `rolled_back` 的历史。
- `set_manager_takeover_gate`：分别在 `preparing`、`switching`、`draining` 终止持有租约的 manager Job，等待 10 秒测试租约过期，再由新 Job 接管。受控 Job 使用自身名称作为租约 owner，门禁会拒绝普通 CronJob 抢占造成的假通过；每轮只允许增加一个 generation。
- `control_plane_outage_gate`：暂停 Set Manager，将五类 worker 和 control 真实缩容到 0，持续 90 秒使用停机前签发的 Key 采样推理流量。恢复后要求预先排队的 `refresh_set_capacity` 恰好产生一个成功 run、lease 清空，并恢复所有原始副本数。该场景不会缩容 `llmgateway-traffic` 或任何 new-api runtime。
- `set_traffic_pod_failure_gate`：目标 Set 必须处于单 generation、双 Ready 副本稳态，两个副本必须实际分布在两个 `topology.kubernetes.io/zone`。门禁与流量滚动共用互斥 Lease，直连其中一个 Pod 建立 SSE 后执行零宽限删除，同时通过稳定流量入口持续采样；要求普通请求不连续失败、不同 UID 的替补 Pod 恢复双副本跨区，SSE 重连后完整结束。硬故障下原 TCP/SSE 允许中断一次。

```bash
LLMGATEWAY_REGRESSION_SCENARIO=set_upgrade_rollback_gate \
LLMGATEWAY_REGRESSION_IMAGE='<llmgateway-runner@sha256:digest>' \
LLMGATEWAY_REGRESSION_TARGET_SETS='<isolated-set>' \
LLMGATEWAY_REGRESSION_TARGET_IMAGE='<new-api@sha256:digest>' \
test/regression/run.sh

LLMGATEWAY_REGRESSION_SCENARIO=set_manager_takeover_gate \
LLMGATEWAY_REGRESSION_IMAGE='<llmgateway-runner@sha256:digest>' \
LLMGATEWAY_REGRESSION_TARGET_SETS='<isolated-set>' \
LLMGATEWAY_REGRESSION_TARGET_IMAGE='<new-api@sha256:digest>' \
test/regression/run.sh

LLMGATEWAY_REGRESSION_SCENARIO=control_plane_outage_gate \
LLMGATEWAY_REGRESSION_IMAGE='<llmgateway-runner@sha256:digest>' \
LLMGATEWAY_REGRESSION_TARGET_SETS='<isolated-set>' \
test/regression/run.sh

LLMGATEWAY_REGRESSION_SCENARIO=set_traffic_pod_failure_gate \
LLMGATEWAY_REGRESSION_IMAGE='<llmgateway-runner@sha256:digest>' \
LLMGATEWAY_REGRESSION_TARGET_SETS='<isolated-set>' \
test/regression/run.sh
```

普通 runner 继续使用 `llmgateway-regression-runner`，无 Job 写权限。只有显式选择破坏性 Scenario 时，`run.sh` 才安装并使用 `llmgateway-regression-disruptive`。脚本会暂停常规 set-manager CronJob，受控 Job 从原 CronJob 模板派生；退出时恢复 CronJob 并关闭 pacer 故障。北京是允许执行这些动作的集成环境，不是正式生产。

回滚 Scenario 的两个故障阶段共享同一次 CronJob 暂停，并在 runner 统一 cleanup 时恢复。暂停确认同时检查 CronJob `status.active` 与实际由它拥有的 Active Job，不能只依赖可能滞后的状态投影。

失败运行只保留租户、密钥、升级记录等诊断资源。恢复 CronJob、关闭 pacer 故障和删除受控 manager Job 属于 Safety Cleanup，成功或失败都必须执行。`rolled_back` 是不可变的发布历史；清障恢复必须创建新的升级 batch，从当前 generation 重新走完整状态机。

## 本地非滚动回归

本地可直接执行 `tenant_onboarding_gate` 或 `model_delivery_gate`。Token 只通过环境变量注入，禁止写入 YAML：

```bash
export LLMGATEWAY_REGRESSION_ADMIN_TOKEN='...'
export LLMGATEWAY_REGRESSION_INTERNAL_TOKEN='...'
go run ./test/regression/cmd/runner \
  --config /secure/regression.yaml \
  --json-report /tmp/regression.json \
  --junit-report /tmp/regression.xml
```

失败运行不会自动删除租户和 Key，报告的 `retained_resources` 会列出现场。成功运行按逆序执行已登记清理动作。

排障完成后，可按原 `run_id` 幂等清理保留的租户、订阅和 Key：

```bash
go run ./test/regression/cmd/runner \
  --config /secure/regression.yaml \
  --cleanup-run-id 20260717t120000z-deadbeef
```

一次性 Job、配置和报告 ConfigMap 由外部操作者删除；runner ServiceAccount 刻意没有 Job 删除权限。
