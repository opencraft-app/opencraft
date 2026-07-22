# 多地域 Terraform 配置设计

## 背景

当前生产 Terraform 可以修改 `region`，但部分默认值仍绑定北京，包括可用区、TCR、证书和域名。仅修改地域不足以安全地创建独立集群，也可能让上海环境错误引用北京资源。

本设计把地域差异收敛为独立参数文件，使同一套 Terraform 能重复部署北京、上海等相互独立的生产集群。

## 目标

- 每个地域使用独立的非敏感 `tfvars` 和 backend 配置。
- 地域、可用区、域名、证书和镜像仓库必须显式提供。
- 在 plan 阶段拒绝地域与可用区不匹配、域名冲突和空参数。
- 北京现有参数迁移后保持等价，不产生无意资源替换。
- 上海部署时由操作者或 AI 逐项确认环境参数。

## 非目标

- 不在 Terraform 文件中保存云密钥、数据库密码、管理 token 或渠道 Key。
- 不建设北京和上海共享入口或全局流量调度。
- 不在本次改造中执行上海资源创建。
- 不把 LLMGateway MySQL 中的渠道包、权益模板及 Set 下发状态等业务状态纳入 Terraform state。

## 目录结构

```text
deploy/terraform/tencentcloud-prod/
├── environments/
│   ├── beijing.tfvars.example
│   └── shanghai.tfvars.example
├── backend/
│   ├── beijing.hcl.example
│   └── shanghai.hcl.example
└── *.tf
```

示例文件只包含非敏感配置。实际生产文件可从示例生成，并继续由 `.gitignore` 排除。

## 参数边界

以下参数不提供生产默认值：

- `region`
- `region_alias`
- `availability_zones`
- `control_dns_subdomain`
- `traffic_dns_subdomain`
- `control_clb_domain`
- `traffic_clb_domain`
- `control_cert_id`
- `traffic_cert_id`
- `tcr_instance_id`
- `tcr_public_domain`

域名由现有 DNS zone 与子域参数组合。北京和上海必须使用不同子域。每个地域使用本地域 TCR；因为 Terraform 会管理 namespace/repository，两个独立 state 不得接管同一仓库。

资源规格、容量水位和通用命名等与地域无关的参数可以保留默认值。

## 校验

Terraform validation 和 precondition 必须覆盖：

- `availability_zones` 非空，且每项都以 `${region}-` 开头。
- `region_alias` 显式进入资源名前缀；北京现网保持 `bj`，避免资源改名。
- control 与 traffic 子域非空且不相同。
- 证书 ID、TCR instance ID 和 TCR public domain 非空。
- backend 每个地域使用独立 key；文档和测试不得让北京、上海共用 state key。
- 北京 backend 必须继续使用现有 `llmgateway/prod` key，除非单独执行显式 state 迁移。

校验错误必须在 plan 前期给出明确提示，避免运行到腾讯云 API 后才失败。

## 北京兼容

`beijing.tfvars.example` 记录当前北京非敏感参数。改造前后使用同一 state 执行 plan 时，预期不出现由默认值迁移导致的资源替换。若现网值与仓库记录不一致，以 Terraform state 和云上实际资源为准更新本地真实参数文件。

## 上海部署流程

1. 复制上海地域参数和 backend 示例到本地非提交文件。
2. 逐项确认地域、可用区、独立域名、证书和 TCR。
3. 初始化上海独立 remote state。
4. 保持 `edge_dns_enabled=false`，执行 format、validate、plan 和首次 apply。
5. 部署 K8s、LLMFleet、Secret 和 LLMGateway，等待 Service 创建 CLB。
6. 写回真实 CLB 域名并设置 `edge_dns_enabled=true`，再次 plan/apply DNS。

## 测试

- 合法北京参数通过静态契约测试。
- 上海示例的地域、可用区和域名边界通过静态契约测试；证书/TCR 占位值必须阻止真实 plan。
- 上海地域配北京可用区时失败。
- control 与 traffic 域名相同时失败。
- 关键地域参数缺失时失败。
- 北京和上海 backend 示例的 state key 必须不同。
- 北京 backend 示例必须保留现有 `llmgateway/prod` state key。
- 运行 `tofu fmt -check` 和 `tofu validate`（可用时）。

## 后续

渠道包和权益模板应由独立的幂等 bootstrap/seed 流程迁移，不应放入 Terraform。Secret 后续接入腾讯云 Secrets Manager/KMS，但不阻塞本次地域参数化。
