# 服务拓扑与责任边界

Service Catalog 是机器可读清单，本页是人读地图。Owner 当前统一指向仓库维护责任队列，不据提交次数猜个人；真实团队映射以后只改 Catalog。

| 服务/平台 | 主要责任 | 主要领域 | 关键依赖或出口 |
|---|---|---|---|
| `.ci` | 流水线、镜像、制品晋级 | 发布与 GitOps | `argocd`、`infra_pulumi` |
| `admin-gateway` | 管理面入口 | 身份、发布 | Gateway Dashboard、Auth |
| `ai-gateway` | 模型网关与 provider 适配 | Agent runtime | VelaGW、管理面 |
| `cloudagent` | Agent gateway、渠道、Wisp 与 runtime artifact | Agent runtime | CTL、Sandbox、AI Gateway |
| `cloudladdergateway` | 强认证计费代理与审计 | 订阅权益 | Trade、外部计费 |
| `codesign` | 签名/平台交付操作知识 | 发布 | 外部交付平台 |
| `ctl` | 实例、渠道和任务编排 | Agent runtime、身份 | Sandbox、CloudAgent、Gateway |
| `frontend` | 国内/国际站 Web 与产品文档 | 站点、身份、权益 | Service Gateway、Auth、Subscription |
| `gateway-dashboard` | 网关管理前端 | Agent runtime | Admin Gateway、AI Gateway |
| `infra_pulumi` | 云资源、环境 inventory、deploy 输出 | 发布、站点环境 | 腾讯云、Argo、服务 overlays |
| `new-api` | 上游模型聚合服务 | Agent runtime | 上游 NewAPI、AI Gateway |
| `nextgen-dashboard` | 下一代管理 Dashboard | Agent runtime | Admin Gateway |
| `payment` | 支付 contract 与回调 | 订阅权益 | Subscription、Trade、支付 provider |
| `sandbox` | CVM 池、分配、释放、重置 | Agent runtime | CTL、腾讯云、MySQL/Redis |
| `service-gateway` | 公共入口、站点/鉴权/代理 | 身份、站点、Agent | 所有公共后端 |
| `shadow` | 腾讯云影子账号与临时凭据编排 | 身份、权益 | 腾讯云、Trade |
| `subscription` | 套餐、订阅、续费、Pass 与配额 | 订阅权益 | Payment、Trade、Auth |
| `ticket` | 反馈/工单、realm 与审计 | 身份、发布 | Auth、Frontend、MySQL |
| `trade` | 订单、计费 provider、开通编排 | 订阅权益 | Payment、Subscription、CTL |
| `user/auth` | 登录、会话、实名、OIDC/OAuth | 身份 | Service Gateway、外部 IdP |
| `velagw` | 上游 LLMGateway 控制/数据面 | Agent runtime | provider、AI Gateway |
| `velalink` | 桌面、Chat UI、daemon、观测 | Agent runtime、站点 | Frontend、vendored Codex |
| `workers` | Temporal workflow 与 rescue 作业 | Agent runtime、发布 | Temporal、COS |

## 如何使用

先在 [中央 Service Catalog](../catalog/services.yaml) 找到服务，再进入该目录的 `docs/README.md`。跨服务问题使用 [领域文档](../domains/) 和 [Journey](../journeys/)；运行态、外部计费或云 API 事实不能从本拓扑推断。
