# Sandbox Template / Pool 指南

本文档面向 `ctl` 开发者，说明 `ctl` 里的 template 配置如何映射到 `sandbox` 的 pool，以及当前推荐的联调方式。

权威运行入口：

- `ctl` 本地联调： [docs/agent-guides/ctl-local-run-guide.md](../agent-guides/ctl-local-run-guide.md)
- `sandbox` 开发/运维入口： [docs/agent-guides/sandbox-agent-guide.md](../agent-guides/sandbox-agent-guide.md)
- `sandbox` 测试环境发布： [docs/deploy-guides/sandbox-deploy-guide.md](../deploy-guides/sandbox-deploy-guide.md)

## 1. 核心映射

- `ctl` 的 `[api.instance].default_template_id` 和 `candidate_template_ids` 直接对应 `sandbox` 的 `pool.id`
- `ctl` 创建实例时不会让调用方指定 pool，而是在这组配置候选池里自行负载均衡选池
- `ctl` 的 `[adapter.sandbox].baseUrl` 指向 `sandbox-api`
- `sandbox` 中的 pool 不是抽象标签，而是一组固定的云侧参数组合：
  - `base_image`
  - `zone`
  - `vpc_id`
  - `subnet_id`
  - `security_groups`

因此：

- template 是否可用，本质上取决于对应 pool 当前是否还能正常补货和重装
- 不要把某个 pool 的可用性写死在文档里
- 候选 template 列表应来自当前运行配置和现网状态，不来自历史笔记

## 2. 推荐联调方式

本地不要依赖固定公网或内网地址，统一用 `port-forward`：

```bash
kubectl --kubeconfig .secret/cls-8gnhos9p-config \
  port-forward -n sandbox svc/sandbox-api 18081:80
```

`ctl` 配置示例：

```toml
[adapter.sandbox]
baseUrl = "http://127.0.0.1:18081"
apiKey = ""
timeout = 30
```

## 3. 如何查看当前可用 pool

不要依赖文档里的静态 pool 列表，直接查现网：

```bash
curl -sS http://127.0.0.1:18081/pools | jq '.[] | {id,name,base_image,zone,status}'
```

如果任务涉及测试环境镜像 rollout，直接查数据库中的当前 pool 状态：

```bash
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  bash .codebuddy/skills/sandbox-ops/scripts/query_pool_status.sh 'pool-%'
```

## 4. 对 `ctl` 的启发

- 优先维护 `candidate_template_ids`，不要只押一个 `default_template_id`
- `ctl` worker 会优先读取已有的 pool pressure snapshot，对候选池按压力排序后再尝试创建；拿不到快照时才退化为配置顺序
- `[api.instance].create_pool_max_attempts` 用来限制单次创建最多切换多少个候选池；`<=0` 时按候选池数量兜底
- 负载均衡范围只看 `default_template_id + candidate_template_ids`，不会去扫 `sandbox` 全量 pool
- pool 可用性会随镜像、可用区、库存、云侧资源约束变化
- 如果 `CreateInstance` 卡住，不要先假设是 `ctl` 逻辑问题；先检查：
  - `sandbox-api /health`
  - 当前 pool 状态查询脚本输出
  - 目标 pool 是否有 `CLEAN` 库存
  - `sandbox-worker-sharded` 是否正常
  - 镜像对应实例里的 `envd`/健康检查链路是否正常

## 5. 排障入口

- `ctl` 创建实例链路： [docs/agent-guides/ctl-create-instance-followup-guide.md](../agent-guides/ctl-create-instance-followup-guide.md)
- `sandbox` 运行时执行链路： [sandbox-runtime-agent.md](sandbox-runtime-agent.md)
- `sandbox` 集成背景： [sandbox-integration.md](sandbox-integration.md)
