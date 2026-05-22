# ACP Backend Integration

本文档说明 `gateway` 的 ACP 后端怎么接入、启动、验证和排障。这里的 ACP 后端指本地 Go wrapper 暴露的 WebSocket JSON-RPC 服务；它内部会按会话拉起外层腾讯云 AGS sandbox，并在外层常驻 CloudAgent sidecar daemon。

## 架构

当前链路是：

```text
ACP client
  -> gateway Go server
  -> outer AGS sandbox
  -> CloudAgent Rust sidecar daemon
  -> TokenHub Chat Completions
  -> inner AGS sandbox, only when Hermes tools are used
```

关键语义：

- `session/new` 会立即创建 outer AGS sandbox，并在 outer 里后台启动一个常驻 CloudAgent sidecar daemon。
- 纯聊天只走 outer daemon + TokenHub，不创建 inner sandbox。
- 当模型决定使用 `terminal`、`file_read`、`file_list`、`file_search` 等 Hermes 工具时，Hermes 会在同一个 outer daemon 里创建会话级 inner AGS sandbox。
- inner sandbox id 会由 sidecar 回传给 wrapper，wrapper 记录在 ACP runtime 上，便于 close/delete/cancel 清理。
- `session/close` 当前会释放云端 sandbox；之后同一个 session 必须 `session/resume` 才能继续。
- `session/delete` 会删除 wrapper 内存会话并尝试释放 inner/outer sandbox；已 `STOPPED` 或已不存在的 sandbox 会按幂等清理成功处理。

## 服务地址

默认启动地址：

```text
127.0.0.1:18094
```

ACP 入口：

- `ws://127.0.0.1:18094/acp`
  Raw JSON-RPC 2.0 over WebSocket。
- `ws://127.0.0.1:18094/ws`
  MyChat app envelope 兼容入口。普通 ACP 客户端优先用 `/acp`。

同一进程还保留 OpenAI 兼容 HTTP surface：

- `POST /v1/responses`
- `GET /v1/responses/:id`
- `POST /v1/files`
- `GET /v1/files/:id/content`
- `GET /v1/models`

## 启动

从 `gateway` 目录启动：

```bash
cd /Users/skipzhang/cloudagent/gateway
make server
./scripts/start_agent_sidecar_server.sh
```

脚本会自动：

- 从仓库 `.env` 加载配置。
- 读取或发布 CloudAgent sidecar 到 COS。
- 把 sidecar URL 和 SHA256 注入 wrapper。
- 启动 `dist/gateway-server`。

常用本地覆盖：

```bash
GATEWAY_ADDR=127.0.0.1:18094 \
GATEWAY_DATA_DIR=/tmp/gateway-agent-data \
./scripts/start_agent_sidecar_server.sh
```

重新发布 sidecar 后必须重启 wrapper。wrapper 只在启动时读取 `GATEWAY_AGENT_SIDECAR_URL` 和 `GATEWAY_AGENT_SIDECAR_SHA256`。
指定 `agent_version` 时，客户端仍然只能传版本号；实际 sidecar COS URL/SHA 由服务端 allowlist registry 解析，不能由客户端直接传 URL。

## 必需配置

最小 `.env`：

```bash
export E2B_API_KEY='...'
export E2B_DOMAIN='ap-beijing.tencentags.com'
export TOKENHUB_API_KEY='...'
export TOKENHUB_MODEL='minimax-m2.7'
export GATEWAY_AGS_TEMPLATE='sdt-...'
export INNER_SANDBOX_TEMPLATE="$GATEWAY_AGS_TEMPLATE"
export COSCMD_CONFIG='/tmp/cos-agent-sidecar.conf'
export COSCMD_BIN='/tmp/coscmd-venv/bin/coscmd'
```

可选的 Agent 版本 registry：

```bash
export GATEWAY_AGENT_VERSION_REGISTRY_JSON='{
  "builtin.v1-54ecc6642308": {
    "sidecar_url": "https://cloudagent-sidecar-shanghai-1388575217.cos.ap-shanghai.myqcloud.com/agent-sidecar/20260522/cloudagent-sidecar-linux-amd64-54ecc6642308",
    "signing_key_id": "cloudagent-agent-release-v1"
  }
}'
```

