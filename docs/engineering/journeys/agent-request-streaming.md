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

## 诊断顺序

按“入口是否收到 → 编排是否找到实例 → runtime 是否健康 → provider 是否生成 → 流/渠道是否送出”定位，不从最终沉默直接归因模型。每层使用同一 request/session/instance 关联标识，日志不得包含密钥或完整敏感内容。

VelaGW 到 NewAPI 的转发由网关覆盖写入一次性 `X-VelaGW-Trace-ID`，同时在网关 access log 记录 `trace_id`、上游响应头与首字节时间；`streaming` 字段表示上游**响应**是否为 SSE，不等于请求的 `stream` 参数。NewAPI 仅对携带有效关联 ID、耗时至少 30 秒或失败的请求记录从发起 provider 请求到获得响应头的 `relay_upstream_timeline`；流结束时，仅对总耗时至少 30 秒或异常的流记录首个有效 SSE 事件时间、事件数和结束原因。两侧按 `trace_id` 对账，区分 NewAPI 尚未获得 provider 响应头、已获得响应头但首事件迟到，以及客户端取消。诊断 ID 不经通配或正则请求头透传规则自动转发给 provider。诊断日志只含白名单 ID、时长、状态码、计数和枚举，不含请求体、密钥或原始错误文本；这些字段不改变 ping、超时、重试或流式输出行为。日志缺失不能单独证明请求未到达，仍须结合网关状态与服务实例日志判断。

Headless OpenCraft 的入口校验先于运行时健康判断：包内 Web release 必须声明 headless 构建身份和 `opencraft-server` Host 入口，否则即使同包 Codex AppServer 可启动，也不应让 Host 认领数据目录并对外提供 Web。打包、包级 smoke 和服务启动复用这一不变量；不要把通用 Web 构建的进程健康误判为 Codex 会话可用。

SSH Codex 恢复仍遵循原生 Turn/Item 分页，不因 SSH 传输丢失历史方法或上游 metadata。共享 broker 的方法准入清单同时约束 Runtime 和 Composer；准入不是上游实现保证，尚无远端所有权的本机队列、附件及连接句柄不得假冒远端能力。偏好只在可用动作中选择：只有原生 Steer 时，排队偏好不制造 Queue 请求；拒绝早于草稿与乐观队列收养。目录发现由 Application 单飞恢复，页面挂载不拥有连接/后台恢复生命周期。默认共享入口由 Application 自动申请绑定 Origin 的后端管理会话，过期/重启自动重新申请；已确认失效的旧目录先撤销。申请会话不等于 SSH 重连或执行命令，不能重放写操作。可用 `--ssh-require-access-key` 启用额外密钥；共享入口的所有访问者均可使用安装实例保存的 SSH 凭据，不宣称成员权限隔离。详见 [SSH Codex Servers](../../../opencraft/docs/ssh-codex-servers.md#ownership-and-supported-surface)。

OpenCraft 的 Codex Account Pool 在 Host 本机回环地址转发 Responses 请求，接收正文上限为 32 MiB。超限时读完并丢弃剩余正文，再返回明确的 HTTP 413；不把本地大小拒绝呈现成流式连接中断，也不将超限正文送往模型上游。

OpenCraft 侧栏目录读取的加载状态不占可见行：不显示额外转圈、文字或空白占位，也不改变既有历史行位置或身份。状态仍由 Application 查询拥有，Sidebar 保留 `aria-busy`，加载未完成不冒充成功空列表；失败仍提供当前目录的重试入口。此呈现约束不改变目录读取或会话正文加载行为，详见 [SSH-07](../../../opencraft/design/invariants.md#ssh-connection-management)。

## 验证

OpenCraft 的执行轮次与展示片段分开：同一轮次内的异步提问、回答、Steer 与后续工作按原有记录顺序投影，活动只在连续范围内折叠，不把所有回答集中到旧工作记录之前。共享 `chat-core` 拥有顺序分段和当前响应判定；Web/Native 不独立重排。异步提问即使带最终回答 phase 也不能结束工作计时，历史回答不得压住后续响应的运行状态。具体契约见 [ChatUI 顺序与所有权](../../../opencraft/docs/chat-ui-architecture.md#history-positions-and-concurrent-observations)。

OpenCraft 会话云桌面的观看连接不是 Agent Turn 的执行宿主。面板关闭、账户切换或观看失败只撤销自己的短期连接与输入租约，不中断 Turn 或删除远端桌面。云桌面插件框架用模拟后端验证此分离；生产 CTL/TAT 和媒体接通须另验资源代次、授权撤销及手动控制与 Agent 的仲裁。

CTL 桌面准备源码以 POST 明确启动，独立有界后台编排持续安装/拉起/探测；新 GET 只观察，不创建状态或续期。换用户、换 Sandbox 与失败重试隔离旧状态，短 TAT 命令按进程内绑定锁串行化。此阶段不提供观看凭据或 WebRTC：prepared 只证明既有桌面 HTTP 探测，编排代次不是媒体 incarnation。验证需分开记录 CTL 直连、Gateway 路径策略及真实 TAT/媒体；五个精确 allowlist 环境尚未放行新路径，JP/KR 前缀路由不能靠“没新增规则”推断阻断。见 [CTL 桌面资源契约](../../../ctl/docs/cloud-desktop-resource.md)。

覆盖普通响应、流式分片、客户端取消、provider 超时/限流、fallback、渠道发送失败和重连。OpenCraft 还必须覆盖 steer/queue 可见性、断线恢复不重复投影、完成瞬间组件身份和滚动所有权；工具终态必须有结果证据，不可恢复的资源缺失不得自动重连，Web/Expo 消息折叠需在宽度变化后重新测量自然高度。Host 从失败恢复到 ready 时应在无消息提交条件下重载 Catalog，BFCache 往返不得销毁应用所有权图。跨 gateway/runtime artifact 的变更分别验证镜像 pin 与 runtime SHA。

Web 图片附件的浏览器 `File` 与预览 URL 属于 Composer View/Controller 生命周期，不进入可序列化的 AppServer 请求或重放事件。异步图片处理必须按草稿和附件身份回写；切换目标不能串写，删除、清空或释放 Controller 后的迟到结果不能复活附件。发送后的图片只按已获准的会话媒体资源解析，并以可关闭、可恢复焦点的查看器呈现。
HEIC/HEIF 相机照片在浏览器可解码时先转成 JPEG 再形成内联图片输入；转码是格式兼容步骤，即使 JPEG 较大也不能回退为原始 HEIC。转码失败保留原 `File` 供重试并阻止发送，输出字节仍在 Base64 分配前受大小上限约束。

AgentChat 的启动令牌由 CTL 签发与验签，默认有效期为 10 分钟；它不限定单条消息或 Agent Turn 的执行时长。SDK 按 10 分钟寿命估算并约在签发后 6 分钟开始预刷新，宿主刷新回调以 CTL 返回的真实过期时间为准。回调签名的时间戳容差独立保持 5 分钟，不能误当令牌有效期。生产环境仍以实际加载的配置覆盖值为准。
