# Beijing Sandbox Observability

这个目录集中记录北京 `sandbox` 测试环境的可观测系统落地情况。

## Current Resources

- 托管 Prometheus / TMP
  - Region: `ap-beijing`
  - Instance ID: `prom-bt1h2qs7`
  - Name: `sandbox-prometheus-bj`
  - VPC: `vpc-21gzr2dc`
  - Subnet: `subnet-ieszm71b`
  - Retention: `30d`
  - Spec: `shared`
- 托管 Grafana
  - Region: `ap-beijing`
  - Instance ID: `grafana-bh79ibtf`
  - Root URL: `https://cloud-grafana.woa.com/grafana-bh79ibtf/`
  - SSO: `enabled`
- TMP external cluster registration
  - Cluster name: `clawhub-bj8`
  - External cluster ID: `ecls-5wh1glsl`
  - Labels: `cluster=clawhub-bj8`, `module=sandbox`

## What Was Done

1. 在腾讯云北京区创建了托管 Prometheus 实例 `prom-bt1h2qs7`。
2. 通过 external cluster 方式把现有 TKE 集群接入 TMP，而不是继续卡在原生 cluster agent 的 STS role 路径上。
3. 在集群里部署了腾讯云提供的 TMP agent / exporter 安装任务。
4. 验证 TMP 已经正常抓取基础指标。
5. 购买并创建了托管 Grafana 实例 `grafana-bh79ibtf`。
6. 把 Grafana 绑定到 TMP `prom-bt1h2qs7`。
7. 开启了 Grafana 的腾讯云账号 SSO。

## Current Status

- TMP cluster agent status: `normal`
- Ready agent count: `1`
- Grafana binding status: `bound`
- Grafana datasource integration:
  - Kind: `tencent-cloud-prometheus`
  - Integration ID: `integration-3uxxb29r`
  - Datasource UID: `prom-bt1h2qs7`

## Verified Scrape Jobs

- `cadvisor`
- `kubelet`
- `serviceMonitor/kube-system/kube-state-metrics/0`
- `serviceMonitor/kube-system/node-exporter/0`

## Installed Exporters / Agents

- `proxy-agent`
- `kube-state-metrics`
- `node-exporter`

## Grafana Access

- URL:
  - `https://cloud-grafana.woa.com/grafana-bh79ibtf/`
- Tencent Cloud console:
  - `https://console.cloud.tencent.com/monitor/grafana`
- Login mode:
  - Tencent Cloud OAuth / SSO

说明：

- 北京测试环境已经购买托管 Grafana。
- 推荐从腾讯云控制台进入，再通过腾讯云账号 OAuth 登录。

Grafana 里已经随 TMP integration 自动带入了一批预置 dashboard，当前对 `sandbox` 最有价值的是：

- `cluster-overview`
- `namespace-overview`
- `ComputeResources_Namespace(Pods)`
- `ComputeResources_Workload`
- `Networking_Namespace(Pods)`
- `k8s-deployment`
- `k8s-pod`
- `node-overview`

另外已经导入一张自定义业务总览图：

- `sandbox-overview`
  - URL: `https://cloud-grafana.woa.com/grafana-bh79ibtf/d/sandbox-overview/sandbox-overview`
  - 定义文件: `grafana/sandbox-overview.json`
- `service-gateway-overview`
  - URL: `https://cloud-grafana.woa.com/grafana-bh79ibtf/d/service-gateway-overview/service-gateway-overview`
  - 定义文件: `grafana/service-gateway-overview.json`

## What We Can Observe Now

当前已经具备的是 `sandbox` 的基础基础设施可观测性：

- 集群和节点资源用量
- `sandbox` namespace 下的 Pod / Workload 状态
- 重启次数
- CPU / 内存趋势
- HPA 副本变化

现在也已经开始具备第一批 `sandbox` 自定义业务指标：

