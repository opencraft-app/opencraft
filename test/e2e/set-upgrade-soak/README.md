# Set 蓝绿升级长稳回归

这个用例是可重复执行的集群级回归程序，不是一次性操作脚本。默认契约固定为：

- 连续升级同一个 Set 20 个 runtime generation；
- 400 个独立用户持续请求，其中 100 个用户持续建立 20 秒 SSE；
- SSE 用户固定归属目标 Set，其他用户分散到最多 4 个 active Set；
- 每代验证 `generation + 1`、`route_revision + 1`、Green Ready、Blue 删除；
- 每代独立检查普通请求和 SSE 的成功率及最短 SSE 时长；
- 任意一步失败立即停止，并在 Job 日志和 termination message 输出 JSON 报告；
- 测试期间暂停常规定时 set-manager，退出时恢复原状态。每一代由回归器从同一个 CronJob 模板创建受控 Job。

推理始终通过集群内的开源 `kagent-dev/mockllm`。回归 Pod 内的轻量节奏器只把 mock 立即返回的 SSE 事件均匀释放到 20 秒，不生成模型响应。

## 本地快速验证

先用 OrbStack 的标准 KRO 环境启动集群并构建当前 `llmgateway:local`，再执行：

```bash
LLMGATEWAY_SOAK_TARGET_SET=set-a \
LLMGATEWAY_SOAK_RUNNER_IMAGE=llmgateway:local \
LLMGATEWAY_SOAK_GENERATIONS=2 \
LLMGATEWAY_SOAK_USERS=40 \
LLMGATEWAY_SOAK_SSE_USERS=10 \
LLMGATEWAY_SOAK_DRAIN_TIMEOUT=15s \
LLMGATEWAY_SOAK_ROLLBACK_WINDOW=10s \
./test/e2e/set-upgrade-soak/run.sh
```

缩小参数只用于验证测试基础设施。发布门禁和北京长稳测试保持默认的 `4/400/100/20s`。

## 北京集成环境

使用已推送到 TCR 的不可变 LLMGateway 镜像作为 runner，并明确使用云上 mock：

```bash
LLMGATEWAY_SOAK_NAMESPACE=llmgateway \
LLMGATEWAY_SOAK_FLEET=prod \
LLMGATEWAY_SOAK_SOURCE=prod \
LLMGATEWAY_SOAK_TARGET_SET=<canary-set> \
LLMGATEWAY_SOAK_RUNNER_IMAGE=<tcr-llmgateway-image@sha256:digest> \
LLMGATEWAY_SOAK_IMAGE_PULL_POLICY=IfNotPresent \
LLMGATEWAY_SOAK_MOCK_URL=http://cloud-mockllm:8080 \
LLMGATEWAY_SOAK_UPSTREAM_MODEL=llmgw-mock-chat \
LLMGATEWAY_SOAK_ADMIN_SECRET=llmgateway-control-runtime \
LLMGATEWAY_SOAK_ADMIN_SECRET_KEY=CLUSTER_ADMIN_TOKEN \
LLMGATEWAY_SOAK_INTERNAL_SECRET=llmgateway-set-manager-runtime \
LLMGATEWAY_SOAK_INTERNAL_SECRET_KEY=INTERNAL_SERVICE_TOKEN \
./test/e2e/set-upgrade-soak/run.sh
```

`LLMGATEWAY_SOAK_TARGET_IMAGE` 默认读取 `LLMFleet.spec.newapiImage`，且程序会拒绝非 digest 镜像。测试渠道只使用 `llmgw-upgrade-soak` 虚拟模型，不会调用真实腾讯上游。

保存 soak 渠道包前，runner 必须读取 `golden-channels` 的完整 `ModelRatio` 和 `CompletionRatio`，只为 `llmgw-upgrade-soak` 增补条目。黄金包缺失、Option 不是完整对象或读取失败时会在写入前终止，绝不把局部倍率 map 覆盖到共享环境。
