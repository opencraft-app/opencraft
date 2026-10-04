# 平台 CLS 日志

这里是平台错误诊断声明，不是用户日志产品，也不参与 Actor/FDB 准入真值。
源码默认关闭云资源创建，不会自动安装采集器、打开 Argo 同步或收集现有旧 API 镜像。

## 所有权与范围

- management Terraform 的 `platform_cls_enabled` 默认 `false`；显式启用后创建独立日志集、
  Workers API 错误 topic 和有限字段索引，默认标准存储保留 7 天，可配置整数 1–30 天。
- Terraform 拥有日志集/topic 生命周期、保留期、分区与索引；不启用匿名写、自动分裂、
  自动索引或全文索引。固定分区和保留期限制成本，但不是请求量或总账单的硬上限。
- `platform_cls_binding` 是独立 credential-free output，不改变严格 bootstrap inventory。
- LogConfig 只引用精确 topic/logset ID，拥有容器选择及 JSON/级别解析，不按名字创建资源。
  根据[官方 LogConfig 文档](https://cloud.tencent.com/document/product/457/111541)，
  各 topic/index 创建参数用于自动创建路径；本规则仍全部省略，以免形成模糊所有权。
- 首条规则只选择 C 集群的 `workers-api-system / Deployment workers-api / Container workers-api`，
  不采集 runtime/workerd、用户 console、其他容器、节点文件或容器文件。
- 仅标准 JSON 的 WARN/ERROR，解析失败不上传，从启用后的增量日志开始，不回溯旧输出。
  Pod 标签与元数据也是显式白名单，不能改成 allContainers、通配或 namespace 全选。

## 源日志边界

Workers API 使用 `NewPlatformLogger`：只允许代码固定的错误类，原始 error、未知分类字符串
都被替换。net/http 使用 `PlatformHTTPErrorLog`：panic 内容、堆栈和 TLS 文字被丢弃，
只保留有限 HTTP 错误类和 public/internal listener。消息必须是代码常量；这不是任意字段
脱敏器，新增字段仍需审计。request ID 是有界相关标识，不是可信租户身份。

真实 TCP panic、POST 断连、stream 截断和实际 CLI 启动失败回归证明相应边界；它们不证明
整个 Go 进程的所有 stderr 都为结构化日志。flag/runtime 的非 JSON 输出不得作为日志兜底上传。
旧云镜像尚未含这些源码改动，因此不能仅因 renderer 通过就对它开启采集。

## 本地验证与渲染

```sh
python3 -m unittest discover -s infra/cells/deploy/tencent/fleet/observability/cls -v
ACTOR_TERRAFORM_BIN=/absolute/verified/terraform \
ACTOR_TERRAFORM_PLUGIN_DIR=/absolute/provider-mirror \
bash infra/cells/deploy/tencent/fleet/observability/cls/test-terraform.sh

# 仅输出声明，不调用 Kubernetes、云 API 或 Git。
python3 infra/cells/deploy/tencent/fleet/observability/cls/render.py \
  --binding /protected/platform-cls-binding.json \
  --expected-cluster-id cls-exactcluster
```

Terraform 测试用原生 mock provider 只做 plan/schema/参数边界检查，复制当前生产 `cls.tf`，
不配置 backend、不执行云 apply；不是云 API 或 agent 兼容性证据。管理模块另需用独立
TF_DATA_DIR 做 `init -backend=false` 和 `validate`，不要接旧 COS state 来做本地检查。

## 待上线接线

只有现有 operation lock 空闲后，才能独立执行：

1. 验证新 Workers API 镜像包含日志安全实现，按已有发布链部署，不重编未改动的 workerd。
2. 实际查询 TKE 日志 addon 版本/精确镜像，确认 CRD、metadata 白名单和 JSON 过滤兼容。
   当前源码不猜测 addon 版本，不自动使用 latest，也不创建第二套自研采集 agent。
3. Terraform 显式开日志资源，导出 binding；核对 live cluster UID、topic/logset/region 归属。
4. 将生成 LogConfig 纳入独立中央 Argo desired state，限定其 cluster-scoped 权限；Topic ID
   不可原地改绑，不能通过 delete/recreate 继承不相关规则。
5. 用无敏感值的相关 ID 注入受控平台失败，查询 exact topic；证明 WARN/ERROR 可查且
   INFO、解析失败、其他容器日志不进入 topic。保留 Argo revision、镜像、CRD 与查询 receipt。

renderer 的 annotation 只是声明，不是 live UID 或安全镜像的证明。本轮没有实现安装/发布
入口或完成上述云 gate；不得把 Terraform validate 或本地测试当成 CLS 已上线。
