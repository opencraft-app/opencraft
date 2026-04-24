# Sandbox 命令执行方式

本文档只保留当前仍然有效的两条命令执行链路，以及各自的适用场景。不要把固定环境地址写死在调用脚本里。

推荐先约定一个基地址：

```bash
export SANDBOX_API_BASE=http://127.0.0.1:18081
```

如需本地联调，可先：

```bash
kubectl --kubeconfig .secret/cls-8gnhos9p-config \
  port-forward -n sandbox svc/sandbox-api 18081:80
```

## 1. TAT 命令执行 API

这是当前最稳的命令执行入口，适合运维式命令、一次性脚本和异步排障。

执行命令：

```bash
curl -sS -X POST "${SANDBOX_API_BASE}/sandboxes/<sandboxID>/tat/commands" \
  -H 'Content-Type: application/json' \
  -d '{"bash":"hostname"}'
```

查询结果：

```bash
curl -sS "${SANDBOX_API_BASE}/sandboxes/<sandboxID>/tat/commands/<invocationID>"
```

特点：

- 异步执行，返回 `invocationID`
- 适合排障和批量运维
- 不依赖实例内 `envd` 的交互通道
- 如果某次联调里 TAT 返回 `401`，不代表实例内 runtime 一定不可用；`ingressproxy-router -> envd process` 仍可能是好的，别把两个执行面混成一个锅

## 2. envd Process API

这条链路用于实例内 runtime 执行面，主要适合调试 `envd` / `process.Process` / `clientproxy`。

当前仓库里最直接的入口是：

```bash
go run ./sandbox/cmd/sandboxcli \
  -api-base-url "${SANDBOX_API_BASE}" \
  -process-base-url "${SANDBOX_API_BASE}" \
  -template-id "pool-c3" \
  -envd-port 49983 \
  -user "root" \
  -cmd "ls -la"
```

说明：

- `sandboxcli` 会创建 sandbox，再通过 `process.Process/Start` 发起命令
- 当前测试环境优先使用 `pool-c3` 或其他主力池，不要再默认写成 `pool-bj8`
- 这条链路更适合验证 runtime 交互能力
- 如果只是想执行一次命令，不优先走这条链路

## 3. 选择建议

优先级建议：

1. 一次性远程执行、运维排障：用 TAT API
2. 验证 runtime 执行面、envd、流式输出：用 `sandboxcli` / Process API

## 4. 相关文档

- [sandbox-runtime-agent.md](sandbox-runtime-agent.md)
- [sandbox-integration.md](sandbox-integration.md)