- `sandbox_api_http_requests_total`
- `sandbox_api_http_request_duration_seconds`
- `sandbox_api_sandbox_create_total`
- `sandbox_clientproxy_http_requests_total`
- `sandbox_clientproxy_http_request_duration_seconds`
- `sandbox_clientproxy_upstream_errors_total`
- `sandbox_worker_refill_created_total`
- `sandbox_worker_refill_failures_total`
- `sandbox_worker_pool_paused_total`
- `sandbox_worker_inventory`
- `sandbox_worker_verify_failures_total`

配套的业务面板已经覆盖：

- API 请求量、状态分布、p95 延迟
- sandbox create 成功率和结果分布
- clientproxy 请求量、p95 延迟、upstream error
- worker refill created / failures / verify failures
- 按 pool / state 的库存分布
- `service-gateway` 的 route / endpoint 访问量、状态码分布、P95 延迟、Top endpoints

## How Data Reaches Grafana

这套链路不是应用直接“推送到 Grafana”，而是标准 Prometheus pull：

1. `sandbox-api / sandbox-clientproxy / sandbox-worker` 在进程内暴露 `/metrics`
2. Kubernetes 里的 `ServiceMonitor / PodMonitor` 描述“去哪里抓这些 metrics”
3. 腾讯云 TMP 在集群里发现这些 monitor 对象并执行 scrape
4. 托管 Grafana 绑定 TMP 数据源
5. Grafana 查询的其实是 TMP 里已经抓到的时序数据

当前北京 sandbox 里对应的 monitor 对象是：

- `serviceMonitor/kube-system/sandbox-api/0`
- `serviceMonitor/kube-system/sandbox-clientproxy/0`
- `podMonitor/kube-system/sandbox-worker-sharded/0`

也就是说，Grafana 能看到这些数据的前提是：

- 应用自己先暴露 `/metrics`
- TMP 能实际发现并抓到

Grafana 本身只负责展示，不负责同步。

## Dashboard Source Of Truth

当前对自定义 Grafana dashboard 的沉淀方式是：

- dashboard JSON 存 Git
- 导入脚本存 Git
- 通过 Grafana HTTP API 从集群内导入

对应文件在：

- [README.md](grafana/README.md)
- [sandbox-overview.json](grafana/sandbox-overview.json)
- [import-dashboard-via-k8s.sh](grafana/import-dashboard-via-k8s.sh)

这还不是完整 Pulumi IaC，但已经做到：

- dashboard 定义可审计
- dashboard 变更可 review
- dashboard 可重复导入
- dashboard 可回滚

## What We Still Do Not Have

当前已经有第一批 `sandbox` 业务指标和总览 dashboard，但还没有更细的深层指标，例如：

- pool waterline 告警阈值视图
- sandbox 分配端到端 latency 分位数
- reset / reinstall 生命周期耗时拆解
- clientproxy 按 sandbox / upstream 的热点视图
- 业务告警规则

## Useful PromQL For Sandbox

- Running sandbox pods:

```promql
sum(kube_pod_status_phase{namespace="sandbox", phase="Running"} == 1)
```

- Sandbox CPU usage in cores:

```promql
sum(rate(container_cpu_usage_seconds_total{namespace="sandbox", container!=\"\", image!=\"\"}[5m]))
```

- Sandbox memory working set in GiB:

```promql
sum(container_memory_working_set_bytes{namespace="sandbox", container!=\"\", image!=\"\"}) / 1024 / 1024 / 1024
```

- Sandbox pod restart count:

```promql
sum(kube_pod_container_status_restarts_total{namespace="sandbox"})
```

- Available deployment replicas:

```promql
sum by (deployment) (kube_deployment_status_replicas_available{namespace="sandbox"})
```

- Desired deployment replicas:

```promql
sum by (deployment) (kube_deployment_spec_replicas{namespace="sandbox"})
```

- HPA current replicas:

```promql
kube_horizontalpodautoscaler_status_current_replicas{namespace="sandbox"}
```

- HPA max replicas:

```promql
kube_horizontalpodautoscaler_spec_max_replicas{namespace="sandbox"}
```

## Notes

- TMP 本身已经可用，就算不看 Grafana，也能先做抓取和告警。
- 现阶段 Grafana 的价值主要是快速看基础 dashboard。
- 不要把“已经接入 TMP”误解成“已经具备 sandbox 业务监控”。
