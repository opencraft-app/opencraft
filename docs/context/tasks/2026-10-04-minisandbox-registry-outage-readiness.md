---
id: minisandbox-registry-outage-readiness-2026-10-04
type: task
scope: Registry故障时保留已有Object缓存服务，新解析仍fail closed。
triggers: ["Registry故障就绪", "Object缓存降级", "API依赖摘流"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/workersapi/api.go
  - minisandbox/infra/cells/internal/workersapi/registry_outage_test.go
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进完整stateless/DO方案的Registry故障边界：缓存命中的已有Object保持服务，新建和缓存
miss仍依赖权威Registry，失败不改变placement。就绪不能把共享依赖故障变成全局摘流。
不改云资源、原strict10k任务、36h等待窗口，不编译workerd，不声称生产故障资格完成。

## requirement_ids / requirement_refs / requirement_excerpt

正式设计2026-09-22-stateless-workers-durable-object-routing.md典型故障表要求Registry/FDB
不可用时cache hit的已有Object可继续，新建/cache miss fail closed。公共Deployment中的
readinessProbe查询/readyz，源码基线仍每次访问Registry /readyz，故障时反向阻断缓存服务。

## interface_refs / data_structure_refs / history_context

current_design_refs：上述设计的失败、重试、一致性及信任边界；API ready/ensureActor、
objectrouter.Router、workerregistry.Store/RegistryStore。relevant_evolution：913cb575保持
fetch重定向边界；已有Object缓存有容量/TTL且每次刷新Cell route。superseded_refs：将
共享Registry可达性等同于公共API进程就绪。Deployment cursor watch失效仍清除代码缓存，
不能用本修复放宽stateless active Version freshness或Host代码加载。

## acceptance / affected_paths

- 真实HTTP503和TCP断连分别验证/readyz与缓存命中，无Registry读，无额外Actor创建。
- 容量淘汰后的旧Object和冷API实例在故障中拒绝miss；恢复后读回同一Actor/placement。
- 真实Registry filesystem Store前后Object与placement计数不变；Engine仅协议级double。
- 修改api.go、局部回归、正式设计、API运维README、Task及自己的catalog行。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根AGENTS、minisandbox及infra/cells AGENTS@913cb575 | 当前根/Cell正文，祖先前轮全文且diff无变化 | jj新修订、源码与部署分开、保留操作锁 |
| upstream-subtrees、agent-gateway-runtime、ctl/sandbox Pack | 本轮router must_read全文 | mono2唯一真源与公开入口证据范围 |
| adjacency/argocd-ci-secrets及实际CellServingRoute发布测试、workers-api/api.yaml | 正文与部署邻居 | route真值、实际readinessProbe接线 |
| TASK/CHECKPOINT模板及API/cache/Registry Store/server源码与测试 | 本轮源码 | LRU淘汰、持久claim、分类错误 |
| context-audit Skill与assessment/rubric/report全文 | 本轮阅读 | 局部检查通过包装器，不输出虚构评分 |

## evidence / risks / validation / decisions

- red：HTTP503和TCP断连都仅在/readyz处返回503导致失败，Object hit、miss和恢复不变量
  已通过，见/data/tmp/registry-outage-red-20261004.log。
- green：workersapi、objectrouter、workerregistry共122项顶层race测试通过；vet通过，
  见/data/tmp/registry-outage-race-20261004.log、registry-outage-vet-20261004.log。
- private endpoint、installation、endpoint qualification三份静态契约脚本通过，只证明源码接线。
- 根26项Context测试保持原四项失败，audit33项通过；不把历史失败报告为全绿。
- API README中旧的/readyz访问Registry说明已同步，探针不代表端到端资格。
- 仅本地TCP server和fixture值，不读取真实secret。
- Registry本身仍使用自己的存储就绪，公共API各请求失败语义不变。
- Registry HTTP故障与FDB真实网络故障不是同一资格，不能用本地Store证明FDB事务。
- 局部race、vet、文档检查及Context历史基线后提交；云发布仍必须探索先行。

## scan_scope / scan_output / handoff / checkpoint

仅本轮文件和自己的catalog行；回执留/data/tmp，保留历史Context问题。
stage：源码修复与本地回归；verified：red/green、故障不摘流、新建/miss拒绝、恢复身份与计数。
unverified：云发布后的Ready Endpoint、实际FDB故障、万活跃缩回与完整CLS通道。
discard：把直接调用handler成功视为Kubernetes会持续投递请求的推断。
restore：913cb575基线和当前独立jj修订；原strict10k的PID/Invocation保持不变。
next_action：根文档/Context历史基线与敏感扫描后提交；原任务结束后先探索再生产门禁。