`builtin.v1` 保持兼容：继续使用全局 `GATEWAY_AGENT_SIDECAR_URL` / `GATEWAY_AGENT_SIDECAR_SHA256`，或者本地上传 binary。
registry 里的版本是服务端 allowlist；如果配置了 `sidecar_url`，`sidecar_sig_url` 可省略并默认拼成 `${sidecar_url}.sig`，`signing_key_id` 可省略并默认使用 `cloudagent-agent-release-v1`。`sidecar_sha256` 也可省略，loader 会从验签通过的 detached `.sig` envelope 里读取 sha256，再校验 ELF bytes。签名版本不会走 `curl && chmod +x && exec`，而是调用预置在外层 sandbox template 里的 Rust loader：

```bash
/usr/local/bin/cloudagent-agent-loader \
  --url "$sidecar_url" \
  --output /tmp/gateway/sessions/session_xxx/hermes-sidecar \
  --sig-url "$sidecar_sig_url" \
  --key-id "$signing_key_id" \
  -- daemon --addr 127.0.0.1:38000 --session-id session_xxx
```

loader 默认从 `/etc/cloudagent/agent-loader-keys.json` 读取可信 Ed25519 公钥，也可用 `GATEWAY_AGENT_LOADER_PATH` 覆盖 loader 路径。公钥文件必须由 sandbox template 预置，不能从 COS 动态下载：

```json
{
  "keys": {
    "cloudagent-agent-release-v1": "base64-ed25519-public-key"
  }
}
```

客户端也可以在创建 session 时直接传 signed artifact URL；服务端会按同样规则拼 `.sig` 并走 loader 验签：

```json
{
  "cwd": "/workspace",
  "_meta": {
    "cloudagent": {
      "sidecar_url": "https://bucket.cos.ap-shanghai.myqcloud.com/agent-sidecar/cloudagent-sidecar-linux-amd64-custom"
    }
  }
}
```

发布签名版本：

```bash
make init-cloudagent-signing-key
make signupload-cloudagent-sidecar
```

`init-cloudagent-signing-key` 会把私钥 seed 写入被 git ignore 的 `.env`，并只输出公钥形式的 `trusted_keys_json`。公钥可以进入 sandbox template 的 `/etc/cloudagent/agent-loader-keys.json`；私钥 seed 只留在本地发布环境，不进入仓库、COS、gateway registry 或 sandbox。

`signupload-cloudagent-sidecar` 会执行 `build -> sign detached .sig -> upload binary + .sig -> print registry JSON`。签名私钥从 `.env` 中的 `CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64` 或 `CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_FILE` 读取。脚本 stderr 也会输出对应的 `trusted_keys_json`，用于写入 sandbox template 的 `/etc/cloudagent/agent-loader-keys.json`。

常用可选项：

```bash
export GATEWAY_ADDR='127.0.0.1:18094'
export GATEWAY_DATA_DIR='/tmp/gateway-agent-data'
export GATEWAY_API_KEY='local-dev-key'
export GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS=300
export GATEWAY_AGENT_SIDECAR_URL_FILE=/tmp/agent-sidecar-url.clean
export GATEWAY_AGENT_SIDECAR_SHA256_FILE=/tmp/agent-sidecar-sha256.clean
```

当前 wrapper 会把自己的当前时间注入 sidecar：

- `HERMES_CURRENT_TIME_NOTE`
- `HERMES_CURRENT_UNIX_SECONDS`

这用于让 `今天/现在/星期几` 这类相对时间问题按 wrapper 运行时的北京时间回答，而不是依赖 sandbox 内可能漂移的系统时间或模型猜测。

## 认证和作用域

WebSocket 可带：

```text
Authorization: Bearer <token>
```

本地开发时，如果没有真实 tenant/project，wrapper 会走 mock scope。HTTP Responses API 也支持：

```text
X-Tenant-ID: tenant-live
X-Project-ID: project-live
```

ACP 当前主要是会话型协议，租户/项目治理还不是最终形态。文件权限、生命周期和下载产物由 wrapper 自己控制，不依赖 OpenAI file id 的真实后端语义。

## JSON-RPC 方法

所有 `/acp` 消息都是 JSON-RPC 2.0。

### initialize

请求：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

返回包含能力声明：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": {
        "embeddedContext": false,
        "image": false
      },
      "sessionCapabilities": {
        "list": {},
        "resume": {},
        "close": {},
        "delete": {}
      }
    }
  }
}
```

### session/new

创建 ACP session，并立即创建 outer AGS + 启动 sidecar daemon。

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/",
    "mcpServers": []
  }
}
```

可通过 CloudAgent 私有 `_meta.cloudagent` 为单个会话选择 Agent runtime host 和
Workspace runtime：

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

