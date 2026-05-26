# ACP Cloud Endpoint

本文档记录当前云上 `gateway` 暴露的 ACP 接入方式。

## 当前地址

当前北京 EKS CI 公网地址：

```text
cloudagent.lightvela.com
```

ACP raw WebSocket endpoint：

```text
ws://cloudagent.lightvela.com/acp
```

HTTP base URL：

```text
http://cloudagent.lightvela.com
```

注意：`18094` 是本地开发端口；云上部署监听 `8080`。

## MyChat 接入

本地 MyChat 前端监听在：

```text
http://127.0.0.1:5173/
```

默认会连接当前云上 ACP：

```text
http://127.0.0.1:5173/
```

本地或其他 gateway 调试时，也可以显式覆盖：

```text
http://127.0.0.1:5173/?acp_url=http://127.0.0.1:18094/acp
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
ws://cloudagent.lightvela.com/acp
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

响应里会返回标准 ACP `sessionId`。后续 prompt 都使用这个 `sessionId`。CloudAgent 自有状态统一放在 `_meta.cloudagent`；不要从标准方法响应顶层读取 `readOnly`、`readOnlyReason` 或 `session_proxy_id`。

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
        "agent_version": "builtin.v1",
        "workspace_version": "builtin.v1"
      }
    }
  }
}
```

不传 `sandbox_backend` 时使用服务端默认配置。`agent_version` 控制外层 Agent runtime host 的灰度版本，版本内部决定外层模板、初始化脚本插件，以及服务端 allowlist 里的 signed sidecar artifact；`workspace_version` 控制 inner workspace runtime 的灰度版本，版本内部决定内层模板和行为配置。当前可用 backend 取决于服务端环境变量；例如 `talos` 需要后端配置 `GATEWAY_TALOS_API_KEY` 和对应 template。

客户端也可以直接传 signed sidecar artifact URL：

```json
{
  "sidecar_url": "https://bucket.cos.ap-shanghai.myqcloud.com/agent-sidecar/cloudagent-sidecar-linux-amd64-custom"
}
```

服务端默认把签名 URL 拼成 `${sidecar_url}.sig`，`signing_key_id` 缺省为 `cloudagent-agent-release-v1`。外层 sandbox 通过预置的 Rust `cloudagent-agent-loader` 先验 Ed25519 detached `.sig`，再用 `.sig` envelope 里的 SHA256 校验 ELF bytes，最后才 `execve` sidecar。

`session/new` 响应示例：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "session_xxx",
    "configOptions": [],
    "_meta": {
      "cloudagent": {
        "state": "ready",
        "read_only": false,
        "read_only_reason": "",
        "session_proxy_id": "proxy_xxx"
      }
    }
  }
}
```

### _cloudagent.session.status

CloudAgent 私有扩展方法，用于查看 session 绑定的 runtime/sandbox 状态。
扩展方法名使用点分隔，扩展输入和输出字段使用 `snake_case`，不支持 camelCase alias。

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

### _cloudagent.runtime.ensure_ready

CloudAgent 私有扩展方法，用于在 `session/load` 回放 transcript 后恢复 workspace/runtime host。该方法不回放消息，只确保 session 绑定的 runtime host 可继续执行 prompt、文件和工具能力。

```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "_cloudagent.runtime.ensure_ready",
  "params": {
    "session_id": "session_xxx",
    "cwd": "/workspace"
  }
}
```

返回包含 `_cloudagent.session.status` 同款 runtime 状态字段，并额外包含 `restore_source: "runtime_ensure_ready"` 和 `runtime_ensure_ready` 对象。

### session/load / session/resume / session/list

`session/load` 只回放 transcript，不启动 runtime；回放完成通过 `_cloudagent.session.replay_done` notification 显式通知。`session/resume` 或 `_cloudagent.runtime.ensure_ready` 才负责恢复 runtime host。

`session/load` 和 `session/resume` 响应不在顶层返回 `sessionId`，只返回标准配置字段和 `_meta.cloudagent`：

```json
{
  "jsonrpc": "2.0",
  "id": 22,
  "result": {
    "configOptions": [],
    "_meta": {
      "cloudagent": {
        "state": "ready",
        "read_only": false,
        "read_only_reason": "",
        "session_proxy_id": "proxy_xxx"
      }
    }
  }
}
```

`session/list` 的每个 session 行顶层只放标准列表字段，CloudAgent 状态仍放 `_meta.cloudagent`。

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
GET ws://cloudagent.lightvela.com/acp
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
curl -sS -X POST http://cloudagent.lightvela.com/v1/files \
  -H 'Authorization: Bearer smoke-key' \
  -F purpose=assistants \
  -F file=@./README.md
```

或者：

```bash
curl -sS -X POST http://cloudagent.lightvela.com/v1/files \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -F purpose=assistants \
  -F file=@./README.md
```

前端不应该写入腾讯云密钥、TokenHub key、AGS key。云密钥只应存在于云上 wrapper 容器环境变量或受控后端服务中。

## 健康检查

验证 ACP endpoint 可达：

```bash
curl -i -X OPTIONS http://cloudagent.lightvela.com/acp
```

预期：

```text
HTTP/1.1 204 No Content
```

验证 OpenAI-compatible HTTP API：

```bash
curl -sS \
  -H 'Authorization: Bearer smoke-key' \
  http://cloudagent.lightvela.com/v1/models
```

预期返回 `agent-sidecar-chat`、`agent-sidecar-tool` 等模型。

运行 CloudAgent 自检：

```bash
curl -sS \
  -H 'Authorization: Bearer smoke-key' \
  http://cloudagent.lightvela.com/v1/selfcheck
```

`/v1/selfcheck` 需要身份信息，返回当前 worker、AGS、agent sidecar artifact、detached signature、Wisp package、SMH 配置的非敏感摘要和逐项检查结果。全部通过时返回 HTTP 200；存在缺失配置或 artifact 不可达时返回 HTTP 503，响应体里的 `checks[]` 会标出失败项。

最小 chat completion：

```bash
curl -sS -X POST http://cloudagent.lightvela.com/v1/chat/completions \
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
