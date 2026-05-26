# Gateway Agent Sandbox

这个目录里是一个本地 OpenAI Responses API 兼容 wrapper。它把请求转成：

1. 本地 Go HTTP server 接收 `/v1/responses`、`/v1/files`
2. 创建外层腾讯云 AGS sandbox
3. 外层下载并运行 CloudAgent Rust sidecar
4. sidecar 内部直接跑 Hermes，会在首次工具调用时自动创建一个会话级内层 AGS sandbox
5. Hermes 以这个 inner sandbox 作为整个会话的 workspace；长时记忆仍保留在外层运行环境，不会复制 `MEMORY.md` / `USER.md` 到 inner sandbox

当前唯一主路径是 `GATEWAY_WORKER_MODE=agent_injected`，sidecar 固定为 Hermes Rust 二进制。

## CI trigger notes

- 2026-05-21: README-only no-op change to rerun cloudagent-gateway after production reviewer override landed.
- 2026-05-26: README-only no-op change to rerun cloudagent-gateway after Wisp secret projection fix landed.

## ACP WebSocket

完整接入文档见 [docs/acp-backend.md](docs/acp-backend.md)。

除了 OpenAI 兼容的 `/v1/responses` 之外，wrapper 现在也暴露 ACP over WebSocket：

- `/acp`: raw JSON-RPC 2.0 over WebSocket，不带额外 envelope
- `/ws`: MyChat 兼容的 app envelope WebSocket，消息形态和 `/Users/skipzhang/code/mychat/internal/gateway` 一致

当前 ACP adapter 走沙箱内 CloudAgent Runtime 执行链路：

1. 浏览器或客户端连到 wrapper 的 `/ws` 或 `/acp`
2. wrapper 做鉴权、scope、文件和协议投影
3. 一个 ACP `sessionId` 绑定一个沙箱内 runtime session
4. `session/prompt` 调用 runtime `session-input`，由 runtime inbox + pump + run ledger 串行执行
5. 后端继续进入外层 runtime host；工具、文件和 shell 能力由 sidecar/runtime host 执行

第一阶段已实现的 ACP 能力：

- `initialize`
- `session/list`
- `session/new`
- `session/load`
- `session/resume`
- `session/prompt`
- `session/cancel`
- `session/set_config_option`
- `session/update` 流式通知

当前暴露一个可写 `configOptions`：`model`。这已经足够让 MyChat 直接工作。

## 前置条件

本机需要：

- Go
- Docker
- Python 3
- `curl`
- `shasum`
- `coscmd`

云侧需要：

- AGS API key
- TokenHub API key
- 北京 COS bucket，并且 `coscmd` 已配置好上传权限
- 外层/内层 AGS template id

本地已经支持从仓库根目录 `.env` 自动加载配置。`make e2e-agent-sidecar` 和 `scripts/start_agent_sidecar_server.sh` 都会优先读取仓库根目录 `.env`，其次才读当前目录 `.env`。`.env` 已加入 `.gitignore`，不要提交。

## 中国网络加速

默认 `make cloudagent-sidecar-linux` / `make e2e-agent-sidecar` 会带上适合中国网络的构建参数：

- `CN_MIRRORS=1`
- CloudAgent Rust sidecar: `rsproxy.cn` 作为 cargo mirror，`CARGO_HTTP_MULTIPLEXING=false` 降低 HTTP/2 抖动
- Dockerfile 里的 Debian `apt` 源默认改成清华镜像 `mirrors.tuna.tsinghua.edu.cn`

首次拉基础镜像这一步仍然取决于你的 Docker daemon。最稳妥的是给 Docker 自己配 `registry-mirrors`，或者显式覆盖基础镜像：

```bash
CLOUDAGENT_SIDECAR_RUST_BASE_IMAGE='docker.m.daocloud.io/library/rust:1.86-bookworm' \
make cloudagent-sidecar-linux
```

如果你不想用这些国内默认值，可以显式关闭：

```bash
CN_MIRRORS=0 make cloudagent-sidecar-linux
```

## 镜像构建

`build/server/Dockerfile` 需要保持 legacy Docker builder 兼容。当前蓝盾 runner 没有可用 buildx，不要在这个 Dockerfile 里加入 cache mount 等 BuildKit-only 语法，除非先升级 runner 构建能力。

也可以单独覆盖：

