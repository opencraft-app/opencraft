# Sandbox 镜像运行时契约

本文档只保留 `sandbox` 对 `base_image` 的当前运行时要求，不再混入一次性的现场 pool 状态或旧排障结论。

镜像构建与当前推荐工作流见： [docs/agent-guides/sandbox-image-agent-guide.md](agent-guides/sandbox-image-agent-guide.md)

## 1. 合格镜像必须满足什么

当前 `sandbox` 不是“任意 Linux 镜像都能直接工作”的系统。一个可用的 `base_image` 至少需要满足以下契约：

- 镜像内具备 TAT 运行环境
- 镜像内已安装并可启动 `envd`
- 实例内必须提供健康检查端点 `127.0.0.1:49983/health`

当前实现不会在 CVM 创建成功后自动 bootstrap `envd`。因此如果镜像没有预装并启动上述运行时组件，worker 会在健康检查阶段判定实例失败并清理。

## 2. 当前镜像分层边界

- `base` 镜像必须包含：
  - Ubuntu 24.04 运行底座
  - `envd`
  - Node / npm / pnpm
  - Python venv
  - Playwright 与浏览器依赖
- `app` 镜像在 `base` 之上增加：
  - `openclaw`
  - `clawhub`
  - 默认插件
  - gateway 与 OpenClaw 配置

对 `sandbox` 能否把实例推进到 `CLEAN` 来说，最小硬要求仍然是：

- TAT 可用
- `envd` 可启动
- `127.0.0.1:49983/health` 返回成功

## 3. “CVM 创建成功”不等于“镜像可用”

判断镜像是否可用于 `sandbox`，不能只看云侧是否成功买出一台 CVM。

以下情况都可能出现：

- CVM 已创建成功，但 `clientproxy` 访问 `:49983/health` 返回 `connection refused`
- worker 日志持续显示健康检查失败
- 实例始终无法进入 `CLEAN`
- worker 最终自动清理该实例

这意味着问题不在“买机”阶段，而在“镜像没有满足 sandbox 运行时契约”阶段。

## 4. 健康检查链路

```text
ctl / sandbox-api
  -> sandbox worker
  -> 腾讯云 CVM 创建成功
  -> 等待实例私网 IP
  -> sandbox-clientproxy
  -> http://<private-ip>:49983/health
  -> envd / TAT 就绪
  -> 实例进入 CLEAN
```

从镜像视角理解：

```text
CVM 启动
  -> 镜像内 TAT 可用
  -> 镜像内 envd 已启动
  -> 127.0.0.1:49983/health 可访问
  -> clientproxy 健康检查通过
  -> sandbox 判定该实例可分配
```

## 5. 推荐验证方式

验证新镜像时，建议使用隔离 pool，而不是直接复用稳定池。

推荐步骤：

1. 为新镜像准备单独 pool
2. 确认 pool 绑定的 `zone + subnet_id + vpc_id + base_image` 正确
3. 调用 `CreateInstance`
4. 观察 sandbox worker / clientproxy 日志，确认实例是否进入 `CLEAN`

建议验证标准：

- 通过：实例进入 `CLEAN`，后续可正常分配
- 不通过：只看到 CVM 创建成功，但健康检查始终失败

## 6. 排障优先顺序

再次遇到 `CreateInstance` 失败时，建议按以下顺序排查：

1. 先确认 ctl 是否真的请求到了目标 sandbox-api 地址
2. 再确认目标 pool 是否仍有容量，不要先入为主怀疑 ctl
3. 若云侧报买机错误，优先检查 `zone + subnet_id + vpc_id`
4. 若 CVM 已创建但进不了 `CLEAN`，优先检查镜像是否满足 `TAT + envd + 49983 health` 契约
5. 若问题与 OpenClaw/TAT/gateway 相关，优先查 [docs/agent-guides/sandbox-image-agent-guide.md](agent-guides/sandbox-image-agent-guide.md)
