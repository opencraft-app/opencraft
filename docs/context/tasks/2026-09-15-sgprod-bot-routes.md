---
id: sgprod-bot-routes-20260915
type: task
scope: 国际站OpenCraft多Bot管理所需公共网关路由。
triggers:
  - sgprod bot routes
  - 国际站多Bot接口
  - route_not_allowed bots
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - argocd/services/service-gateway/sgprod/config.yaml
  - service-gateway/internal/gateway/config_policy_test.go
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
国际站放行OpenCraft的Bot列表、创建/克隆、重命名和删除请求。
## non_goals
不开放额外渠道绑定/retry接口，不修改国内策略，不改变鉴权/归属/实名、不销毁或创建真实Bot。
该路由任务的发布授权仅限 sgprod service-gateway Bot 路由，不扩展为其他 OpenCraft 改动的发布授权。以下 checkpoint 记录不同候选时点，不代表本次合并的实时部署状态。
## requirement_ids / requirement_refs / requirement_excerpt
用户在明确国际站route_not_allowed原因后要求“那你搞一下”。
## interface_refs / data_structure_refs
GET/POST /v1/instances/{instance_id}/bots；PUT/DELETE /v1/instances/{instance_id}/bots/{bot_id}。
ctl/main/api/server.go及ctl/pkg/instance/bots.go提供既有实现；创建仍由MULTI_BOT_ENABLED控制。
## history_context
current_design_refs：docs/engineering/domains/agent-gateway-runtime.md；国内已经列入Bot路由，国际config_policy_test仍要求baseWant。
relevant_evolution：OpenCraft已实现Bot管理及Main IPC白名单；真实国际站GET仍返回404 route_not_allowed。
superseded_refs：无。
## acceptance
生产配置驱动的真实gateway handler测试覆盖四个method/path、认证失败、归属错误透传及相邻路由拒绝；方法集合支持PUT；CTL对应测试通过。
## affected_paths
argocd/services/service-gateway/sgprod/config.yaml、service-gateway/internal/gateway/*test.go、正式领域文档。
## required_context
agent-gateway-runtime、site-environment-routing、control-plane-ops、service-service-gateway。
## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| docs/context/domains/agent-gateway-runtime.md | must_read | 公共路径验收 |
| docs/context/domains/site-environment-routing.md | must_read | 双站独立策略 |
| docs/context/project/services/ctl.md | must_read | 上游契约 |
| docs/context/project/services/service-gateway.md | must_read | 网关归属 |
| service-gateway/AGENTS.md | service | Argo发布边界 |
| ctl/AGENTS.md | service | 上游测试 |
| argocd/apps/sgprod/README.md | 生产overlay | gitops批准与手动sync |
| docs/context/project/adjacency/argocd-ci-secrets.md | 邻接检查 | 检查sgprod kustomization及bundle测试 |
## evidence
前次实机：登录有效、实例列表200，嵌套Bot列表404/error=route_not_allowed；本机kubectl仅有orbstack上下文，未确认线上CTL版本。
当前只读GET https://api.lightvela.ai/v1/frontend/runtime-config返回multiBotEnabled=true。
红测试复现原配置拒绝所有Bot请求；补4条path+PUT后聚焦gateway与CTL Bot接口测试通过。ConfigMapGenerator直接引用config.yaml。
## risks
只改method集合不改path_allow仍失败；过宽放行会暴露额外接口；源码支持不等于线上CTL已部署。
## validation
go test ./...、go vet ./...（service-gateway）；CTL Bot接口聚焦测试；文档/变更影响/manifest配置检查。
## decisions
仅增加OpenCraft已接入的四个method/path，保留国内额外渠道路由；Host/控制面管理所有权不变。
## scan_scope
service-gateway配置/handler测试、ctl Bot路由/测试；无凭据扫描或生产写入。
## scan_output
无匹配生成器：.ci/runtime、infra_pulumi中未找到Bot路由模板；当前已记录权威为deploy-facing config。
## handoff
可审阅配置与验证完成：service-gateway全量go test/go vet、CTL Bot聚焦测试、86项release bundle契约、33项context-audit测试通过。
文档与diff检查通过；根context仍有既有frontmatter/中文/budget等校验失败，新Task没有命中。
提交/生产发布尚未执行；下一步需明确提交/发布授权，并在可访问sgprod Argo的执行环境落地、验证公共GET Bot接口。
## checkpoint
### 源码与 GitOps 候选阶段
发布授权已确认。基于最新origin/master隔离工作区应用最小补丁，保留后来增加的Credit路由；gitops候选将独立从最新origin/gitops生成。
在最新master隔离复验：网关全量测试有两项sandbox-jp-1既有配置失败；未修改的同一baseline复现相同失败。
sgprod Bot/实例/原生登录部署策略测试及go vet通过。Argo现存CLI登录token过期，正在确认可用运维入口，未执行生产sync。

### 分支记录的后续检查
2026-09-15 21:41 CST：用户提供有效Argo凭据并授权同步。预检Argo已读取gitops b9dcb6bf6，OutOfSync仅新ConfigMap及引用它的service-gateway Deployment，镜像未变。
执行`argocd app sync service-gateway-sgprod --timeout 300`成功（8s），随后wait --sync --health成功；最终revision b9dcb6bf6、Synced/Healthy，Deployment Healthy。
重启保留国际站登录态的OpenCraft预览重新协商Host，Bots页面10秒内从“确认云端Agent”收敛为真实列表，显示New Bot且新建/刷新可用。未执行Bot创建、重命名或删除。
2026-09-15发布阶段：用户授权已确认。隔离工作区基于最新master保留Credit路由，只提交本任务5文件，commit 6c3315d90，源码MR !4037（ID27261080）。
工蜂合入返回Review check not passed/409，未绕过审核、未直推master。
独立gitops候选从origin/gitops 404c37377生成，仅1配置文件5新增1替换，commit a1c6f07ee，MR !4038（ID27261105）。尚未合入gitops或执行sync。
Argo运维入口9.208.245.238上CLI可用，但127.0.0.1:32059及9.208.245.238:30547认证均返回token expired，不能确认live drift或同步。
源码最新baseline新增两项sandbox-jp-1既有测试失败，干净baseline复现；sgprod聚焦/go vet通过。
阻塞：需要MR评审通过和有效Argo登录；未修改线上配置或云端Bot。候选链接：https://git.woa.com/wisp/mono2/-/merge_requests/4037 和 https://git.woa.com/wisp/mono2/-/merge_requests/4038。
配置已补齐，部署配置驱动的网关测试覆盖四路由、clone载荷、成功/403透传、匿名和实名拒绝及相邻未开放接口。
CTL路由/profile聚焦测试通过，gateway全量测试与vet通过，release bundle契约86项通过。
未提交、未推送、未执行Argo sync；生产变更仅为预备配置差异。

## release_candidate
仅sgprod service-gateway config变动：顶层实例methods增加PUT，path_allow新增4条精确CRUD路由。
现有gateway代码可处理配置，不需要修改路由算法；当前公开运行时开关multiBotEnabled=true，但实际CTLBots接口尚未经生产网关验证。
发布时需把配置合入gitops并按sgprod手动sync流程生效，核对Argo revision、Synced/Healthy及国际站GET bots成功；禁止仅凭本地测试标记线上修复。
回退仅撤回这4条path及本次PUT方法增量，不改账户、实例数据或其他环境。
