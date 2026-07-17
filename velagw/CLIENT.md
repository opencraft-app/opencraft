# velagw 命令行客户端

`velagw` 用来从甲方视角调用 LLMGateway。它主要模拟 trade/ctl 的业务调用，
同时也能执行运营管理操作和真实模型请求。

它不会读取环境变量，不创建 profile，也不把 URL、token 或 Key 写到磁盘。
每次调用都通过参数明确指定本次使用的地址和凭证。

## 构建

在 `llmgateway` 目录执行：

```bash
go build -o ./bin/velagw ./cmd/velagw
./bin/velagw --help
```

## 认证边界

CLI 按调用方身份分成三条命令路径：

| 命令 | 身份 | 凭证参数 | 用途 |
|---|---|---|---|
| `ctl` | trade/ctl 内部系统 | `--internal-token` | 用户、归属、订阅、积分、BYOK |
| `admin` | 运营管理员 | `--admin-token` | 查看租户、签发模型 Key |
| `traffic` | 普通 Agent | `--api-key` | 查询模型、发送聊天请求 |

三种凭证不会互相替代。管理 token 不能调用模型，普通 `sk-...` 也不能调用管理接口。

## 连通性检查

```bash
./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --traffic-url https://llmgw-inner.lightvela.com \
  doctor
```

## trade/ctl 常用流程

确保用户存在：

```bash
./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --internal-token '<internal-token>' \
  ctl tenant ensure \
  --user-id customer-1001 \
  --nickname '测试客户'
```

应用一笔订阅订单。`idempotency-key` 应使用 trade 的稳定订单标识：

```bash
./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --internal-token '<internal-token>' \
  ctl subscription apply \
  --user-id customer-1001 \
  --plan-id plan-pro \
  --idempotency-key trade:deal-20260715-1001
```

查询积分：

```bash
./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --internal-token '<internal-token>' \
  ctl credit get --user-id customer-1001
```

## BYOK

每个 `--provider` 是一个渠道对象，可以重复传入。这样既能表达多个私有渠道，
也不会要求 CLI 理解每一种上游协议的全部字段。`enabled` 省略时默认为 `true`；
需要暂时停用某个私有渠道时才显式传 `false`。

```bash
./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --internal-token '<internal-token>' \
  ctl byok set \
  --user-id customer-1001 \
  --mode byok_first \
  --provider '{"id":"primary","name":"主渠道","protocol":"openai","base_url":"https://example.com/v1","api_key":"sk-private","model_mappings":{"auto":"provider-model"},"enabled":true}'

./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --internal-token '<internal-token>' \
  ctl byok sync --user-id customer-1001
```

`set` 只保存用户意图，`sync` 提交异步下发任务。两条命令分开，便于甲方明确观察异步状态机。

## 签发 Key 和模型调用

```bash
./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --admin-token '<admin-token>' \
  admin key create --user-id customer-1001 --name agent-default
```

```bash
./bin/velagw \
  --traffic-url https://llmgw-inner.lightvela.com \
  --api-key 'sk-...' \
  traffic chat --model auto --prompt '你好'
```

## 组合场景

`scenario` 按真实业务顺序组合 typed client，不会在内部再次执行 Cobra 子命令。
以下命令会依次创建用户、应用订阅并签发 Key：

```bash
./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --internal-token '<internal-token>' \
  --admin-token '<admin-token>' \
  scenario onboard \
  --user-id customer-1001 \
  --plan-id plan-pro \
  --idempotency-key trade:deal-20260715-1001
```

完整场景 `scenario full` 还会保存并同步 BYOK，然后使用刚签发的 Key 查询模型并聊天。
它需要同时提供 `--control-url`、`--traffic-url`、`--internal-token` 和 `--admin-token`。

## 自动化输出

使用 `-o json` 获取稳定 JSON；使用 `--dry-run` 只检查参数并展示调用计划；
使用 `--verbose` 在标准错误中显示脱敏后的请求方法、路径、状态码和耗时。

```bash
./bin/velagw \
  --control-url https://llmgw-control.lightvela.com \
  --internal-token '<internal-token>' \
  -o json --dry-run \
  ctl subscription cancel --user-id customer-1001
```