```bash
CLOUDAGENT_SIDECAR_CARGO_REGISTRY_MIRROR='https://rsproxy.cn' \
CLOUDAGENT_SIDECAR_DEBIAN_MIRROR='mirrors.aliyun.com' \
make cloudagent-sidecar-linux
```

## Hermes Rust 构建缓存

`make cloudagent-sidecar-linux` 的 Dockerfile 会先只复制 `Cargo.toml` / `Cargo.lock` 和最小 stub 源码，预编译依赖到 BuildKit cache mount；再复制真实源码，只重编 `hermes-core` 和 `hermes-sidecar`。这样改业务源码时不会重新编译 `tokio`、`reqwest`、`serde` 等依赖。

默认 Docker 构建使用更快的 release profile 覆盖：

- `CLOUDAGENT_SIDECAR_CARGO_INCREMENTAL=1`
- `CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_LTO=false`
- `CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`
- `CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_STRIP=true`

如果要回到 workspace `Cargo.toml` 里的最小体积 LTO 构建，可以显式覆盖：

```bash
CLOUDAGENT_SIDECAR_CARGO_INCREMENTAL=0 \
CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_LTO=true \
CLOUDAGENT_SIDECAR_CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
make cloudagent-sidecar-linux
```

## 环境变量

最小配置可以直接写在 `.env`：

```bash
export E2B_API_KEY='...'
export TOKENHUB_API_KEY='...'
export TOKENHUB_MODEL='minimax-m2.7'
export GATEWAY_AGS_TEMPLATE='sdt-...'
export INNER_SANDBOX_TEMPLATE="$GATEWAY_AGS_TEMPLATE"
export E2B_DOMAIN='ap-beijing.tencentags.com'
export COSCMD_CONFIG='/tmp/cos-agent-sidecar.conf'
export COSCMD_BIN='/tmp/coscmd-venv/bin/coscmd'   # 如果 coscmd 不在 PATH
```

可选：

```bash
export COS_OBJECT_PREFIX='/agent-sidecar/20260516'
export TENANT_ID='tenant-live'
export PROJECT_ID='project-live'

# Optional extra sandbox backend. Existing AGS config remains the default.
export GATEWAY_TALOS_API_KEY='talos_...'
export GATEWAY_TALOS_API_URL='https://api.talos.ren'
export GATEWAY_TALOS_DOMAIN='api.talos.ren'
export GATEWAY_TALOS_TEMPLATE='498c6c11-74d7-426e-bdb1-13d8aa73997e'
```

配置 Talos 后，`/v1/models` 会额外暴露 `agent-sidecar-talos*` 模型；只有这些模型会显式路由到 Talos backend。原来的 `agent-sidecar-chat`、`agent-sidecar-tool` 等模型仍走老 AGS backend。

脚本会自动读取 `.env`，不需要手动 `source`。如果你想临时覆盖某个值，直接在命令前设置环境变量即可：

```bash
TOKENHUB_MODEL='minimax-m2.7' make e2e-agent-sidecar
```

## 一键全链路验证

直接跑：

```bash
make e2e-agent-sidecar
```

如果你只想把 sidecar 自动上传到 COS 并拿到公开 URL，可以单独跑：

```bash
make publish-cloudagent-sidecar
```

如果要走 CI 的上海 COS 签名发布路径，使用独立流水线 `.ci/cloudagent-agent-artifact.yml`。
它只构建 Rust Agent artifact，不发布 gateway 服务；流程是：

- Docker 构建 `cloudagent-sidecar-linux-amd64`
- Docker 构建 `cloudagent-agent-sign-linux-amd64`
- 使用 Ed25519 detached `.sig` 签名
- 上传 binary 和 `.sig` 到 `cloudagent-sidecar-shanghai-1388575217 / ap-shanghai`
- 输出 `cloudagent-agent-version-registry.json`

CI 需要配置这些 settings：

- `CLOUDAGENT_AGENT_COS_SECRET_ID`
- `CLOUDAGENT_AGENT_COS_SECRET_KEY`
- `CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64`

本地 dry-run 可以用：

```bash
CLOUDAGENT_SIGNUPLOAD_DRY_RUN=1 \
  CLOUDAGENT_AGENT_COS_SECRET_ID=fake \
  CLOUDAGENT_AGENT_COS_SECRET_KEY=fake \
  CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  make ci-signupload-cloudagent-sidecar-shanghai
```

