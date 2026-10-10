---
id: task-newapi-hunyuan-asr-20261007
type: task
scope: NewAPI memory-only Hunyuan ASR protocol adapter
owner: skipzhang
authority: primary
source_of_truth: [docs/context/tasks/2026-10-07-newapi-hunyuan-asr.md]
status: active
reviewed_at: 2026-10-07
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal
通过 NewAPI 的标准转写接口接入 Hunyuan ASR Base64 同步协议，全程不落盘。

2026-10-07 追加实现授权：混元请求增量编码发送，不生成完整 Base64/JSON 正文；
复用 multipart 音频进行发送前校验，不引入独立运行池、不改分片、不发布生产。

追加实测授权：用户“那就实测一下？”；使用短合成语音，仅一次供应商请求验证
增量 Base64 JSON 定长上传，不使用用户录音、不改生产配置。

2026-10-07 追加：用户确认补齐 WebM 时长解析并实测混元接受 WebM/Opus；
新增一条短合成语音的有界供应商请求，不改变生产配置，不启用客户端直传。

## non_goals
- 不改 servicegateway、普通 LLM 协议或上游 subtree 版本。
- 不上传 COS、不使用 input_url；不全量发布、不发布新山、不切换浏览器。

## release_authorization
- 用户“授权，继续。”：授权提交推送、CI 构建并灰度上海一个 Set。
- 源码接收/评审、固定镜像 digest、生产健康和回滚门禁仍需满足；不得绕过评审。

## requirement_ids / requirement_refs / requirement_excerpt
- 本会话 2026-10-07：用户确认“算了 就newapi做”“要求完全不落盘”“你现在可以开始评估编码了”。

## interface_refs / data_structure_refs
- `new-api/common/gin.go`: 首次请求体读取与 multipart 解析必须使用内存。
- `new-api/relay/channel/advancedcustom/adaptor.go`: 仅选中的 Hunyuan ASR 转写路由进行转换。
- 上游 JSON：model、data(Base64 音频)、voice_encode_format=auto、可选 source；官方响应 status/output，也兼容既有 data envelope。
- 原有 model mapping、鉴权、渠道选择、记账边界保持。

## history_context
- current_design_refs: `docs/engineering/journeys/agent-request-streaming.md`。
- relevant_evolution: origin/master 948b57fe；OpenCraft 现有 speech-transcription-service 已使用内存 WAV/Base64 协议。
- superseded_refs: 无。

## acceptance
- 模拟上游验证 multipart→JSON→标准转写响应。
- 强制启用磁盘缓存仍不生成音频临时文件；普通 JSON 缓存策略不变。
- 无效音频、非转写路由、异常响应明确失败；不返回上游原始音频或异常内容。

## affected_paths
- new-api/common, new-api/dto, new-api/relay/channel/advancedcustom, new-api/service/relayconvert, new-api/web/src/features/channels。

## required_context
- root AGENTS、new-api/AGENTS、upstream-subtrees、agent-request-streaming、argocd-ci-secrets adjacency。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 工作区规则 | 隔离 worktree 与文档检查 |
| new-api/AGENTS.md、MONO2_SUBTREE.md | subtree 边界 | 本地改造不修改上游版本标记 |
| docs/context/project/upstream-subtrees.md | 路由必读 | 同步与本地修复分离 |
| docs/engineering/journeys/agent-request-streaming.md | gateway 高风险映射 | 回写协议隔离不变量 |
| docs/context/project/adjacency/argocd-ci-secrets.md | 邻接发布边界 | 本轮不发布 |
| docs/context/domains/agent-gateway-runtime.md | 增量上传路由必读 | HTTP 传输级测试，隔离普通 LLM |

## evidence
- 独立干净 worktree /data/mono2-newapi-hunyuan-asr-20261007。
- 现有 multipart ReadForm 与 BodyStorage 均可能落盘，必须在选择渠道前保护转写入口。

## risks
- 所有标准转写上传使用内存；保留请求大小限制，发布前需评估容量与并发预算。
- 用户追问后核对腾讯云官方同步文档：支持多格式与 auto，75MB/30min；撤销照搬 OpenCraft 的 WAV-only 产品限制。
- WebM/Opus 已补齐纯内存时长解析与一条真实上游验证；其它 codec、多音轨、视频不宣称支持。
- 回滚：停用新协议路由，或回退独立源代码补丁。

