---
id: collaboration-beijing-first-release-2026-09-15
type: task
scope: 北京测试环境Collaboration首次发布与LightVela Web交付。
triggers: ["collaboration beijing first release", "北京协作首次发布", "collaboration foundation rollout"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - argocd/services/collaboration/README.md
  - .ci/runtime/bundles/collaboration.bundle
  - scripts/ssm_manifest.collaboration.beijing-sandbox.yaml
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 0.1.0
precedence: task
derived: false
---

# Collaboration北京首次发布

## goal
在beijing-sandbox按foundation、数据库门禁、Runtime、Gateway、Web顺序完成首次交付与实际验收。

## non_goals
- 不新建DB实例，不发布上海、新加坡或Playground。
- 不增加独立Human登录，不恢复外部Computer/TAT纳管；Computer默认隐藏，Tasks/Reminders暂不开放。
- 不伪造SSM/SOPS配置，不借用未确认归属的账号、集群或其他环境凭据。
- 候选归档不等于正式客户端下发或Runtime/IM Canary通过。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户在北京首次发布步骤说明后回复“确认”，授权该环境的正常发布流程。
- 独立Collaboration逻辑库复用现有普通DB服务；不新建DB实例。
- 源码MR !4028已合入，主干候选#15已通过；后端激活必须独立验收。

## interface_refs / data_structure_refs
- collaboration/platform/v1/model-contract.yaml、openapi.yaml及已发布迁移保持不变。
- collaboration.bundle规定迁移每次运行、同镜像database verify及独立database.dsn文件挂载。
- SSM六键遵循ssm_manifest.collaboration.beijing-sandbox.yaml；IM AppID/管理员及节点池必须是真实平台配置。
- foundation和runtime描述符使用同一个Application，不能同时激活或手写leaf绕过AppSet。

## history_context
- current_design_refs: argocd/services/collaboration/README.md、docs/engineering/domains/release-gitops.md。
- relevant_evolution: !4012产品迁移、!4021 CI/Argo候选接线、!4028客户端交付与CI恢复。
- superseded_refs: 旧TAT安装/签名制品和MR候选不能作为新托管客户端正式下发依据。

## acceptance
- 云账号、实际北京控制面和现有DB来源已确认，逻辑库/账号只影响Collaboration。
- SSM六键与真实IM配置通过，SOPS artifact和foundation收敛。
- 迁移、verify、Runtime镜像pin与Argo Synced/Healthy及API健康通过。
- Gateway公共路径、LightVela Web登录和Server/Member/IM群聊私聊实际验收通过。

## affected_paths
argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml、argocd/secrets/beijing-sandbox/collaboration-runtime-secrets.sops.yaml、argocd/services/collaboration、Gateway激活配置及OpenCraft产品发布目标。

## required_context
release-gitops、agent-gateway-runtime、service-collaboration；触及Gateway/Web前按各服务重新路由。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| docs/context/domains/release-gitops.md@2.0.0 | 发布边界 | 源码、GitOps、live状态分离 |
| docs/context/domains/agent-gateway-runtime.md@2.1.0 | 公共入口 | 不以直连代替Gateway验收 |
| docs/context/project/services/collaboration.md@1.0.0、collaboration/AGENTS.md | 契约边界 | 不修改模型、身份或迁移历史 |
| .ci/AGENTS.md、argocd/services/collaboration/README.md | 首次发布 | foundation先于DB门禁和Runtime |
| .ci/runtime/bundles/collaboration.bundle、scripts/ssm_manifest.collaboration.beijing-sandbox.yaml | 门禁与密钥映射 | 不输出密钥或绕过必填配置 |
| docs/context/project/adjacency/argocd-ci-secrets.md、argocd/README.md | 控制面定位 | 只参考现有入口，不混用其他集群 |

## evidence
- 用户提供本次操作凭据后，采用本任务用户消息→本机内存→已验证SSH→DevCloud内存查询，不输出或生成凭据文件、不改默认云profile。安全读入/拒绝助手来源/拒绝凭据回显的3项回归通过。
- 新凭据准确找到北京admin-gateway和CTL的既有SSM，Collaboration SSM不存在；此前default.credential视角不是目标发布凭据的证据，不能继续用其空查询判定目标状态。
- 源码importplan的cynosdbmysql-3dh7jyee已实测running、MYSQL、8.0；可复用DB实例已定位，但尚未创建逻辑库或账号。
- 新增兼容性阻塞：当前bundle的迁移/verify为tdsql，已发布迁移包含专用shardkey选项，ComparePhysical要求物理shardkey；普通MySQL实例不能直接使用该路径。需先设计、实现并审阅普通MySQL部署/迁移/校验支持，禁止直接改写已发布TDSQL SQL/摘要。
- 用户确认补齐MySQL路径：新增显式mysql Adapter、由冻结TDSQL来源确定性派生且追加发布的MySQL迁移线、无Proxy topology/allsets的严格结构审计；逻辑路由和物理复合PK/索引/字符语义保留，owner claim/逐语句CAS/unsafe拒绝复用。CLI、Runtime、DB Job和bundle必须一致选择mysql。
- MySQL兼容实现当前有9个迁移SQL、9个来源绑定文件与atlas.sum，release lock只追加9个mysql-runtime条目；可信master lock对账通过。所有MySQL迁移均无物理shardkey选项。
- 聚焦config/adapter/migration/schema/CLI/K8s与9项Collaboration CI契约测试通过；最终工作树上的完整`go test -p 2 ./...`、受影响包`go test -race`与完整`go test -race -p 2 ./...`、`go vet ./...`、生成物/OpenAPI/MySQL/TDSQL/可信master migration release门禁和CI runtime537项通过。
- 首轮无并行限制`go test ./...`有1项既有IM路径顺序测试失败，隔离10次仍偶发；`-p 2`完整测试与race通过。本次不修改IM实现或跳过测试。
- 真实MySQL集成测试已新增并以`CHATSERVER_TEST_MYSQL_DSN_FILE`隔离，当前未创建逻辑库，故尚未运行真实迁移闭环。
- 通过DescribeClusterSecurity只在内存获取已有访问材料，不新建客户端证书；目标工作负载集群读取北京Argo根应用返回missing_crd，控制面仍需独立定位，未恢复Argo登录。
- !4028合入master，4216ff19773c246d2f7a05fd93abfe9af70058cd；主干#15校验、构建、归档成功。
- 已拉取GitOps中Collaboration active catalog和SOPS artifact均缺失；这不证明实际DB或目标账号SSM状态。
- DevCloud SSH可用。9.208.245.238既有Argo CLI四会话均expired；尚未恢复登录。
- 该机器default.credential的北京视角中，指定Collaboration及已有admin-gateway、CTL映射的DescribeSecret均ResourceNotFound；区域集群名称无法匹配目标环境。账号/控制面归属未证明，不能直接新建资源。
- 已有HK配置未定位到预期北京根应用或对应端口服务，不将其当作目标北京集群。
- 未调用可能首次生成长期客户端证书的DescribeClusterKubeconfig；未创建DB、Secret、密钥或激活GitOps。

## risks
错误账号写入、跨环境密钥复用、未验证迁移和暴露未就绪API。先确认目标账号/集群、分阶段门禁，保留原服务配置与镜像pin；不靠临时live修补取得表面成功。

## validation
本地代码门禁已通过；docs-impact命中release-gitops并要求Owner复核。Context仍833条既有错误，本Task Pack为0；Context tests26项同样4项既有失败，Audit tests33项通过。真实MySQL闭环、Stream构建与发布门禁须在MR流程继续。DB门禁由受控Job执行，发布后观察Argo revision/镜像/健康及浏览器实际行为。

## decisions
用户已授权beijing-sandbox首次发布及普通MySQL兼容实现；凭据归属已通过既有SSM验证。代码和发布配置先经测试、MR与Owner审阅，再创建数据库资源；控制面与IM仍待核实。不通过新建TDSQL实例或修改历史迁移违背原定普通DB要求。

## scan_scope
DevCloud已登记SSH入口、既有Argo context元数据、TC profile字段元数据、北京区域精确SSM名称和TKE集群元数据；不扫描或输出凭据值。

## scan_output
隔离进展记录：.omx/plans/vela-checkout-repair/。只记录状态和错误码，无密钥值。

## handoff
普通MySQL兼容源码与本地验证完成，未提交/推送。下一步提交MR并由Owner复核；合入和真实Linux镜像验证后才创建独立逻辑库/账号/SSM、运行真实MySQL闭环并推进foundation。云资源、默认profile、现有DB与Secret均未修改。