如果你想让本地服务也走这条自动发布流程，直接跑：

```bash
make start-agent-sidecar-server
```

这个脚本会做完整闭环：

- 构建 Go server 和 CloudAgent Rust sidecar
- 跑 `go test ./...`
- 上传 sidecar 到 COS（`public-read`）
- 生成公开可读 URL
- 启动本地 wrapper
- 跑中文纯聊，校验没有创建内层 sandbox
- 跑 bash 工具对话，校验创建内层 sandbox 并执行命令
- 上传文件，使用 `input_file` 让 Agent 通过 sandbox 工具读取文件
- 下载产物 artifact，确认产物可取回

成功时会输出类似：

```text
[e2e] chat metrics: http_code=200 time_total=...
[e2e] tool metrics: http_code=200 time_total=...
[e2e] file metrics: http_code=200 time_total=...
[e2e] ok
```

当前 `make e2e-agent-sidecar` 已按 CloudAgent sidecar 的真实信号做断言。脚本会校验：

- 纯聊天：最终 `inner_sandbox_id=""`，没有 `kind=tool_call`
- COS 下载：wrapper 日志有 `sidecar_download_start` / `sidecar_download_done`
- 工具调用：有 `kind=tool_call` / `kind=tool_call_update`，最终 `inner_sandbox_id` 非空
- 文件链路：有 `stage_inputs_done count=1`，回答 artifact 可下载且包含上传文件内容

CloudAgent sidecar 现在已经真正支持流式透传：sidecar 会把 Hermes 的 `AgentEvent::Content` 逐段输出成 wrapper 事件，wrapper 再转成 `response.output_text.delta` SSE。也就是说，`stream:true` 不再只是“最后一次性吐完整答案再包装成流”。

## 手动启动服务

如果想自己玩，不跑完整 e2e，可以先构建：

```bash
make cloudagent-sidecar-linux server
```

上传 sidecar 到 COS 并生成公开 URL，最简单的是直接用内置发布流程：

```bash
make publish-cloudagent-sidecar
```

它会自动：

- 从仓库根目录 `.env` 读取 `COSCMD_CONFIG` / `COSCMD_BIN`
- 计算 CloudAgent sidecar sha256
- 上传到 COS
- 调 `putobjectacl --grant-read anyone` 设成 `public-read`
- 把稳定公开 URL 写到 `/tmp/agent-sidecar-url.clean`
- 把 sha256 写到 `/tmp/agent-sidecar-sha256.clean`

如果你想手动执行等价命令，也可以这样：

```bash
SIDECAR_SHA="$(shasum -a 256 dist/cloudagent-sidecar-linux-amd64 | awk '{print $1}')"
SIDECAR_OBJECT="/agent-sidecar/$(date +%Y%m%d)/cloudagent-sidecar-linux-amd64-${SIDECAR_SHA:0:12}"
COS_BUCKET="$(awk -F '=' '/^[[:space:]]*bucket[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$COSCMD_CONFIG")"
COS_REGION="$(awk -F '=' '/^[[:space:]]*region[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$COSCMD_CONFIG")"

"${COSCMD_BIN:-coscmd}" -c "$COSCMD_CONFIG" upload -f -y dist/cloudagent-sidecar-linux-amd64 "$SIDECAR_OBJECT"
"${COSCMD_BIN:-coscmd}" -c "$COSCMD_CONFIG" putobjectacl "$SIDECAR_OBJECT" --grant-read anyone
printf 'https://%s.cos.%s.myqcloud.com%s\n' "$COS_BUCKET" "$COS_REGION" "$SIDECAR_OBJECT" > /tmp/agent-sidecar-url.clean
printf '%s\n' "$SIDECAR_SHA" > /tmp/agent-sidecar-sha256.clean
```

启动 wrapper 前，如果还没构建 server，先跑：

```bash
make server
```

推荐直接用启动脚本，它会自动加载 `.env`。如果没显式提供 `GATEWAY_AGENT_SIDECAR_URL`，脚本会自动执行一次 sidecar 发布，并优先复用 `/tmp/agent-sidecar-url.clean` 里的公开 URL：

```bash
./scripts/start_agent_sidecar_server.sh
```

## 北京 EKS CI 发布

