# 平台 CLS 日志

这里是平台错误诊断声明，不是用户日志产品，也不参与 Actor/FDB 准入真值。
源码默认关闭云资源创建，不会自动安装采集器、打开 Argo 同步或收集现有旧 API 镜像。

## 所有权与范围

- management Terraform 的 `platform_cls_enabled` 默认 `false`；显式启用后创建独立日志集、
  Workers API 错误 topic 和有限字段索引，默认标准存储保留 7 天，可配置整数 1–30 天。
- Terraform 拥有日志集/topic 生命周期、保留期、分区与索引；不启用匿名写、自动分裂、
  自动索引或全文索引。固定分区和保留期限制成本，但不是请求量或总账单的硬上限。
- `platform_cls_binding` 是独立 credential-free output，不改变严格 bootstrap inventory。
- `platform_cls_collector_enabled` 也默认 `false`，开 topic 不隐式安装 collector；开 collector
  必须同时声明 topic/index。management Terraform 只拥有 C 的官方 `tke-log-agent` addon，
  TKE addon manager 拥有其工作负载/CRD，Argo 只拥有另外准入的 LogConfig，不创建第二套 agent。
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

### API server 规则往返检查

collector/CRD 安装就绪后，先运行独立 `preflight-rule.py`，再考虑首次 canary：

```sh
python3 infra/cells/deploy/tencent/fleet/observability/cls/preflight-rule.py \
  --binding /protected/platform-cls-binding.json \
  --expected-cluster-id cls-exactcluster \
  --expected-kube-system-uid <reviewed-C-kube-system-namespace-uid> \
  --kubeconfig /protected/management.kubeconfig
```

入口在前后重新读取 `kube-system` Namespace UID，检查 exact cluster-scoped、served v1、
Established/NamesAccepted 的 LogConfig CRD，再执行 `kubectl create --dry-run=server
--validate=strict`，之后复核 CRD UID/定义/status 不变且未进入删除。不 apply/patch/delete
规则，也不读取日志或 Secret。已有同名规则会令
create 冲突并拒绝，不能自动替换现有采集规则。所需 create 权限仅用于 server dry-run；
如果 admission webhook 不支持 dry-run，检查失败，不降级到 client dry-run 或真实创建。

返回对象必须保留完整 spec 和精确名称/annotations；过滤、metadata 白名单、topic 绑定
被裁掉、改写或扩大都拒绝。server metadata/status 不当作规则语义。只输出固定身份/hash
与时间，不输出 API server stderr、完整 CRD 或任意响应字段。回执明确为
`server-side-logconfig-roundtrip-only`、`collectionAdmission=unqualified`、
`canaryAuthorized=false`。这不是 addon 行为、topic 归属、API 安全镜像、Argo 或 CLS 查询
资格；expected UID/kubeconfig 必须由可信管理发布链提供，文件本身不能证明云 cluster ID。
首次 canary 前仍需实时复核这些独立门禁。CLI 协议 double 只验证请求顺序和拒绝路径，
不代表已在真实 TKE 执行；本轮没有执行云 dry-run 或开启采集。

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

renderer 的 annotation 只是声明，不是 live UID 或安全镜像的证明。本轮没有执行安装/发布
或完成上述云 gate；不得把 Terraform validate 或本地测试当成 CLS 已上线。

### 固定官方 collector 的可重建声明

management `cls.tf` 已包含默认关闭的 addon resource，固定 chart `1.1.25` 和三个官方
registry manifest digest，关闭默认 Kafka listener、alternate rule controllers 和自动创建 role。
当前北京 catalog 在 `other` 下列出此 addon；只查 `Kind=log` 会得到空列表。
`DescribeAddonValues` 在未安装时也返回非空 Values，不能以此证明安装完成，必须核对
`DescribeAddon` 和实际 Kubernetes 资源。白名单证据见
[北京官方组件观察](evidence/beijing-collector-discovery-20261004.json)。

开启条件是受锁审核的完整 management plan/apply，不是另一条 tccli 安装路径：

```hcl
platform_cls_enabled           = true
platform_cls_collector_enabled = true
```

