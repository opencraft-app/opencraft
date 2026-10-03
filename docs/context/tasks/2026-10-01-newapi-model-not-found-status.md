---
id: task-newapi-model-not-found-status-2026-10-01
type: task
scope: 区分授权分组未配置模型与渠道暂时不可用，并发布 NewAPI 状态码修复。
triggers: ["NewAPI model_not_found", "NewAPI 404", "NewAPI status release"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - new-api/middleware/distributor.go
  - new-api/model/ability.go
  - docs/engineering/domains/agent-gateway-runtime.md
status: active
reviewed_at: 2026-10-03
review_due: 2026-10-31
revision: 1.2.0
precedence: task
derived: false
---

## goal

请求模型在用户授权分组没有任何配置时，返回 HTTP 404 `model_not_found`，避免原来的 503 被误判为平台不可用；通过已有流程更新上海和新山。

## non_goals

- 不改变 VelaGW 路由、Hermes、NewAPI 重试或选渠道策略。
- 不把已配置但禁用、暂时不可用的渠道判为未知模型。
- 不同步上游版本、不移动 subtree pin、不修改渠道配置。
- 不绕过源码评审，也不直接修改控制器拥有的 Deployment 镜像。

## requirement_ids / requirement_refs / requirement_excerpt

- 会话需求，2026-10-01：“这种情况变成404”。用户选择未配置模型时，原有 503 容易被视为平台故障。
- 会话需求，2026-10-03：“更新一下newapi？这样的话避免503误判？”授权通过已有流程准备并发布上海、新山的局部修复。

## interface_refs / data_structure_refs

- `new-api/middleware/distributor.go`：选渠道失败后的 OpenAI 兼容错误响应 `{error:{message,type,code}}`。
- `new-api/model/ability.go`：`abilities` 持久化模型和分组配置；禁用渠道仍保留 `enabled=false`。
- 不变量：`auto` 只检查用户可用分组；查询数据库失败保留 503，不能作为模型不存在的证据。

## history_context

- `current_design_refs`：当前设计为 `docs/engineering/domains/agent-gateway-runtime.md` 与 `new-api/MONO2_SUBTREE.md`。
- `relevant_evolution`：本地 NewAPI 原先对未配置模型及不可用渠道均返回 `503`、`model_not_found`。
- `superseded_refs`：无；不再沿用全部无渠道错误均为模型不存在的解释。

## acceptance

- 未配置模型返回 404、`model_not_found`；已配置但禁用渠道继续返回 503、`get_channel_failed`。
- 正常选渠道行为不变、不新增数据库查询；相关 Go 测试通过。
- 源码合入后逐 Ring 发布，专用探针验证 404，全部目标 Set、实际镜像和健康状态收敛。

## affected_paths

- 源码及测试：`new-api/model/ability.go`、`new-api/middleware/distributor.go`、NewAPI 国际化及两份聚焦测试。
- 正式设计：`docs/engineering/domains/agent-gateway-runtime.md`。

## required_context

- 已读取 `agent-gateway-runtime`、`release-gitops`、NewAPI 服务边界以及根目录和服务 `AGENTS.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@current` | 仓库权限及任务约束 | 最新更新请求授权局部发布，仍保留源码评审门禁 |
| `new-api/AGENTS.md@current` | 子树边界 | 局部修复与上游同步分离 |
| `new-api/MONO2_SUBTREE.md@current` | 上游 pin 和发布契约 | 不隐式同步版本 |
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | 网关所有权 | 状态分类放在 NewAPI 而非 VelaGW |
| `docs/context/project/services/new-api.md@2.1.0` | 服务边界 | 不移动子树 pin |
| `docs/context/tasks/TASK-TEMPLATE.md@2.1.0` | 任务状态契约 | 记录证据及恢复入口 |
| `docs/context/project/adjacency/cloudladdergateway.md@1.0.0` | 最近网关邻接卡 | 确认应定位 NewAPI 源码及测试 |
| `docs/context/domains/release-gitops.md@current` | 发布路由 | 区分源码接收、固定制品及实际发布 |
| `docs/context/project/upstream-subtrees.md@current` | 上游管理路由 | 局部修复不移动 pin |
| `.ci/AGENTS.md@current`, `.ci/new-api.yml@current`, `.ci/runtime/commands/build_release_image.py@current` | 构建入口 | 使用现有 CI 运行时构建固定镜像 |
| `argocd/README.md@current`, `docs/context/project/adjacency/argocd-ci-secrets.md@current` | 部署邻居 | 凭据不进入仓库或输出 |

## evidence

- 原有中间件对选渠道错误及空渠道均返回 503；能力表保留禁用记录，可据此区分配置缺失和运行时不可用。
- 2026-10-03：固定 Go 1.26.1 Alpine 镜像中 `go test ./model ./middleware -count=1`、`go vet ./model ./middleware` 均通过。覆盖缓存及数据库选渠道、未知模型、禁用渠道、授权自动分组、启用渠道、空可用组和数据库失败。
- 404 中英文文案均包含 `model_not_found`，兼容仅保留异常消息的 Hermes 包装层。
- 上海 5 个健康 Set 当前为 `newapi-observe-1076ded3cb7c`；新山 2 个健康 Set 为 `newapi-gift-first-948c3a897830`。运行镜像由 VelaGWSet 管理，Release Ring/SetUpgrade 为实际发布入口，不能修改旧 Argo bootstrap pin 冒充发布。
- 新山本次还包含已在上海运行的 7 文件诊断修复，仅日志及 trace 校验，不改超时、ping、请求体或路由。
- 文档检查及 staged 变更影响检查通过。全库上下文检查存在历史元数据及凭据正则误报；本次任务补齐元数据并改为中文正文，不修无关历史文件，生成 catalog 不提交。
- 源码提交 `820be0778d7b53b4d63c8b3c2907c070012ecda8`、MR `!4948`；平台聚合检查通过，但合并 API 返回 `409 Review check not passed`，尚未合入。
- 已构建及推送 `new-api-820be0778d7b`，远端可读：上海 digest `0b25417138d1ded441b2d7de54e18b93d698fb45626e38383c9e2f431602abec`，新山 digest `c2c9a74dc8e66f61f406332f82bcaa1d52953ae396f25e90392fe8bdc80f637e`。上海镜像拉取并离线启动版本检查通过。
- 上海旧版 `set-auto-000009` 专用探针提交随机不存在模型，实测 `upstream_status=503`、`error.code=model_not_found`、`key_created=false`，耗时 17ms，无真实推理调用。

## risks

- 缺失能力记录可能误判未知模型；仅在无渠道错误路径查询数据库权威记录，查询失败保留 503。
- Hermes 可能终止未知模型重试；错误码与文案同时保留 `model_not_found`，便于识别并使用已配置降级策略。
- 使用已有串行升级、330 秒排空和 300 秒回滚窗口，不直接修改控制器拥有的 Deployment 或旧 bootstrap pin。补丁没有数据库结构变更。

## validation

- Go 格式、聚焦测试及 vet 已通过，文档及变更影响门禁已执行。
- 已检查 diff，未覆盖或提交原脏工作区中的无关文件。
- 发布验收须确认 Campaign/Rollout 完成、失败 Set 为零、Ring 稳定、实际镜像一致、admin/traffic 健康及未知模型 404 探针通过。

## decisions

- 用持久化能力记录（含禁用）区分缺失与不可用，不使用仅含启用渠道的缓存判定模型不存在。
- 选渠道错误及已配置但不可用保留 503，错误码改为 `get_channel_failed`。
- 生产发布等待 MR 评审及合入，不用已构建候选镜像绕过源码接收门禁。

## scan_scope

- 有界搜索限定在 NewAPI 能力模型、选渠道、国际化、VelaGW 发布控制及映射设计文档。

## scan_output

- 结论记录在证据中，无额外扫描制品；受保护凭据只在进程内使用。

## handoff

- 隔离工作区 `/data/mono2-newapi-model-status-release-20261003`；原脏工作区保持不变。源码与两地镜像均已准备，生产未修改。MR `!4948` 完成评审及合入后，再推进上海 Canary、剩余上海 Set 和新山。

## stage

- 发布已授权，但源码评审门禁未通过；未创建生产 Release/Rollout/Campaign。

## verified

- 聚焦 Go 测试、vet、文档及变更影响检查通过，两地镜像已推送并验证远端可读。
- 原版未知模型 503 已安全复现；原脏工作区没有被还原或提交。

## unverified

- 新版本尚未在生产运行，不能宣称线上未知模型已改为 404。

## discard

- 不再将全部无渠道错误视为未知模型；真实不可用继续保留 503。

## restore

- 从本隔离工作区和 MR `!4948` 恢复。操作脚本 `/tmp/newapi-release-ops-20261003.py` 默认只读或打印计划，显式 `--execute` 才发布；凭据不在仓库内。

## next_action

- MR 合入后核对 NewAPI tree 与候选制品来源一致，登记固定 digest Release，先升级上海 `prod-canary` 的 `set-auto-000009`，验证 404 后再串行推进剩余上海和新山。
