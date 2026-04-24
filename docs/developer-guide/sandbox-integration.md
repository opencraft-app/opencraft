# Sandbox 核心概念与 ctl 集成

本文档面向 `ctl` 开发者，保留当前仍然成立的 `sandbox` 集成模型。运行脚本和部署步骤以 agent/deploy guide 为准，不在这里重复现场操作细节。

相关入口：

- `ctl` 本地联调： [docs/agent-guides/ctl-local-run-guide.md](../agent-guides/ctl-local-run-guide.md)
- `sandbox` 开发/运维入口： [docs/agent-guides/sandbox-agent-guide.md](../agent-guides/sandbox-agent-guide.md)
- `sandbox` 发布入口： [docs/deploy-guides/sandbox-deploy-guide.md](../deploy-guides/sandbox-deploy-guide.md)

## 1. 当前集成事实

- `ctl` 当前通过 `ctl/pkg/adapter/sandbox/adapter.go` 调用 `sandbox` HTTP API
- `ctl` 不再围绕旧的 `RuntimeProvider` 抽象写新逻辑
- `sandbox` 的核心资源模型是：
  - `Pool`
  - `Instance`
  - `Sandbox`

关系可以理解为：

- `Pool`：预建库存的配置单元
- `Instance`：底层 CVM 记录
- `Sandbox`：面向调用方暴露的客户端视图

## 2. pool/template 的关系

- `ctl` 的 template 本质上就是 `sandbox` 的 `pool.id`
- `default_template_id` / `candidate_template_ids` 对应 pool 选择
- pool 不是逻辑标签，而是云资源参数集合，所以同一个 template 是否可用会随现网变化

补充参考： [sandbox-template.md](sandbox-template.md)

## 3. 实例状态机

核心流转：

```text
CREATING -> CLEAN -> ALLOCATED -> DRY -> RESETTING -> CLEAN
```

关键约束：

- 请求路径只做分配与释放，不做创建或重装
- Worker 负责补货、重装、清理
- `ALLOCATED` 实例不会在镜像 rollout 时被强改

## 4. Timeout 现状

`sandbox` 的 timeout 目前不是强制回收机制。

这意味着：

- `sandbox` 会存储 timeout 字段并返回展示信息
- 但不会自动替 `ctl` 回收实例
- 如果业务需要“超时自动销毁”，需要由 `ctl` 自己负责调度和回收

## 5. 当前推荐的验证方式

不要依赖固定环境地址，统一优先用 `port-forward`：

```bash
kubectl --kubeconfig .secret/cls-8gnhos9p-config \
  port-forward -n sandbox svc/sandbox-api 18081:80
```

常用检查：

```bash
curl -sS http://127.0.0.1:18081/health
curl -sS http://127.0.0.1:18081/pools | jq .
```

## 6. ctl 侧要关注什么

- `adapter.sandbox.baseUrl` 是否指向当前可访问的 `sandbox-api`
- `default_template_id` / `candidate_template_ids` 是否对应现网可用 pool
- 当 `CreateInstance` 卡住时，优先检查 `sandbox` 库存和 worker，而不是只盯 `ctl`
- 命令执行相关问题优先区分：
  - TAT 链路问题
  - envd / Process API 问题
  - clientproxy / ingressproxy 路由问题

## 7. 相关文档

- [sandbox-command-execution.md](sandbox-command-execution.md)
- [sandbox-runtime-agent.md](sandbox-runtime-agent.md)
- [sandbox-template.md](sandbox-template.md)