这两项是显式部署意图，不是本轮已 apply。旧严格 bootstrap inventory 和 topic binding
不加字段，另出 `platform_cls_collector_binding`，始终 `unqualified/canaryAuthorized=false`。
RawValues 为 JSON，provider `1.83.11` 的
[create/update 实现](https://github.com/tencentcloudstack/terraform-provider-tencentcloud/blob/v1.83.11/tencentcloud/services/tke/resource_tc_kubernetes_addon.go)
自行做 base64，不能二次编码；[官方 InstallAddon](https://cloud.tencent.com/document/product/457/94181)
明确不传版本会安装最新版本。三个 tag-plus-digest 都固定，不能只信 chart 版本或 bare tag。
[Kubernetes 镜像规则](https://kubernetes.io/docs/concepts/containers/images/#image-names)允许
同时携带 tag/digest 并按 digest 拉取；这不能证明 addon chart 会保留传入的 tag 字符串。

实际 skopeo registry manifest 读取已通过；没有镜像 cold pull、容器执行或 TKE 安装。
必须在探索发布中证明 chart 保留 tag-plus-digest、Pod 使用预期实际镜像、addon/CRD就绪，
再跑前述 server rule roundtrip 和真实 CLS canary。native mock test 只核对生产声明与归档
catalog/manifest pins、默认关闭、字段和前置条件，不证明这些云行为。Addon 删除或升级也
必须持整段 operation lock，先停止/处置实际规则，不能靠禁 Argo sync 假定采集已停止。

## 独立中央 Argo 发布准备

`render.py --format json` 可生成单份 `logconfig.json`，保持 YAML 默认输出不变。
候选规则放在中央既有 desired Git 的 `management/cls/<managementId>/logconfig.json`，
不放入 Workers API 工作负载目录。`render-gitops.py` 从调用者选定的可信本地 clone 读取
指定完整 commit，核对 origin 身份、regular blob、64 KiB 上限、唯一 JSON 字段及规则全文。
不读取脏工作树、不追踪 main/HEAD、不接受 symlink，不执行 fetch/checkout/push。

```sh
# 要先在已有发布流程中取得候选 commit 和其本地 clone。本命令只输出准备声明。
python3 infra/cells/deploy/tencent/fleet/observability/cls/render-gitops.py \
  --repository-dir /protected/central-desired-clone \
  --revision <full-reviewed-candidate-commit> \
  --binding /protected/platform-cls-binding.json \
  --expected-cluster-id cls-exactcluster
```

生成独立 AppProject/Application：只允许精确同名的 cluster-scoped `LogConfig`，所有
namespaced 资源拒绝，固定 C 的 in-cluster destination；Application 固定 Git revision，
非递归且只解析 `logconfig.json`，不包含其他文件、agent、CRD、Secret 或 runtime。
资源 name 限制依据基座锁定的
[Argo v3.5.2 实现](https://github.com/argoproj/argo-cd/blob/v3.5.2/pkg/apis/application/v1alpha1/types.go)，
文件过滤使用[官方 directory include 机制](https://argo-cd.readthedocs.io/en/stable/user-guide/directory/)。
旧 Argo 不得忽略未知 name 字段后继续安装，实际版本/CRD仍需上线核验。

准备声明明确为 `collection-admission=unqualified`，自动同步、自愈、prune 默认关闭，
不加级联删除 finalizer。Project 还用同名 `clusterResourceBlacklist` 拒绝自己的 LogConfig：
只禁用 auto-sync 无法防止手工 Sync；独立 deny 不依赖 Application 的同步选项或时钟。
判定依据[Argo v3.5.2 的资源权限实现](https://github.com/argoproj/argo-cd/blob/v3.5.2/pkg/apis/application/v1alpha1/app_project_types.go)。
本入口没有放行开关，不是安全镜像/agent/云身份/查询验证器；能够修改 Project 的管理员仍能
改变策略。origin 字符串与 annotation 不证明 clone 来源或集群 UID；可信发布链、实际
精确版本和实时重新核对不可省略，当前测试不是实际 Argo Sync 拒绝回执。

真实发布不能形成“先查 CLS、才能第一次采集”的死循环。顺序是前置门禁通过后，在同一
整段 operation lock 内受控放行 canary，再验证正反查询，最后才晋升自动自愈。canary 失败
必须停止实际规则或恢复之前已验证的规则；重新加回 Project deny 只阻止后续同步，不会
停止已存在 LogConfig 的采集。这里尚未实现 canary 发布器或故障清理，不授权手工绕过。
后续还要将 LogConfig discovery 纳入仅 C 的 Argo resource inclusions，并在整段 operation
lock 内证明规则归属与正反查询，再通过正式发布打开自愈。当前没有修改共享 Argo policy。