浏览器调试入口不要依赖“删旧实例 + 新建实例”的公网 IP。EKS CI 如果用
`AutoCreateEip:true` 重新创建，每次都会分配新的公网 EIP；`DeletePolicy:Never`
只表示旧 EIP 不被释放，不表示它会自动绑回新实例。

日常发布应该原地更新现有 EKS CI：

```bash
GATEWAY_IMAGE='lightclaw-bj82.tencentcloudcr.com/lightclaw/cloudagent-gateway:...' \
make deploy-eksci-inplace
```

这个目标会：

- 按 `GATEWAY_EKS_CI_NAME` 查找现有 EKS CI，默认
  `cloudagent-gateway`
- 调 `UpdateEKSContainerInstance` 更新镜像和环境变量
- 保持现有 EIP 不变
- 等待容器回到 `Running/running` 后输出 EIP

如果 `.env` 里有运行时用的腾讯云密钥，脚本默认不会用它们做 TKE 发布操作，
而是走本机 `tccli` profile。需要显式指定 profile 时：

```bash
GATEWAY_TCCLI_PROFILE=production make deploy-eksci-inplace
```

如果你想临时覆盖监听地址或数据目录，可以直接在命令前传环境变量：

```bash
GATEWAY_ADDR=127.0.0.1:18095 \
GATEWAY_DATA_DIR=/tmp/gateway-agent-data-2 \
./scripts/start_agent_sidecar_server.sh
```

它要求以下值已经可用：

- `E2B_API_KEY`
- `TOKENHUB_API_KEY`
- `GATEWAY_AGS_TEMPLATE`
- `INNER_SANDBOX_TEMPLATE`
- `COSCMD_CONFIG` 和可用的 `coscmd`，用于自动上传 sidecar
- `GATEWAY_AGENT_SIDECAR_URL` 或 `GATEWAY_AGENT_SIDECAR_URL_FILE`；如果不传，脚本会自动发布并生成
- `GATEWAY_AGENT_SIDECAR_SHA256`，或者本地已有 `dist/cloudagent-sidecar-linux-amd64` 供脚本自动计算

注意：wrapper 进程只会读取启动时注入的 `GATEWAY_AGENT_SIDECAR_URL`。如果你重新发布了 sidecar，正在运行的本地服务不会自动热更新这个 URL，需要重启 wrapper 进程。

如果你仍然想手动启动，等价命令如下：

```bash
GATEWAY_WORKER_MODE=agent_injected \
GATEWAY_ADDR=127.0.0.1:18094 \
GATEWAY_DATA_DIR=/tmp/gateway-agent-data \
E2B_DOMAIN="${E2B_DOMAIN:-ap-beijing.tencentags.com}" \
E2B_API_KEY="$E2B_API_KEY" \
GATEWAY_AGS_TEMPLATE="$GATEWAY_AGS_TEMPLATE" \
INNER_SANDBOX_TEMPLATE="$INNER_SANDBOX_TEMPLATE" \
TOKENHUB_API_KEY="$TOKENHUB_API_KEY" \
TOKENHUB_MODEL="${TOKENHUB_MODEL:-minimax-m2.7}" \
GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS=300 \
GATEWAY_AGENT_SIDECAR_URL="$(cat /tmp/agent-sidecar-url.clean)" \
GATEWAY_AGENT_SIDECAR_SHA256="$SIDECAR_SHA" \
./dist/gateway-server
```

## 手动玩法

如果你只是想手动玩起来，推荐按下面顺序：

1. `make cloudagent-sidecar-linux server`
2. `make publish-cloudagent-sidecar`
3. `./scripts/start_agent_sidecar_server.sh`
4. 另开一个终端，用 `curl` 打 `/v1/responses` / `/v1/files`
5. 盯着 server stderr 里的 timeline，看是否符合预期

最小手动闭环就是这三种玩法：

1. 纯聊天，确认不会起 inner sandbox
2. `terminal` 工具，确认 inner sandbox 被创建并释放
3. 上传文件 + `input_file`，确认文件被 staged 到 workspace，Hermes 用 `file_read` 之类工具读到了内容

如果你想长期挂着本地服务反复玩，建议这样启动：

```bash
GATEWAY_ADDR=127.0.0.1:18094 \
GATEWAY_DATA_DIR=/tmp/gateway-agent-data \
./scripts/start_agent_sidecar_server.sh
```

然后把下面几个命令反复打就行。

## 玩法 1：纯聊天

