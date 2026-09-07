# Agent、网关与运行时领域

本领域覆盖 Agent 请求进入、实例/渠道编排、Sandbox 分配、CloudAgent 执行、模型网关/provider 路由、流式响应和后台 workflow。

## 服务与责任

| 服务 | 责任 |
|---|---|
| `service-gateway` | 公共入口与后端代理 |
| `ctl` | 实例、渠道和运行时任务编排 |
| `sandbox` | 运行机器池与状态机 |
| `cloudagent` | Agent gateway、渠道与 Wisp runtime |
| `ai-gateway` / `velagw` / `new-api` | 模型路由、provider 与控制面 |
| `workers` | Temporal workflow、运行时救援导出与恢复作业 |
| `velalink` | 桌面/Chat UI、daemon 与本地观测 |

## 稳定不变量

- Sandbox 请求路径不创建/重装机器，只分配/释放；后台 worker 执行重置与补货。
- 流式/非流式、provider fallback、错误映射和渠道行为由运行时代码与 contract 拥有。
- CloudAgent gateway 镜像与 Wisp/runtime artifact 是两个发布面，跨越时分别验证。
- 运行问题先定位入口接收、编排、实例、生成、渠道/出口的失败边界，不从最终“无回复”猜根因。
- 上游 subtree 与 vendored 内容保留 pin 和本地差异，不无边界复制。
- VelaGW 执行 NewAPI 控制面写操作时，单次操作内复用一个临时管理员登录 session，并在成功或失败后主动注销；不得把短期登录 session 当作持久管理凭据，也不得让周期性配置收敛持续消耗 NewAPI 活跃 session 配额。
- 大体积救援导出由 VM 流式生成归档并使用 COS Multipart Upload，不能先把完整归档写入救援系统盘，也不能退回未知长度的单次 `PUT Object`。
- 腾讯云永久密钥只存在于 Worker runtime Secret。救援 VM 只接收短期、精确到目标对象且仅允许上传 Part 与 Complete 的 STS 凭据；STS 和含凭据的 TAT 脚本不得进入 Temporal Workflow History。
- Workflow 必须在提交 TAT 前持有 Multipart Upload ID。TAT 提交、上传或结果确认失败时，通过 disconnected cleanup context 执行 Abort 并删除可能已经 Complete 的残留对象。
- 修改救援 Workflow 的 Activity 序列时使用 Temporal version marker 保证旧 History 继续 replay，不能让存量执行产生 nondeterminism。
- `ctl.user_subscription_gateway` 是已分配用户的网关归属真源；Pass 续费只延长当前归属网关的权益，不隐式迁移网关。
- VelaGW 中套餐、免费积分与独立购买的积分包是可并存的订阅。Pass 到期清理只能按名称前缀删除 `package:`、`free-credit:` 及历史空名称套餐订阅，必须保留 `credit-package:`；单个积分包退款或隔离则按完整订阅名删除目标订阅，不得清理 Pass 周期元数据或其他积分包。旧 AI-Gateway 不具备定向删除能力，仍沿用用户级全量取消语义。
- 运行中实例从 `ai_gateway` 迁移到 VelaGW 必须同时完成权益补发、固定用途 Key 签发、Hermes Provider 切换、实例 Key ID 持久化和旧 Key 撤销。该操作只通过强鉴权内部接口按 `user_id + instance_id` 执行，默认先 dry-run；用户存在多个非终态 Bot 时拒绝迁移，避免用户级网关路由产生半迁移。
- 迁移采用可重入、最终一致语义：用户、订阅和固定用途 Key 均幂等复用，Hermes 配置可重复收敛，路由和实例 Key ID 可重复写入；任一步失败后允许从头重试，不引入跨服务伪事务。
- VelaGW 人工额度重置只能调用用户加 Plan 维度的接口，并固定保留自然重置时间；禁止用 Plan 全量重置接口代替单用户操作。CTL 对该能力提供用户级包装，隐藏 Set、上游用户和 new-api Plan ID。
- `gateway-dashboard` 只能通过服务端 BFF 调用迁移和额度重置，两个操作均先 dry-run 并要求完整用户 ID 二次确认；`CTL_INTERNAL_TOKEN` 不得进入浏览器。

## 验证

按 [Agent 请求与流式响应 Journey](../journeys/agent-request-streaming.md) 验证公共入口、实例编排、runtime 自检、provider 路由、流输出和失败回退。VelaGW 控制面认证变更还需验证多项配置复用单次登录、成功与失败路径均注销临时 session，且不会撤销持久管理凭据。订阅定向删除变更需验证 Pass 到期保留所有 `credit-package:` 订阅、积分包单独删除不影响 Pass 与其他积分包、重复清理幂等，以及本地投影只删除已匹配的上游订阅。救援导出变更还需验证 Part 重试、Complete、Abort 补偿、取消清理、旧 History replay，以及最终归档的字节数和 SHA-256。Agent 摘要：[agent-gateway-runtime Context](../../context/domains/agent-gateway-runtime.md)。
