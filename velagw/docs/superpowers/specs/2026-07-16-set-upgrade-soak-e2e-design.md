# Set 连续代际升级回归 E2E 设计

## 目标

沉淀一个受控、可重复执行的集群内回归程序，用同一套代码在 OrbStack 和北京集成环境验证 Set 蓝绿升级。默认连续升级 4 个 runtime generation，并在全过程维持 400 个真实 LLMGateway 用户的混合推理流量。

测试不是 shell 循环。Go Coordinator 持有测试状态机、每代断言、负载统计、失败停止和诊断报告；Shell 只负责渲染环境变量、创建 Kubernetes 资源和读取最终报告。

## 负载模型

- 400 个独立用户，使用正常 assignment、用户 provision、外部 key 和 new-api quota API。
- 300 个普通 Chat 用户，每约 10 秒调用一次 `/v1/chat/completions`。
- 100 个 SSE 用户，上一条结束后立即重连。
- SSE 响应至少持续 20 秒，并且必须收到首个 event、内容 event 与 `[DONE]`。
- 所有推理从 `llmgateway-traffic` 进入，不允许直连 new-api。
- 用户分布在所有 active/admitted Set；至少 100 个用户固定分配到被升级 Set，保证 Blue/Green 都承受真实流量。

## Mock 与 SSE pacing

`kagent-dev/mockllm` 继续负责 OpenAI-compatible 请求匹配和响应生成。测试 Pod 同时运行一个很薄的 pacing proxy：

- 非流式响应透明转发，不增加人为延迟。
- 流式响应先从 mockllm 读取完整 SSE event，再将 event 均匀释放到 20 秒窗口。
- pacing proxy 不生成模型 payload，不承担模型协议转换，只制造可重复的长连接时间条件。

渠道通过正常 channel bundle API 同步到所有目标 Set，base URL 指向 pacing proxy Service。

## 升级状态机

Coordinator 对每一代执行：

1. 读取目标 Set 的 `active_runtime_generation`、`route_revision` 和当前镜像。
2. 创建单 Set upgrade batch，要求目标镜像为 digest。
3. 创建独立 set-manager Job，并轮询 batch/run；全程保持续租和 worker outbox 正常工作。
4. 等待 `completed`，失败、回滚或超时立即停止整个回归。
5. 断言 generation 恰好增加 1，route revision 恰好增加 1。
6. 断言新 Deployment Ready、镜像 digest 正确，旧 generation Deployment 已删除。
7. 通过统一 traffic 对升级探针用户再执行一次普通推理。
8. 截取该代时间窗内 400 用户统计，确认普通请求与 SSE 没有不可接受错误。

测试开始前暂停周期性 set-manager CronJob，避免与测试创建的 Job 并行；退出时恢复原始 suspend 状态。

## 成功标准

- 连续完成配置的 generation 数，默认 4。
- 每代 generation 和 route revision 单调且精确递增。
- 每代旧 runtime 均在 drain deadline 后消失，不存在遗留 Deployment。
- 普通请求成功率不低于 99.9%。
- SSE 完整率不低于 99%，成功 SSE 实际持续时间不短于 19 秒。
- 不允许鉴权错误、错误 Set 路由、runtime key 缺失或连接池复用旧 revision。
- 最终输出 JSON 报告，包含每代阶段耗时、请求数、错误分类、SSE 时长和 K8s 资源断言。

## 失败处理

任一代失败即停止后续升级，不自动忽略。报告保留：

- batch 与 per-Set run JSON；
- 目标 Set 当前 generation/revision；
- LLMFleet `trafficRuntimes`；
- set-manager Job 状态和 termination log；
- 新旧 Deployment 状态；
- 负载错误类型及最近样本。

测试不自动删除 400 个用户，避免失败时丢失排障事实。清理由现有租户删除 API 作为显式后续动作执行。

## 部署形态

测试资源位于 `test/e2e/set-upgrade-soak/`：

- `main.go`：Coordinator、用户负载、SSE pacing 和 Kubernetes 编排。
- `manifest.yaml`：ServiceAccount/RBAC、ConfigMap、Service 与 Job 模板。
- `run-local.sh`：OrbStack 参数和 15 秒 drain。
- `run-cloud.sh`：北京参数和 330 秒 drain；要求显式 kubeconfig、目标 Set 和目标镜像。

生产业务 Deployment 不包含测试二进制；E2E Job 使用 Go 工具镜像从只读 ConfigMap 编译运行。
