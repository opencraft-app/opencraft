# Journey：Agent 请求与流式响应

## 目标

用户在 Web、桌面或渠道发起请求，系统找到正确实例和 runtime，经正确模型 provider 生成并持续返回结果。

## 链路

1. `frontend`/`velalink`/`opencraft` Workbench 或渠道客户端发起请求。OpenCraft 在客户端维护 Codex-compatible Turn/queue/steer 状态，并把 Hermes Desktop 事件语义投影成 AppServer 会话。
2. `service-gateway` 或 ChannelGateway 接收并路由到 Agent 控制/运行入口。
3. `ctl` 解析实例、渠道和运行时归属；`sandbox` 提供目标机器。
4. `cloudagent` gateway/Wisp 执行 Agent 调用。
5. `ai-gateway`、`velagw` 或 `new-api` 根据 contract 选择 provider 并处理流式/非流式响应。
6. CloudAgent/渠道把输出送回原入口；OpenCraft 以 durable replay 游标和同生命周期投影状态去重、续接并完成 Turn，`workers` 可承担异步恢复作业。

国内站嵌入式 Agent Chat 的侧栏将 OpenCraft 的 `turn/completed` 终态事件投影为后台会话未读提示：完成时若用户正在查看其他会话或已离开聊天页，宿主为该会话显示蓝点；打开会话后清除。后台 Hermes 会话可能只在目录中更新运行状态、没有经过当前视图的 Turn 投影，因此宿主还比较已加载会话列表的 `running=true → false`，为遗漏的终态事件补蓝点；首次历史加载和正在刷新的目录不触发。这个兜底只能判断执行已结束，无法仅凭目录区分正常完成和主动中断。手动“标记为未读”仍由宿主维护。

## 诊断顺序

