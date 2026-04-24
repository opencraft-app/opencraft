# Observability Collaboration Rules

本目录记录北京 `sandbox` 测试环境的可观测系统现状、约束和后续演进信息。

## Scope

- 这里记录的是 `test / beijing / sandbox` 环境下的可观测资源和约定。
- 当前以腾讯云托管能力为主：
  - TMP / 托管 Prometheus
  - 托管 Grafana
  - TKE 集群默认 exporter

## Documentation Rules

- 任何对北京 sandbox 可观测系统的变更，都应同步更新本目录文档。
- 至少更新以下一种信息：
  - 资源清单
  - 接入状态
  - 访问入口
  - 已验证的指标/看板
  - 已知限制和未完成事项
- 不要只把结论留在聊天记录里。

## Current Architecture Expectations

- 对 `sandbox` 的基础监控，优先依赖腾讯云托管产品，而不是自建 Prometheus/Grafana。
- 当前默认数据面是：
  - 托管 Prometheus 抓取 TKE 基础指标
  - 托管 Grafana 绑定 TMP 作为数据源
- `sandbox` 业务指标如果要纳入可观测体系，应由应用主动暴露 Prometheus `/metrics`，不要只依赖 Pod/Node 基础指标。
- 自定义 Grafana dashboard 默认采用 `JSON in Git + API import`，不要只在 Grafana UI 里手工编辑后不回写仓库。

## Change Checklist

- 新增或修改监控资源时，记录：
  - 地域
  - 实例 ID
  - 网络信息
  - 绑定关系
  - 登录/访问方式
- 新增告警或 dashboard 时，补充：
  - 查询语句或规则名
  - 适用模块
  - 关键阈值
  - 如果是 dashboard，补 JSON 定义和导入方式
- 如果是云侧阻塞问题，记录真实错误码和处理结论。

## Guardrails

- 不在文档里写明文云账号长期密钥。
- 若引用控制台入口或云 API 返回值，优先记录资源 ID 和官方访问入口。
- 不把“基础 K8s 指标”描述成“已经具备业务监控”。