`agent_version` 控制外层 Agent runtime host 的灰度版本，版本内部决定外层模板、初始化脚本插件，以及可选的 sidecar COS artifact。
`workspace_version` 控制 inner workspace runtime 的灰度版本，版本内部决定内层模板和行为配置。

返回：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "session_xxx",
    "configOptions": [
      {
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": "agent-sidecar-chat",
        "options": []
      }
    ]
  }
}
```

### _cloudagent.session.status

CloudAgent 私有扩展方法，用于会话运行时自省。扩展方法名使用点分隔，
扩展字段使用 `snake_case`，不混用 ACP 标准字段里的 camelCase。

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

返回只包含运维状态，不返回 envd access token、traffic token、API key 或签名 URL。

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "result": {
    "session_id": "session_xxx",
    "state": "ready",
    "closed": false,
    "read_only": false,
    "read_only_reason": "",
    "cwd": "/workspace",
    "model": "agent-sidecar-chat",
    "current_response_id": "",
    "prompt_in_flight": false,
    "runtime_generation": 1,
    "cleanup_pending": false,
    "last_runtime_error": "",
    "sandbox": {
      "backend": "ags",
      "runtime_id": "rt_session_xxx_1",
      "outer_sandbox_id": "outer_xxx",
      "outer_sandbox_domain": "ap-beijing.tencentags.com",
      "inner_sandbox_id": "",
      "daemon_addr": "http://127.0.0.1:38xxx",
      "remote_binary": "/tmp/gateway/sessions/session_xxx/hermes-sidecar",
      "has_outer_envd_access_token": true,
      "has_outer_traffic_token": false
    }
  }
}
```

### session/prompt

发送用户 prompt。响应正文只表示本轮结束；内容通过 `session/update` 通知流式返回。

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "session_xxx",
    "prompt": [
      {"type": "text", "text": "今天星期几？"}
    ]
  }
}
```

流式通知示例：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "session_xxx",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": {
        "type": "text",
        "text": "今天是 **星期一**"
      }
    }
  }
}
```

完成响应：

```json
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

### session/cancel

取消当前 prompt。wrapper 会尝试通知 outer daemon 取消当前 job，并释放当前运行态。

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/cancel",
  "params": {"sessionId": "session_xxx"}
}
```

### session/close

关闭会话运行态。当前实现会释放 sandbox；历史仍保留在 wrapper 内存中。

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/close",
  "params": {"sessionId": "session_xxx"}
}
```

close 后直接 `session/prompt` 会失败，必须先 `session/resume`。

### session/resume

恢复已 close/cancel 或运行态丢失的 session。wrapper 会重新创建 outer sandbox、启动 sidecar daemon，并把历史 bootstrap 进去。

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "session/resume",
  "params": {
    "sessionId": "session_xxx",
    "cwd": "/"
  }
}
```

### session/load

加载已有 session，并回放历史到客户端。用于 UI 切换会话时恢复展示。

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session/load",
  "params": {"sessionId": "session_xxx"}
}
```

### session/list

列出当前 wrapper 内存中的 ACP session。

```json
{"jsonrpc":"2.0","id":8,"method":"session/list","params":{"cwd":"/"}}
```

### session/delete

删除 wrapper 内存会话，并尝试释放 inner/outer sandbox。

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "session/delete",
  "params": {"sessionId": "session_xxx"}
}
```

返回：

```json
{"jsonrpc":"2.0","id":9,"result":{}}
```

## 最小 Node 客户端

Node 22+ 已内置 `WebSocket`：

```js
const ws = new WebSocket("ws://127.0.0.1:18094/acp");
let next = 1;
const pending = new Map();

function rpc(method, params = {}) {
  const id = next++;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "session/update") {
    const update = msg.params?.update ?? {};
    const text = update.content?.text ?? update.delta ?? "";
    if (text) process.stdout.write(text);
  }
};

ws.onopen = async () => {
  await rpc("initialize", {});
  const created = await rpc("session/new", { cwd: "/", mcpServers: [] });
  const sessionId = created.result.sessionId;

  await rpc("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "今天星期几？" }],
  });

  await rpc("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "你的 Linux 环境是啥？" }],
  });

  await rpc("session/delete", { sessionId });
  ws.close();
};
```

## MyChat 接入

MyChat 可以直接打开：

```text
http://127.0.0.1:5173/
```

默认会连接 `http://cloudagent.lightvela.com`。本地 gateway 调试时再用 `?acp_url=...` 覆盖。

接入检查：

