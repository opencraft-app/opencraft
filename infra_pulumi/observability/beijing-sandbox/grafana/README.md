# Sandbox Grafana Dashboards

北京 sandbox 测试环境的 Grafana Dashboard 定义。

## Files

| 文件 | 说明 |
|------|------|
| `sandbox-overview.json` | sandbox 总览 |
| `service-gateway-overview.json` | service-gateway 入口流量、状态码、延迟 |
| `ctl-overview.json` | CTL 服务监控（API、实例、沙箱、任务、Bypass、连接池） |
| `import-dashboard-via-k8s.sh` | 通过 K8s 临时 Pod 调 Grafana API 导入 |

## Quick Start

```bash
# 从仓库根目录执行（需要 .env 配置好 KUBECONFIG 和密码）
./import-sandbox-grafana-dashboard.sh infra_pulumi/observability/beijing-sandbox/grafana/ctl-overview.json
```

## Notes

- `ctl-overview.json` 中的低频事件面板（实例创建、沙箱 API、异步任务、补偿任务、远程命令）默认使用 Grafana 的 `$__rate_interval`，避免固定 `5m` 窗口在大时间范围下过于敏感。
- 对于当前完全没有样本的指标，上述面板会回退显示 `0` 而不是 `No data`，便于区分“暂无事件”与“查询/数据源故障”。
- `ctl-overview.json` 已包含 `Churn Guard / Pool Pressure` 分区，用于观察创建拦截命中率、候选池库存结构以及当前全局压力水位。导入托管版时需要确认 PromQL 已带 `namespace="ctl"` 过滤。
- 新增的池压力面板依赖 `openclaw_instance_pool_pressure_*` 和 `openclaw_instance_churn_guard_*` 指标。若面板为空，优先检查 `ctl-bypass` 是否启用了 `checkPoolPressure` 周期任务，以及 API/Service 进程是否已注册新指标。

## 详细指引

Dashboard 适配规则、导入原理、命名规范、常见问题等，见 [infra-grafana-dashboard-guide.md](../../../../docs/agent-guides/infra-grafana-dashboard-guide.md)。
