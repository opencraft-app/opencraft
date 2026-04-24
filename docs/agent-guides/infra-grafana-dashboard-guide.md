# Sandbox Grafana Dashboard 管理指引

本文件描述北京 sandbox 测试环境的 Grafana Dashboard 管理方式。Agent 在新增、修改或导入 Dashboard 时，应先阅读本文件。

## 1. 整体架构

北京 sandbox 使用腾讯云托管 Grafana（实例 ID `grafana-bh79ibtf`），通过 VPC 内网访问。

| 组件 | 说明 |
|------|------|
| 托管 Grafana | `https://cloud-grafana.woa.com/grafana-bh79ibtf/` |
| Grafana 内网管理地址 | `http://10.15.230.21:8080` |
| 数据源 | 托管 TMP Prometheus，UID `prom-bt1h2qs7` |
| TKE 集群 | 通过 `.secret/cls-8gnhos9p-config` kubeconfig 访问 |

Dashboard 管理采用 **Dashboard JSON in Git + 脚本导入** 模式，尚未升级到 Pulumi 管理。

## 2. 文件布局

```
mono/
├── .env                          # 导入脚本的环境变量（密码等，不入 Git）
├── import-sandbox-grafana-dashboard.sh  # 外层封装脚本（读 .env + 调底层脚本）
└── infra_pulumi/observability/beijing-sandbox/grafana/
    ├── README.md                  # 本目录说明
    ├── import-dashboard-via-k8s.sh  # 底层导入脚本（通过 K8s Pod 调 Grafana API）
    ├── sandbox-overview.json      # sandbox 总览 Dashboard
    ├── service-gateway-overview.json  # service-gateway Dashboard
    └── ctl-overview.json          # CTL Dashboard（合并自下面两个本地模板）
```

CTL Dashboard 的本地源文件：

```
ctl/deploy/grafana/dashboards/openclaw-overview.json   # API、实例、沙箱、Go runtime
deploy/grafana/dashboards/openclaw-overview.json        # 任务、Bypass 补偿、DB/Redis 连接池
```

`ctl-overview.json` 是两者合并 + datasource/namespace 适配后的托管版本。修改本地模板后需同步更新。

## 3. Dashboard JSON 适配规则

从子项目（如 `ctl/deploy/grafana/dashboards/`）复制 Dashboard JSON 到 `infra_pulumi/observability/` 目录时，必须做以下适配：

### 3.1 Datasource UID

子项目本地开发用的 datasource UID 通常是 `"prometheus"`，托管环境的 UID 是 `"prom-bt1h2qs7"`。

**必须替换所有出现的 datasource UID**：

```json
// 本地开发
"datasource": { "type": "prometheus", "uid": "prometheus" }

// 托管环境
"datasource": { "type": "prometheus", "uid": "prom-bt1h2qs7" }
```

### 3.2 Namespace 过滤

本地开发环境通常不需要 namespace 过滤（只有一个服务在跑），但托管 TMP 采集整个集群的 metrics，**必须在 PromQL 中加 `namespace="<ns>"` 过滤**：

```promql
# 本地开发（无 namespace 过滤）
sum(openclaw_instance_total{status="Running"})

# 托管环境（加 namespace 过滤）
sum(openclaw_instance_total{namespace="ctl", status="Running"})
```

**所有 `expr` 中的 metric 都要加**，包括：
- 有标签选择器的：在 `{}` 内追加 `namespace="<ns>"`
- 无标签选择器的：添加 `{namespace="<ns>"}`
- 出现在 `rate()`、`histogram_quantile()` 等函数内的 metric 同样要加

### 3.3 Dashboard 命名规范

title 和 uid 统一使用小写加横杠格式，与文件名一致：

| 文件名 | title | uid |
|--------|-------|-----|
| `sandbox-overview.json` | `sandbox-overview` | `sandbox-overview` |
| `service-gateway-overview.json` | `service-gateway-overview` | `service-gateway-overview` |
| `ctl-overview.json` | `ctl-overview` | `ctl-overview` |

### 3.4 其他字段

- `"id": null` — 保持 null，Grafana 会自动分配
- `"overwrite": true` — 导入时由脚本自动包装，JSON 里不需要

## 4. 导入流程

### 4.1 前置条件

- `.env` 文件存在于仓库根目录，包含：

```bash
SANDBOX_GRAFANA_KUBECONFIG=/path/to/.secret/cls-8gnhos9p-config  # TKE kubeconfig
SANDBOX_GRAFANA_PASSWORD=xxx                                       # Grafana admin 密码（必填）
```

- `kubectl` 和 `jq` 已安装
- kubeconfig 对应的集群可达

### 4.2 执行导入

```bash
# 从仓库根目录执行，默认导入 sandbox-overview.json
./import-sandbox-grafana-dashboard.sh

# 指定 Dashboard 文件
./import-sandbox-grafana-dashboard.sh infra_pulumi/observability/beijing-sandbox/grafana/ctl-overview.json
```

### 4.3 导入原理

Grafana 管理地址只有 VPC 内网可达，无法从开发机直接访问。导入链路为：

```
开发机 --kubectl run--> TKE 集群创建临时 curl Pod --> Pod 在 VPC 内网 POST Grafana API --> Pod 自动删除
```

脚本做了以下事情：

1. 用 `jq` 把 Dashboard JSON 包装成 `{dashboard: <json>, folderId: 0, overwrite: true}`
2. Base64 编码后通过环境变量传入 Pod
3. `kubectl run` 创建临时 `curlimages/curl` Pod（`--rm -i --restart=Never`）
4. Pod 内解码并 `curl POST` 到 `$GRAFANA_URL/api/dashboards/db`
5. Pod 执行完自动删除

### 4.4 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `connection refused localhost:8080` | kubeconfig 未配置或指向错误集群 | 检查 `.env` 中 `SANDBOX_GRAFANA_KUBECONFIG` 路径 |
| `SANDBOX_GRAFANA_PASSWORD is required` | `.env` 缺少密码 | 补充密码到 `.env` |
| Pod 创建失败 | namespace 不存在或无权限 | 确认 `K8S_NAMESPACE` 和 kubeconfig 权限 |
| Dashboard 导入成功但看不到数据 | datasource UID 错误或 namespace 过滤缺失 | 按 3.1 和 3.2 检查 |

## 5. 新增 Dashboard 的 Checklist

当需要为新服务添加 Dashboard 时：

- [ ] 从子项目 `deploy/grafana/dashboards/` 复制 JSON 到 `infra_pulumi/observability/beijing-sandbox/grafana/`（若有多个源 JSON 需先合并）
- [ ] title 和 uid 使用小写横杠格式，与文件名一致（如 `ctl-overview`）
- [ ] 替换所有 datasource UID：`"prometheus"` → `"prom-bt1h2qs7"`
- [ ] 所有 PromQL 表达式添加 `namespace="<ns>"` 过滤
- [ ] 确认 JSON 格式有效（`python3 -c "import json; json.load(open('xxx.json'))"`）
- [ ] 更新 `infra_pulumi/observability/beijing-sandbox/grafana/README.md` 的 Files 部分
- [ ] 执行导入脚本
- [ ] 登录托管 Grafana 确认面板有数据

## 6. 未来演进

当前是脚本导入模式，后续条件具备时可升级：

1. **Grafana service account token** 稳定后 → 脚本直接调 API，不再需要 K8s Pod 跳板
2. **Terraform/OpenTofu provider** 适配后 → Dashboard 定义纳入 IaC，与云资源统一管理