纯聊天不会启动内层 AGS。日志里应该能看到最终 `inner_sandbox_id=""`，看不到工具调用事件。

```bash
curl -sS -N -X POST http://127.0.0.1:18094/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -d '{"model":"agent-sidecar-chat","stream":true,"input":"你是哪个模型？用一句话回答。"}'
```

预期现象：

- 返回很快
- 日志里有 `inner_sandbox_id=""`
- 没有 `kind=tool_call`
- 仍然会有 outer sandbox 和 sidecar 下载日志，因为当前 agent 是运行在外层 AGS 里的

## 玩法 2：让 Agent 用 bash 工具

Hermes 模式下，明确要求使用 `terminal`、`file_read`、`file_write`、`file_list`、`file_search` 这类工具时，会创建一个会话级内层 AGS sandbox 并把它当成整个会话的 workspace。

```bash
curl -sS -N -X POST http://127.0.0.1:18094/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -d '{"model":"agent-sidecar-tool","stream":true,"input":"请使用 terminal 工具执行：ls -la / && ps aux。然后用简洁中文说明根目录有哪些文件或目录，以及当前有哪些进程。"}'
```

预期日志：

```text
kind=tool_call
kind=tool_call_update
inner_sandbox_id="..."
```

如果你想更直观地确认 workspace，推荐直接用这个：

```bash
curl -sS -N -X POST http://127.0.0.1:18094/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -d '{"model":"agent-sidecar-tool","stream":true,"input":"请使用 terminal 工具执行：pwd && printf '\''你好！'\'' > hello.txt && cat hello.txt。然后用简洁中文说明你做了什么。"}'
```

预期现象：

- 返回里会出现 `你好！`
- `pwd` 会落在 workspace，例如 `/workspace`
- 日志里会出现 `kind=tool_call` / `kind=tool_call_update`，并且最终 `inner_sandbox_id` 非空

## 玩法 3：上传文件再提问

先上传文件：

```bash
printf 'FILE_KIND_AGENT_SANDBOX_NOTE\nhello from uploaded file\n' > /tmp/input-note.txt

curl -sS -X POST http://127.0.0.1:18094/v1/files \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -F purpose=assistants \
  -F 'file=@/tmp/input-note.txt;filename=input-note.txt'
```

拿返回里的 `id`，再请求：

```bash
FILE_ID='file_xxx'

curl -sS -N -X POST http://127.0.0.1:18094/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live' \
  -d "{
    \"model\":\"agent-sidecar-file\",
    \"stream\":true,
    \"input\":[
      {\"type\":\"input_text\",\"text\":\"请读取上传文件，并说明这个文件是什么。\"},
      {\"type\":\"input_file\",\"file_id\":\"${FILE_ID}\"}
    ]
  }"
```

文件输入会强制走 sandbox 工具。日志里应有：

```text
stage_inputs_done count=1
kind=tool_call
inner_sandbox_id="..."
```

预期现象：

- 日志里先有 `file_upload_done`
- 请求阶段有 `stage_inputs_done count=1`
- 一般会看到 `kind=tool_call`
- 回答内容里会复述上传文件的内容

## 下载产物

`response.completed` 事件里会返回 `artifact_file_ids`。下载第一个产物：

```bash
ARTIFACT_FILE_ID='file_xxx'

curl -sS http://127.0.0.1:18094/v1/files/$ARTIFACT_FILE_ID/content \
  -H 'X-Tenant-ID: tenant-live' \
  -H 'X-Project-ID: project-live'
```

预期现象：

- 日志里有 `file_download_done`
- 下载回来的内容就是最终回答文本 artifact

## 看日志判断是否真的用了内层 sandbox

关键日志：

- `inner_sandbox_id=""`：纯聊，没有创建内层 AGS
- `sidecar_download_start`：wrapper 已在外层 sandbox 内准备下载 CloudAgent sidecar
- `source=hermes_sidecar event=process_start`：Rust sidecar 已进入 `main`
- `kind=tool_call`：模型发起工具调用
- `kind=tool_call_update`：工具调用完成并回传结果
- `inner_sandbox_id="..."`：本轮确实创建了内层 AGS workspace
- `file_download_done`：artifact 已从 wrapper 下载出来

如果你只想验证路由是否正确，看这几个事件就够了。