## validation
- `go test ./common ./dto ./middleware ./relay/channel/advancedcustom ./service/relayconvert ./relay ./router` 通过。
- `go test -race ./common ./middleware ./relay/channel/advancedcustom` 通过；格式调整后另复验 ASR race 通过。
- 前端配置测试、Bun typecheck、build:check、format:check 通过。
- 前端全量 lint 未通过：未改动模块存在历史错误；本次两个 TS 文件与测试脚本聚焦 lint 无错误，只有既有 structuredClone 建议。
- `git diff --check`、change-impact 通过，仍需 Owner 审阅。
- 浏览器到 NewAPI 公共入口和生产容量尚未验收；未发布。真实上游已按追加授权单次验证。
- 追加实测：约 2.979s/10,387B WebM/Opus，通过适配器向 TokenHub ep-hyasr3 发出一次请求，HTTP200/completed，1.29s，完整识别合成英语。音频/stdin 与密钥均不落盘。
- WebM 修改后 7 个后端 package 回归与 common/middleware/advancedcustom race 均通过；结构校验收紧后真实合成样本 dry-run 再次通过，未再发付费请求。
- `go vet ./common ./relay/channel/advancedcustom` 被未修改的 custom-event.go 复制锁及 email_test.go IPv6 地址格式历史问题阻断；不修改无关代码。
- 新解析器 `go vet common/audio_webm.go` 通过；临时合成工具容器已删除，无音频文件可清理。
- 增量编码追加验证：7 个后端 package 回归通过，common/middleware/advancedcustom race 通过；
  小块输入/7 字节输出、Base64 尾部 padding、JSON 转义、Content-Length、非 chunked HTTP、
  构造不读取音频、取消、源读取错误和幂等关闭均有测试。
- 编码基准（5 次）：1MiB/8MiB/32MiB 音频分别 68,620/68,620/68,656 B/op，
  是不包含原始上传及 multipart 的额外分配量，不代表整个请求峰值/RSS。
- 显式变更列表 change-impact 与 git diff --check 通过；未提交、推送或发布。
- 追加授权后于 2026-10-07 19:35 北京时间，仅发送一次短合成语音增量上传：
  WebM/Opus 10,387B/2.978521s，请求 Content-Length=13,926，适配器请求体类型
  确认 hunyuanASRBody；HTTP200/completed，完整识别合成英语，测试 1.29s。
  音频与凭据仅内存/stdin，未使用用户录音、未改生产；公共入口验收仍未完成。
- 发布前追加检查：标准 Dockerfile 本地镜像构建通过，镜像 tag
  mono2-newapi:hunyuan-asr-20261007-local，image ID
  sha256:98112f7a1ac579cc1cbd121ee67f48e776339ceaac25773b80a7289b35081555。
  这是本地未提交源码镜像，不是生产 registry digest/release。
- 隔离容器无网络/无端口映射、SQLite 和临时目录使用 tmpfs：/api/status success=true、
  首页 HTML 和两个 hash JS 资源可读取，容器 running/OOMKilled=false；检查后已删除。
- NewAPI CI workflow 两项契约测试通过；只读 fetch 后 origin/master=3030f9150，
  比源码基线领先 8 个提交，new-api/ 无差异；未自动 merge/rebase、commit 或 push。

## decisions
- 在现有高级自定义渠道增加 Hunyuan ASR 协议，避免新增渠道类型和影响普通模型。
- 返回 json 或 text；不编造时间戳、流式事件或供应商 token usage。
- 明确区分浏览器 MediaRecorder 录音格式、客户端产品策略、NewAPI 计费解析与上游格式能力。

## scan_scope
- 仅列出的 NewAPI 路由、缓存、音频和配置文件。

## scan_output
- 记录命令摘要，不输出音频与凭据。

## handoff
- 本地打包/启动验收通过；已获上海单 Set 发布授权，
  CI 镜像固定 digest 后仍按发布环灰度，不使用本地未提交源码镜像直接替换生产。
- 增量编码已实现：复用 multipart 文件校验/rewind，固定缓冲拉取式 Base64 JSON，
  设置 Content-Length，无完整编码正文、无后台编码 goroutine；本地传输与 race 测试通过。
- 初版源码实现及模拟上游验证已完成，位于独立 feat/newapi-hunyuan-asr-20261007 worktree；未提交、推送或发布。
- WAV-only 假设已按官方文档撤销；官方顶层响应与旧 data envelope 均有回归。
- WebM/Opus 服务端直传已有解析与上游证据；浏览器仍使用旧的内存 WAV 路径，本轮未切换。仍需发布、客户端接入与真实浏览器 E2E 验收。
- 上线前核定转写请求体上限与并发预算、配置模型价格，再验证公共入口。