Hermes 历史恢复与执行流分开：REST 的 120 条源记录窗口和 offset 拥有分页，
OpenCraft 桥接器返回完整累计投影，不按 Turn 数二次截断。Bot 聊天可能不展示
已完成的工具记录，空展示页不能冒充空历史；视口按一次恢复意图最多连续请求三页，
仍有历史或读取失败时提供原位加载／重试。重同步仅凭同会话的持久消息锚点保留
已加载前缀，新的读取独占权限与执行状态；本地提交和同代次实时消息独立保留，
旧代次迟到页不得覆盖。详见 [Hermes 历史连续性](../../../opencraft/docs/chat-ui-architecture.md#hermes-message-windows-and-bot-history-continuity)。

按“入口是否收到 → 编排是否找到实例 → runtime 是否健康 → provider 是否生成 → 流/渠道是否送出”定位，不从最终沉默直接归因模型。每层使用同一 request/session/instance 关联标识，日志不得包含密钥或完整敏感内容。

VelaGW 到 NewAPI 的转发由网关覆盖写入一次性 `X-VelaGW-Trace-ID`，同时在网关 access log 记录 `trace_id`、上游响应头与首字节时间；`streaming` 字段表示上游**响应**是否为 SSE，不等于请求的 `stream` 参数。NewAPI 仅对携带有效关联 ID、耗时至少 30 秒或失败的请求记录从发起 provider 请求到获得响应头的 `relay_upstream_timeline`；流结束时，仅对总耗时至少 30 秒或异常的流记录首个有效 SSE 事件时间、事件数和结束原因。两侧按 `trace_id` 对账，区分 NewAPI 尚未获得 provider 响应头、已获得响应头但首事件迟到，以及客户端取消。诊断 ID 不经通配或正则请求头透传规则自动转发给 provider。诊断日志只含白名单 ID、时长、状态码、计数和枚举，不含请求体、密钥或原始错误文本；这些字段不改变 ping、超时、重试或流式输出行为。日志缺失不能单独证明请求未到达，仍须结合网关状态与服务实例日志判断。

Headless OpenCraft 的入口校验先于运行时健康判断：包内 Web release 必须声明 headless 构建身份和 `opencraft-server` Host 入口，否则即使同包 Codex AppServer 可启动，也不应让 Host 认领数据目录并对外提供 Web。打包、包级 smoke 和服务启动复用这一不变量；不要把通用 Web 构建的进程健康误判为 Codex 会话可用。

SSH Codex 恢复仍遵循原生 Turn/Item 分页，不因 SSH 传输丢失历史方法或上游 metadata。共享 broker 的方法准入清单同时约束 Runtime 和 Composer；准入不是上游实现保证，尚无远端所有权的本机队列、附件及连接句柄不得假冒远端能力。偏好只在可用动作中选择：只有原生 Steer 时，排队偏好不制造 Queue 请求；拒绝早于草稿与乐观队列收养。目录发现由 Application 单飞恢复，页面挂载不拥有连接/后台恢复生命周期。默认共享入口由 Application 自动申请绑定 Origin 的后端管理会话，过期/重启自动重新申请；已确认失效的旧目录先撤销。申请会话不等于 SSH 重连或执行命令，不能重放写操作。可用 `--ssh-require-access-key` 启用额外密钥；共享入口的所有访问者均可使用安装实例保存的 SSH 凭据，不宣称成员权限隔离。详见 [SSH Codex Servers](../../../opencraft/docs/ssh-codex-servers.md#ownership-and-supported-surface)。

OpenCraft 的 Codex Account Pool 在 Host 本机回环地址转发 Responses 请求，接收正文上限为 32 MiB。超限时读完并丢弃剩余正文，再返回明确的 HTTP 413；不把本地大小拒绝呈现成流式连接中断，也不将超限正文送往模型上游。

Codex Account Pool 的模型上游传输使用专用 HTTP/1.1 连接池，最多同时放行
16 个请求且不使用 pipelining；等待响应头和响应体空闲分别限制为 60 秒和
180 秒。排队、慢响应头及传输失败只记录脱敏身份与时长，不记录请求正文或
凭据。超时或网络失败必须回报原 Turn，不能切换账号重放该推理请求，因为
provider 是否已经开始执行无法从传输失败确定。Workbench 对 AppHost 的自动
重连按 0.5/1/2/5/15/30/60 秒退避并保持一分钟上限；重连只恢复传输，不重新
提交已经接纳或结果未知的 Turn。

OpenCraft 侧栏目录读取的加载状态不占可见行：不显示额外转圈、文字或空白占位，也不改变既有历史行位置或身份。状态仍由 Application 查询拥有，Sidebar 保留 `aria-busy`，加载未完成不冒充成功空列表；失败仍提供当前目录的重试入口。此呈现约束不改变目录读取或会话正文加载行为，详见 [SSH-07](../../../opencraft/design/invariants.md#ssh-connection-management)。

## 验证

NewAPI 的 Hunyuan ASR 是独立的同步语音协议适配，不属于普通 LLM 转换。
高级自定义渠道仅在 `/v1/audio/transcriptions` 路由允许
`openai_transcriptions_to_hunyuan_asr`，将 multipart 音频增量编码为 Base64 JSON，
复用模型映射、渠道凭据与现有转写的时长估算记账。容器格式沿既有纯 Go 时长解析器，
不把 OpenCraft 的 PCM16 单声道 16kHz WAV 策略当作供应商格式限制；使用
`voice_encode_format=auto`。WebM/Opus 时长在内存中按块时间戳与 RFC 6716 包时长
计算，支持浏览器常见的缺省 Duration、未知 Segment/Cluster 长度、lacing、
CodecDelay 与尾部 DiscardPadding；不信任声明的 Duration 来低估计费，
拒绝重叠时间线、截断结构和非单一 Opus 音轨。解析无 ffprobe、解码或临时文件；
不接受缺少采样率/布局元数据的裸 PCM。响应仅 `json`/`text`，不生成时间戳或流事件。
模型、地址与密钥由渠道管理，不硬编码；上传音频不写磁盘、不上传对象存储，也不接受 URL 输入。

渠道选择前也要解析上传的 model，因此标准转写入口统一强制内存 BodyStorage 与
multipart 解析；其它协议的磁盘缓存不变。转写入口在鉴权后、模型解析前获取整请求
内存并发租约：`TRANSCRIPTION_MAX_CONCURRENT` 默认 4（有效范围 1–64），超限
在读取请求体前返回带 Retry-After 的 429；保留 MAX_REQUEST_BODY_MB 大小限制。
适配器直接在已有 multipart 文件上校验时长并 rewind；发送端使用拉取式固定
24KiB 原始块/32KiB 编码块，无后台生产 goroutine，不生成完整 Base64 字符串或 JSON
正文。JSON 元数据单独正确转义，根据音频长度计算 Content-Length，不依赖 chunked。
取消和源读取错误终止上传，HTTP 完成/失败后关闭文件；不改变计费和重试策略。
部署前仍须按该大小与并发、multipart 解析副本和有界编码缓冲核算 Pod 内存，不能只按
压缩音频大小估算路由前的内存。该准入只作用于转写，不限制普通 LLM。

Hunyuan 上游使用独立 HTTP client 配置副本，90 秒为含响应体读取的最大时长
（更短的全局 relay timeout 仍生效），传播调用方取消、不跟随重定向、不修改共享 LLM client。
供应商响应最多 128KiB，转写文本最多 32,000 UTF-8 字节；异常响应不暴露供应商
原始正文，传输结果不明或异常成功正文不自动重试，避免重复转写计费。
上游明确非 200 拒绝仍交由既有 relay 状态码/重试策略处理。适配器测试不是生产公共入口验收。
配置、WebM/Opus 实测证据及浏览器切换边界见 [Hunyuan ASR](../../../new-api/docs/hunyuan-asr.md)。

OpenCraft Web 混元听写在提交 Agent 请求之前完成，属于客户端输入服务。
平台适配器拥有录音，应用后端拥有凭据与有界同步转写，Composer 拥有原草稿写入确认。
停止只插入；发送必须等待同一草稿的写入确认。失败撤销旧发送意图，显式重试复用音频而不重录，
取消或换 View 后的迟到结果不能提交。转写复用模型服务的配置与凭据仓库，但拥有独立语音模型选择，
不使用聊天默认、不进入聊天引擎投影，也不路由到所选 SSH Server。录音固定配置票据，配置改变时拒绝旧录音；
付费公网入口独立 opt-in。详见 [云听写契约](../../../opencraft/docs/cloud-dictation.md)。

OpenCraft Web 混元听写在提交 Agent 请求之前完成，属于客户端输入服务。
平台适配器拥有录音，应用后端拥有凭据与有界同步转写，Composer 拥有原草稿写入确认。
停止只插入；发送必须等待同一草稿的写入确认。失败撤销旧发送意图，显式重试复用音频而不重录，
取消或换 View 后的迟到结果不能提交。转写既不使用聊天模型配置，也不路由到所选 SSH Server；
付费公网入口独立 opt-in。详见 [云听写契约](../../../opencraft/docs/cloud-dictation.md)。

OpenCraft 的执行轮次与展示片段分开：同一轮次内的异步提问、回答、Steer 与后续工作按原有记录顺序投影，活动只在连续范围内折叠，不把所有回答集中到旧工作记录之前。共享 `chat-core` 拥有顺序分段和当前响应判定；Web/Native 不独立重排。异步提问即使带最终回答 phase 也不能结束工作计时，历史回答不得压住后续响应的运行状态。具体契约见 [ChatUI 顺序与所有权](../../../opencraft/docs/chat-ui-architecture.md#history-positions-and-concurrent-observations)。

引擎实际返回的非空思考与工具记录归同一连续响应的工作容器，内层分别展开；有效最终回答位于外层折叠之外。思考文本到达只分开相邻内层工具组，不重建外层身份、制造新响应或取得完成资格；只有思考、没有工具的已答响应也可在真实用时下折叠。用时与实时反馈仍各有唯一所有者，用户插话和异步提问保留边界。外层收起仅改变可见性，View 保留内层思考/工具选择，动画组件不能重置它们；不能用不含实际内容的运行状态或加密字段伪造思考。详见 [返回思考内容](../../../opencraft/docs/chat-ui-architecture.md#returned-thinking-content)。

返回思考的展开正文复用共享 Markdown 文档管线，保持实际返回源不变；折叠标题从同一文档语法提取可读文字，不显示格式控制符或链接地址，也不删除代码标识符和转义字面量。链接、媒体、代码与表格沿用普通回答的 Host 授权和平台呈现，文档测量归现有滚动所有者；资源点击、流式变化和完成不能改写内外折叠选择。Web 与 Native 不各自解析第二种摘要语法。详见 [返回思考内容](../../../opencraft/docs/chat-ui-architecture.md#returned-thinking-content)。

OpenCraft 会话云桌面的观看连接不是 Agent Turn 的执行宿主。面板关闭、账户切换或观看失败只撤销自己的短期连接与输入租约，不中断 Turn 或删除远端桌面。云桌面插件框架用模拟后端验证此分离；生产 CTL/TAT 和媒体接通须另验资源代次、授权撤销及手动控制与 Agent 的仲裁。

CTL 桌面准备源码以 POST 明确启动，独立有界后台编排持续安装/拉起/探测；新 GET 只观察，不创建状态或续期。换用户、换 Sandbox 与失败重试隔离旧状态，短 TAT 命令按进程内绑定锁串行化。此阶段不提供观看凭据或 WebRTC：prepared 只证明既有桌面 HTTP 探测，编排代次不是媒体 incarnation。验证需分开记录 CTL 直连、Gateway 路径策略及真实 TAT/媒体；五个精确 allowlist 环境尚未放行新路径，JP/KR 前缀路由不能靠“没新增规则”推断阻断。见 [CTL 桌面资源契约](../../../ctl/docs/cloud-desktop-resource.md)。

覆盖普通响应、流式分片、客户端取消、provider 超时/限流、fallback、渠道发送失败和重连。OpenCraft 还必须覆盖 steer/queue 可见性、断线恢复不重复投影、完成瞬间组件身份和滚动所有权；工具终态必须有结果证据，不可恢复的资源缺失不得自动重连，Web/Expo 消息折叠需在宽度变化后重新测量自然高度。Host 从失败恢复到 ready 时应在无消息提交条件下重载 Catalog，BFCache 往返不得销毁应用所有权图。跨 gateway/runtime artifact 的变更分别验证镜像 pin 与 runtime SHA。

OpenCraft Task 的未发送输入由 Application 按独立编辑槽持有，页面 View 只借用同一 Composer Controller；侧栏返回优先恢复该槽，显式新 View 与历史导航仍保持各自身份。非空草稿最多 50 份，空输入不占名额，超限清理最久未使用且未被编辑/提交保留的输入；全部受保护时拒绝新增内容，不暗中覆盖。页面缓存淘汰不清理仍有输入的槽，新会话的语义记录也不得先于其输入失效；保留输入不获取 Thread 或 Host 执行租约。账户切换撤销旧输入与存储权限，成功发送只清理实际被接纳且未被随后编辑的草稿。详见 [ChatUI 草稿与附件所有权](../../../opencraft/docs/chat-ui-architecture.md)。

Web 图片和普通文件的浏览器 `File`、预览 URL 与处理任务跟随上述 Controller 生命周期，不进入可序列化的 AppServer 请求或重放事件。异步附件处理必须按原草稿和附件身份回写；切换目标不能串写，删除、清空或释放 Controller 后的迟到结果不能复活附件。输入淘汰同时释放附件资源并删除其保存文档，附件字节不承诺刷新恢复。验证必须覆盖完成 A→B→A 后相同 Controller 与原始文件字节、页面缓存淘汰、51 份输入的 LRU 清理，以及迟到结果与账户撤销；不得仅检查返回时新卡片长得相同。发送后的图片只按已获准的会话媒体资源解析，并以可关闭、可恢复焦点的查看器呈现。
HEIC/HEIF 相机照片在浏览器可解码时先转成 JPEG 再形成内联图片输入；转码是格式兼容步骤，即使 JPEG 较大也不能回退为原始 HEIC。转码失败保留原 `File` 供重试并阻止发送，输出字节仍在 Base64 分配前受大小上限约束。

AgentChat 的启动令牌由 CTL 签发与验签，默认有效期为 10 分钟；它不限定单条消息或 Agent Turn 的执行时长。SDK 按 10 分钟寿命估算并约在签发后 6 分钟开始预刷新，宿主刷新回调以 CTL 返回的真实过期时间为准。回调签名的时间戳容差独立保持 5 分钟，不能误当令牌有效期。生产环境仍以实际加载的配置覆盖值为准。
