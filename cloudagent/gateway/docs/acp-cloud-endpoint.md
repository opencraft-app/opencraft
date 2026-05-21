# ACP Cloud Endpoint

本文档记录当前云上 `gateway` 暴露的 ACP 接入方式。

## 当前地址

当前北京 EKS CI 公网地址：

```text
101.42.117.125
```

ACP raw WebSocket endpoint：

```text
ws://101.42.117.125:8080/acp
```

HTTP base URL：

```text
http://101.42.117.125:8080
```

注意：`18094` 是本地开发端口；云上部署监听 `8080`。

## MyChat 接入

本地 MyChat 前端监听在：

```text
http://127.0.0.1:5173/
```

连接当前云上 ACP：

```text
http://127.0.0.1:5173/?acp_url=ws%3A%2F%2F101.42.117.125%3A8080%2Facp
```

未编码写法也可以：

```text
http://127.0.0.1:5173/?acp_url=http://101.42.117.125:8080/acp
```

如果换机器访问，`127.0.0.1:5173` 指的是访问者自己的机器。那台机器也需要启动 MyChat 前端，或者改用可被访问的前端地址。

## 协议

传输层：

```text
WebSocket
```

消息格式：

```text
JSON-RPC 2.0
```

连接地址：

```text
ws://101.42.117.125:8080/acp
```

### initialize

客户端连接后先发送：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

服务端会返回 capabilities，包括 session 能力、prompt 能力和模型选项。

### session/new

创建会话：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/workspace"
  }
}
```

响应里会返回 `sessionId`。后续 prompt 都使用这个 `sessionId`。

可通过 CloudAgent 私有 `_meta` 扩展为单个会话指定 sandbox backend：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/workspace",
    "_meta": {
      "cloudagent": {
        "sandbox_backend": "talos",
        "sandbox_template_id": "498c6c11-74d7-426e-bdb1-13d8aa73997e"
      }
    }
  }
}
```

不传 `sandbox_backend` 时使用服务端默认配置。传 `sandbox_template_id` 时，该会话的外层和内层 sandbox 都会使用这个 template；不传时使用服务端 `GATEWAY_TALOS_TEMPLATE`。当前可用 backend 取决于服务端环境变量；例如 `talos` 需要后端配置 `GATEWAY_TALOS_API_KEY` 和对应 template。

### _cloudagent.session.status

CloudAgent 私有扩展方法，用于查看 session 绑定的 runtime/sandbox 状态。
扩展方法名使用点分隔，扩展字段使用 `snake_case`。

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "_cloudagent.session.status",
  "params": {
    "session_id": "session_xxx"
  }
}
```

该接口不会返回 envd token、traffic token、API key 或签名 URL。

### session/prompt

发送文本 prompt：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "SESSION_ID",
    "prompt": [
      {
        "type": "text",
        "text": "你好，请只回复 OK"
      }
    ]
  }
}
```

服务端会以 timeline 事件形式返回用户消息、assistant 正文、reasoning、tool call、tool result 和最终完成状态。

### session/close

关闭会话运行态：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/close",
  "params": {
    "sessionId": "SESSION_ID"
  }
}
```

当前实现里 `close` 会清理对应 session runtime。关闭后不能直接继续 prompt，需要重新创建或恢复可用会话。

### session/delete

删除会话：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/delete",
  "params": {
    "sessionId": "SESSION_ID"
  }
}
```

`delete` 是幂等操作，用于删除 wrapper 侧记录和会话状态。

## 身份与安全

当前 `/acp` 调试入口允许在没有 `Authorization` header 时使用后端默认 tenant/project：

```text
GATEWAY_DEFAULT_TENANT_ID
GATEWAY_DEFAULT_PROJECT_ID
```

这方便浏览器静态页面直连调试，但不适合作为长期公网开放形态。

### Header 约定

ACP WebSocket 调试直连可以不传 header：

```text
GET ws://101.42.117.125:8080/acp
```

服务端会落到默认 scope。当前云上默认值由容器环境变量提供：

```text
tenant-live
project-live
```

如果客户端支持自定义 WebSocket header，推荐显式传入：

```text
Authorization: Bearer smoke-key
```

或者：

```text
X-Tenant-ID: tenant-live
X-Project-ID: project-live
```

`Authorization: Bearer smoke-key` 这里不是腾讯云密钥，也不是 TokenHub key。当前 wrapper 没有配置 `GATEWAY_API_KEY` / `CLOUDAGENT_API_KEY` 时，Bearer token 只用于触发默认 tenant/project 解析；如果未来配置了 API key，token 必须匹配服务端配置。

HTTP API，例如 `/v1/models`、`/v1/files`、`/v1/responses`，需要以下任一身份方式：

```text
Authorization: Bearer <token>
```

或：

```text
X-Tenant-ID: <tenant>
X-Project-ID: <project>
```

当前建议：

```text
Authorization: Bearer smoke-key
```

或：

```text
X-Tenant-ID: tenant-live
X-Project-ID: project-live
```

文件上传同样走 HTTP API，因此至少需要上述一组 header：

```bash
curl -sS -X POST http://101.42.117.125:8080/v1/files \
  -H 'Authorization: Bearer smoke-key' \
  -F purpose=assistants \
  -F file=@./README.md
```

或者：

```bash
curl -sS -X POST http://101.42.117.125:8080/v1/files \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -F purpose=assistants \
  -F file=@./README.md
```

前端不应该写入腾讯云密钥、TokenHub key、AGS key。云密钥只应存在于云上 wrapper 容器环境变量或受控后端服务中。

## 健康检查

验证 ACP endpoint 可达：

```bash
curl -i -X OPTIONS http://101.42.117.125:8080/acp
```

预期：

```text
HTTP/1.1 204 No Content
```

验证 OpenAI-compatible HTTP API：

```bash
curl -sS \
  -H 'Authorization: Bearer smoke-key' \
  http://101.42.117.125:8080/v1/models
```

预期返回 `agent-sidecar-chat`、`agent-sidecar-tool` 等模型。

最小 chat completion：

```bash
curl -sS -X POST http://101.42.117.125:8080/v1/chat/completions \
  -H 'Authorization: Bearer smoke-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "agent-sidecar-chat",
    "messages": [
      {"role": "user", "content": "请只回复 OK"}
    ],
    "stream": false
  }'
```

预期 assistant 内容为：

```text
OK
```