- 页面顶部应显示 `connected`。
- 如果显示 `disconnected · session_xxx`，先刷新页面，让前端重新握手并重新 `session/list`。
- 发送纯聊天问题时不应创建 inner sandbox。
- 发送“看根目录/进程/文件”这类需要工具的问题时，日志里应出现 inner sandbox id。

## 端到端验证

推荐先跑单测：

```bash
cd /Users/skipzhang/cloudagent/gateway
go test ./...

cd /Users/skipzhang/cloudagent/research/hermes-rs
cargo test -p hermes-core -p hermes-sidecar
```

再跑 ACP 生命周期脚本：

```bash
cd /Users/skipzhang/cloudagent/gateway
./scripts/e2e_acp_session_runtime.sh
```

这个脚本会验证：

- `session/new` 创建 outer runtime。
- `session/prompt` 可流式返回。
- `session/cancel` 可以取消正在执行的 prompt。
- `session/resume` 会重新创建 outer runtime。
- 工具问题至少创建一次 inner sandbox。
- `session/close` 后不能直接 prompt。
- `session/delete` 会删除 session。

如果只想保留服务方便手动验证：

```bash
KEEP_SERVER=1 ./scripts/e2e_acp_session_runtime.sh
```

## 关键日志

wrapper 和 sidecar 都向 stderr 打 timeline。常用事件：

- `acp_runtime_outer_create_start` / `acp_runtime_outer_create_done`
  外层 AGS 创建开始/完成。
- `acp_runtime_daemon_done`
  outer 里的 CloudAgent sidecar daemon 已启动并通过 health check。
- `acp_runtime_prompt_start` / `acp_runtime_prompt_done`
  一轮 ACP prompt 开始/完成。
- `inner_sandbox_id=...`
  本轮最终记录到的 inner sandbox id。空值表示本轮没有使用工具。
- `inner_create_start` / `inner_ready`
  Hermes 创建 inner AGS。
- `tool_exec_start` / `tool_exec_done`
  Hermes 工具调用开始/结束。
- `acp_runtime_close_start` / `acp_runtime_close_done`
  close 释放运行态。
- `acp_runtime_cancel_start` / `acp_runtime_cancel_done`
  cancel 释放运行态并结束当前 prompt。
- `acp_runtime_recover_start` / `acp_runtime_recover_done`
  prompt 时发现 outer runtime 404，wrapper 自动重建 runtime 并重试。

判断是否真的用了双沙箱，看三件事即可：

1. `acp_runtime_outer_create_done` 有 outer sandbox id。
2. 工具问题里 `inner_sandbox_id` 非空。
3. sidecar stderr 有 `inner_ready` 和 `tool_exec_done`。

## 常见错误

### `provider_error: exit status 1`

这是 sidecar client 进程以非零退出码结束。真实原因通常在 wrapper stderr 前后几行。

已知触发过的底层错误：

```text
invalid params, tool call result does not follow tool call (2013)
```

这是 OpenAI tool-call 历史顺序错误。当前已修复：Hermes 会把工具结果写回 conversation，并在 prompt 失败时回滚本轮历史。

### `UnsupportedOperation.SandboxInstance ... STOPPED state`

AGS 对已 `STOPPED` 实例再次 delete/stop 返回 400。对 ACP cleanup 来说这是幂等成功，当前 `DeleteSandbox` 已把这类错误吞掉。

### `ags http 404: The requested resource does not exist`

通常表示旧 outer sandbox 已被云端回收或不存在。`session/prompt` 会触发 runtime recover：重新创建 outer sandbox、启动 daemon、bootstrap 历史并重试当前 prompt。

### 日期回答不对

如果问“今天星期几”答成旧日期，确认 wrapper 是最新二进制并且已重启。当前 wrapper 会把北京时间注入 sidecar，Hermes system prompt 和 datetime/timestamp 工具都会使用这个时间。

### 页面一直 disconnected

先确认 wrapper 还在监听：

```bash
lsof -nP -iTCP:18094 -sTCP:LISTEN
```

然后刷新 MyChat 页面。wrapper 重启后，旧 WebSocket 和旧 session binding 不会自动恢复到新进程。

## 当前限制

- ACP session 当前是 wrapper 内存态，不是跨进程持久化 session store。
- close/delete 已释放云端 sandbox，但没有持久记录云端 handle 到外部数据库。
- tenant/project 仍是本地 mock/兼容语义，不是最终多租户治理面。
- `/ws` 是 MyChat app envelope 兼容入口；新接入方建议直接用 `/acp`。
- 文件上传和 artifact 下载走 wrapper 自己的 file store；可以兼容 file id，但权限和生命周期按 wrapper 规则治理。