说明：当前 `inner_*` 日志已经桥接到 CloudAgent sidecar timeline，足够稳定地判断“是否走了内层 sandbox 路径”。如果后续你还想把“内层 sandbox 实际创建耗时”拆得更精确，可以继续把 Hermes core 的原始 tracing 字段透传出来。

一个完整手动请求通常会长这样：

```text
response_request_start
outer_create_done
sidecar_download_start
source=hermes_sidecar event=process_start
...
sidecar_result_envelope inner_sandbox_id=""
response_completed
```

如果是工具请求，还会夹着：

```text
kind=tool_call
kind=tool_call_update
sidecar_result_envelope inner_sandbox_id="..."
```

## 性能参考

2026-05-24 北京实测，使用本地 gateway、CloudAgent Rust sidecar、真实 COS 公有 URL、真实 AGS/TokenHub：

- `make e2e-agent-sidecar` 全量通过
- 纯聊：`3.52s`
- terminal 工具：`7.87s`
- 上传文件 + sandbox 工具读取 + artifact 下载：`13.96s`

按当前打点拆开，大致可以看成：

- 纯聊：外层 AGS 创建、COS 下载、daemon health、`session-input` 推理，最后 `sidecar_result_envelope inner_sandbox_id=""`
- terminal 工具：外层 AGS 创建、COS 下载、daemon health、`session-input` 推理，期间有 `kind=tool_call` / `kind=tool_call_update`
- 文件读取：先上传 input file，再 staging 到 outer workspace，随后工具调用读取 `/workspace/inputs/...`

如果只看 Rust sidecar 冷启动本身：

- `source=hermes_sidecar event=process_start` 出现后，sidecar 已进入 daemon/client 主程序
- `sidecar_result_envelope` 是 wrapper 看到的本轮最终运行结果

所以当前主要固定成本已经不在 Rust 进程本身，而在：

- 外层 AGS 创建
- 从 COS 下载约 `6.2MB` 的 CloudAgent sidecar
- 模型推理
- 如需工具，再走一次 inner sandbox 路径

如果你要盯技术指标，最值得看的就是这几段：

- `outer_create_start -> outer_create_done`：外层 AGS 创建耗时
- `sidecar_download_start -> sidecar_download_done`：从 COS 下载 sidecar 耗时
- `sidecar_command_start -> 第一条 response.output_text.delta`：daemon health、session 创建和模型首段输出耗时
- `kind=tool_call -> kind=tool_call_update`：工具调用往返耗时
- `sidecar_result_envelope`：本轮最终结果、stdout 规模、是否创建 inner sandbox

## 常见问题

### 中文 prompt 变成问号

已经修过：Go wrapper 会把 instruction base64 后传给 sidecar，sidecar 再按 UTF-8 解码。不要绕过当前 wrapper 直接把中文裸塞进 AGS env。

### 纯聊天为什么还要外层 AGS

当前形态是“Agent 运行在外层 AGS 里”，所以纯聊仍会创建外层 sandbox，但不会创建内层 sandbox。后续如果要更快，可以把纯聊 Agent 放在 wrapper 进程里，只在需要工具时再建 AGS。

### 现在的流式语义是什么

已经是标准 SSE 流式：服务端会先发 `response.created`，然后按 Hermes 产生的内容段连续发 `response.output_text.delta`，最后发 `response.output_text.done` 和 `response.completed`。

要注意两个现实约束：

- 纯聊天场景，流式主要受模型首段输出时间影响，现在已经能看到多段 delta。
- 工具场景，模型通常要先决定工具、等待 inner sandbox 执行并拿到结果，所以首个可见最终文本 delta 往往会晚于 `kind=tool_call_update`，这不是 wrapper 卡住，而是 Agent 在拿到工具结果前通常没有可展示的最终自然语言内容。

### 为什么现在更快

CloudAgent Rust sidecar 当前 Linux 二进制约 `6.2MB`，COS 下载和进程冷启动都比较轻。当前链路的主要耗时已经从“sidecar 自身启动”转移到“AGS 创建 + 模型推理 + 工具路径”。

### 强制命令模式还在吗

还在。设置：

```bash
export GATEWAY_AGENT_FORCE_COMMAND='ls -la / && ps aux'
```

这种模式会强制 Agent 调一次工具，适合做排障/基准测试。正常产品形态更推荐让 bash 作为可选工具，由 Agent 自己决定是否调用。
