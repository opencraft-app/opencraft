---
id: pass-same-sp-modify-release-gates
type: task
status: active
owner: shawnmy
---

## goal

收口 LightVela 国内/国际同 SP 升配实现，并在不触碰生产和 GitOps 的前提下完成代码门禁、北京与韩国共享测试环境真实闭环，形成可执行的上线门禁结论。

## 当前检查点（2026-09-07 19:10）

> **2026-09-08 上线前复审增量（当前优先）**：Sandbox 新增 `000010_enforce_single_running_modify_operation`，用于给已执行旧版 `000009` 的环境补每实例唯一 running 台账约束。若发现历史重复 running 记录，迁移会 fail closed 并保持原数据不动，必须由 owner 核对目标和云侧步骤后显式处理。当前发布目标版本更新为 **CTL 29 / Sandbox 10 / Trade 9**；生产只读回读为 **28 / 8 / 8**，北京共享环境为 **29 / 8 / 8**。合并后必须由正常服务流水线先执行受控 DB Job 与 readiness，再推进北京 GitOps，不允许手工发镜像或手工 Sync。

> **2026-09-08 12:35 最终复审证据**：Sandbox `GOWORK=off go test ./... -count=1`、`go vet ./...`、受影响包 race 均通过；真实 MySQL 8 覆盖 rebind 恢复、不同 key 并发唯一 running、旧表重复 running 时迁移原子失败且保留原数据，全部通过；CI runtime **485 tests + materialized smoke** 通过；`docs-impact` 与 `git diff --check` 通过。北京 bj-7 与韩国 kr-1 的 Sandbox 库只读回读均为 **9/0**，历史重复 running 分组均为 **0**，因此可安全进入 `000010`，但在迁移和 readiness 成功前不得部署新 Sandbox 镜像。

> **19:37候选更新（优先）**：finalized修复CTL digest `2a9b8ed7103d2ee0ef3c358c82458af83368d940150358b2b1977aea0387aa62`已部署北京/韩国，各api/service/bypass均Ready。新候选已有下述现场验证，但跨renewing/isolated/later-bundle仍仅本地RED→GREEN。韩国新购另有一条已发布旧链路的异常观察，保留证据并另行交给对应 owner，不作为本次同 SP 升配 MR 的阻塞项。

> 后续审查新增跨状态风险（源级修复后按P1验收跟踪）：旧完成态receipt与worker完成重试要求Pass保持active，升配后转renewing/isolated或后续套餐会破坏原单重投。现源码已用同事务`task_params.entitlements_finalized`与Pass/quota收敛、worker从DB凭证恢复完成通知、加锁合并保留marker修复；renewing/isolated/later-bundle三场景已RED→GREEN，CTL新full/vet与四个受影响包race通过，无需migration。新镜像已两站部署并完成上述限定现场验证；**跨状态现场覆盖仍不足，不能签署全部门禁通过**。

- 北京 bj-7、韩国 kr-1 的通用/AI、零实例/有实例正常矩阵 **8/8 已真实闭环**；部署后订单/Flow、Pass/权益以及有实例云规格均有留证。最后韩国 AI 零实例于18:51:11收敛，18:52:36清理后 Pass 列表为空；实例也为空。
- CTL/Trade 最新严格参数、receipt/CAS修复及Sandbox停机/重绑修复已部署两站测试消费者。SOPS严格渲染5/5已通过，不再要求新账号或新SOPS环境。
- **仍不能签署全部上线门禁通过**：北京两轮真实响应丢失/计费自动重投已通过并恢复接线；第二轮实际在19:10:31确认Pass目标active，19:10:32确认Flow357回执NULL，19:11:12才由真实retry4恢复原任务回执，19:11:57交付完成，19:15:48/50确认Pass及实例清空。该证据不覆盖上方新增的后续状态变化问题。测试runtime密钥/分片配置的后续部署一致性、证据归档和候选owner签字仍需收口。生产计费发布/财管/CategoryID/回调配置、国内至少24小时灰度等仅列TODO，未执行。
- 下文16:15、17:46、18:26为历史检查点；其中“未部署”“资源锁卡住”“矩阵未完成”以本节与末尾最新矩阵为准，失败原始记录继续保留。

## non_goals

- 不实现跨 SP 变配或降配。
- 不新增前端入口；本期后端暗发。
- 不在本任务内合并 MR、发布生产、修改生产/GitOps，或操作计费变更单；代码提交与 MR 仅交付评审。

## requirement_ids / requirement_refs / requirement_excerpt

- TAPD `1010132091137784162`：同 SP 变配询价、下单、`checkModify`、`modifyResource` 与异步发货。
- 用户要求：代码收口后执行完整测试，并验证北京/韩国共享测试环境；国内先发布，稳定至少 24 小时后再考虑国际站。

## interface_refs / data_structure_refs

- CTL：`GET /v1/passes/{pass_id}/modify/bundles`、`POST /modify/order[-url|-and-pay]`、`POST /internal/ctl/passes/{pass_id}/modify`。
- Trade：`POST /internal/trade/inquiry/modify`、`POST /internal/trade/orders/modify[/place-and-pay]`、`POST /internal/trade/flows/{id}/complete`、jifei `checkModify/modifyResource`。
- 状态不变量：扣款后先 `paid_pending_provision`；仅 CTL 父任务完成并收敛 Pass/实例/权益后才进入 `trade_flow=completed`、`trade_order=provisioned`。
- Migration：CTL `000029`、Sandbox `000009` + `000010`、Trade `000009`。

## history_context

- `current_design_refs`：`docs/handover/2026-09-02-pass-same-sp-modify-runbook.md` 与运行时代码；冲突时以源码、测试和真实环境为准。
- `relevant_evolution`：韩国零实例链路曾真实触发计费回调，但订单终态时机与有实例路径仍需收口验证。
- `superseded_refs`：Runbook 中“韩国无 Sandbox”和旧 Pool ID 描述已过时，不能作为当前环境事实。

## acceptance

- 代码门禁：Trade/CTL/Sandbox 全量测试与 vet，受影响包 race，migration/contract/Kustomize/change-impact 检查通过。
- 北京、韩国各完成通用与 AI 套餐真实升配；至少覆盖零实例和有实例，并留存 Transaction ID、Deal、Flow、订单、Pass、权益、Sandbox operation、实例规格/Pool 证据。
- 明确外部 CategoryID 正式发布、24 小时国内稳定观察等仍需人工/生产阶段完成的门禁。

## affected_paths

- `trade/**`
- `ctl/**`
- `sandbox/**`
- `argocd/services/ctl/sandbox-kr-1/**`
- `.ci/runtime/**`
- `scripts/seed_trade_modify_scene_category.sql`
- `docs/handover/2026-09-02-pass-same-sp-modify-runbook.md`

## required_context

- `control-plane-ops`
- `subscription-entitlements`
- `commerce-trade-ops`
- `release-gitops`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@d5e05f7ed` | 仓库安全与发布边界 | 限制测试/生产、提交、验证行为 |
| `ctl/AGENTS.md@d5e05f7ed` | CTL 服务边界 | 约束编排和测试 |
| `trade/AGENTS.md@d5e05f7ed` | 计费回调边界 | 约束幂等和 provider 成功语义 |
| `sandbox/AGENTS.md@d5e05f7ed` | Sandbox 状态机与发布边界 | 约束实例改配和 Pool 操作 |
| `docs/context/project/services/ctl.md@d5e05f7ed` | CTL 路由结果 | 区分直连与公共路径验证 |
| `docs/context/project/services/trade.md@d5e05f7ed` | Trade 路由结果 | 明确订单与回调职责 |
| `docs/context/domains/subscription-entitlements.md@d5e05f7ed` | Pass/权益路由结果 | 约束权益终态 |
| `docs/context/domains/release-gitops.md@d5e05f7ed` | 发布路由结果 | 区分源码、测试环境与生产门禁 |

## evidence

- 2026-09-07 当前 HEAD `75723a0b9` 相对 `origin/master` 为 `0 behind / 1 ahead`；工作树仍有未提交收口改动，未 push/MR。
- 韩国 CTL 配置中的错误 Pool 引用已从 `pool-kr-4c8g80g-01` 修正为已探测到的 `pool-kr-4c8g-01`；共享环境上线前仍需重新实时读回确认。
- Trade：`go test ./... -count=1`、`go vet ./...` 通过。
- Sandbox：`GOWORK=off go test ./... -count=1`、`GOWORK=off go vet ./...` 通过。
- CTL：修复测试 helper 未恢复全局 `resource.GormDB` 导致的跨用例污染后，`go test -p 4 ./... -count=1`、`go vet ./...` 通过；`go test -race -p 1 -parallel 1 ./pkg/instance -count=1` 通过。
- 受影响包 race：Trade modify/internal/store、CTL pass worker 均通过。
- MySQL 8 migration round-trip：CTL `29 -> 28 -> 29`、Sandbox/Trade `9 -> 8 -> 9` 通过；modify seed 首次/重复执行均 12 行且无重复，精确 rollback 及多 modify scene 拒绝误删通过。
- `.ci/runtime/tests/contract_tests`、`.ci/runtime/check_ci_runtime.sh`（481 tests）、GitOps static、change-impact、documentation、Sandbox OpenAPI YAML 和 `git diff --check` 均通过。
- strict Kustomize早期因未找到SOPS key失败；后使用DevCloud既有密钥，在不输出解密值的前提下完成韩国CTL/Trade、北京bj7 CTL/Trade/Sandbox共5/5严格验证。该权限缺口已关闭。

### 2026-09-07 15:30–15:34 真实新购后升配通过（韩国通用零实例）

- 用户告知 mentor 调整路由后授权重试。本轮未修改应用、CategoryID、路由或环境配置；使用相同 mock UIN `450860000002` / UserID `usr_29d65f3d3692b2082e6ccbbc`，出站环境标识仍为 `450860000003`、入口仍为 testing 云梯 `43.153.246.14`。
- 重试前查明当日无该账号本地订单/Flow，CTL Pass 列表为空。
- 真实新购 Launch 1 月，禁止自动续费：HTTP 200，7.584814s；Transaction `0e639f4364cf48b500b460b145555a63`，Deal `20260907002021870275321`，BigOrder `20260907002021870275311`。真实 checkCreate/createResource/queryResource 成功；生成 `pass-6y9mcv28`，Launch/active，积分 100/100、配额 1/1。
- 针对同一个真实新购 Pass 查询升配目标：返回 Cruise；随后调用 modify/order-and-pay，HTTP 200，6.053437s；Transaction `4b64bd7af9fda96ba0de2940ede24db0`，Deal `20260907002021870292991`，BigOrder `20260907002021870292981`。
- 真实 checkModify 返回 status=0；generateDealsAndPay 返回异步 state=1；modifyResource 返回 flowId=47；后续真实 queryFlow 返回 status=0，queryResource 返回 Cruise SV。
- DB 终态：新购和变配订单均 provisioned；Flow 46/create_resource 与 Flow 47/modify_resource 均 completed。CTL ModifyPass task `task-modify-pass-11e4938001246cef7322b191cf2ef66b` 日志终态 SUCCESS。
- 用户接口终态：`pass-6y9mcv28` 为 Cruise/active，积分 200/200，配额 1/1，到期时间仍为 `2026-10-07T07:30:42Z`。内部套餐接口实时确认 Cruise 的 agent_quota=1、credit=200，配额与本环境配置一致；不得复用旧个人环境的 3/3 期望。
- 用户实例接口 total=0。本次覆盖真实新购、测试代扣、零实例升配、回调、订单/Flow/权益收敛；不覆盖 AI 套餐、实际 CVM 规格/磁盘/Pool 改配或生产验收。测试 Pass 保留且不自动续费，未退款或清理。
- 先前 599 在本次请求中不再出现；mentor 具体修改的路由尚未回读，不宣称已确定最终根因。

## risks

### 2026-09-07 新购后升配测试检查点

- 本轮用户明确要求以真实测试新购生成启航 Pass，再进行真实升配；不以人工插入 Pass 替代新购。仅使用已授权 mock UIN `450860000002` / AppID `1374210036` / UserID `usr_29d65f3d3692b2082e6ccbbc`，不操作生产。
- 实时韩国 Trade DB：Launch/Cruise 均配置 purchase `2025255`、renew `2025256`、modify `2025257`。这是场景映射，不能据此判定计费平台测试/生产配置一致。
- 该账号历史新购订单 `20260819002021866081591` 为 `provisioned`，其资源 `pass-8jxkv3oo` 后续已有 `destroy_resource/completed`。当前 CTL 查询无 Pass。
- 两个 Trade Pod 实际出站 URL 均为 testing 云梯 `43.153.246.14`，但环境 header `JIFEI_CGW_X_QCLOUD_USER_ID` 实际为 `450860000003`，与本工作树配置的 `450860000002` 不同；本轮未修改。Testing 云梯的 mock UIN 未命中个人改派，默认 callback 指向韩国测试 API。
- 北京时间 2026-09-07 15:16 新购一笔：Launch、1 月、禁止自动续费。CTL Request ID `c5276053-cb33-434a-af57-9c815200e4cc`；Transaction `bb71673a896025f4aa61037219e25e60`；Seq `8jsieivq-13hm-597l-kuyl-07coiea7y2rh`。
- 真实 `checkCreate` eventId `70802475`，15:16:11 返回 `returnCode=0 / returnValue=0 / data.status=0`。15:16:31 `generateDealsAndPay` 以 HTTP 200 携带业务 `410599`，消息 `order cener logic error:sys_err | call order-center http error.http error,return http code:599`；CTL 最终 HTTP 500，耗时 22.552641s。
- 重试后核对：该账号当日新增本地订单 0、Flow 0，CTL Pass 列表空；尚未开始升配。以上不代替计费侧订单/资金流水核对，不继续盲目重复支付。
- 外部检查点：计费接入平台跳转 OA 登录，页面提示安全演习期间禁用快速登录；需用户完成登录后继续查 purchase CategoryID 测试发布/路由和本笔内部 order-center 流水。浏览器登录页已保留。
- 本轮没有修改应用代码、集群配置或 GitOps，没有 commit/push；仅记录检查点。此前工作树改动保留。

- 系统盘扩容不可逆；失败只允许前向重试，不自动降配或退款。
- `order-and-pay` 会真实消耗测试代金券并触发发货，仅用于已授权测试账号/测试环境。
- 手工测试部署可能被 Argo 自愈覆盖；仅精确暂停目标测试应用，测试完成后记录恢复策略。

## validation

- 本地源码、单测、race、vet、migration、contract、严格Kustomize及静态文档已有通过证据；两站正常8项矩阵已闭环。真实受控故障时序、最终配置一致性与发布签字另设门禁，不由正常矩阵自动通过。
- 每次代码调整和 rebase 后重新执行相称门禁。

## decisions

- 保留历史公开用户态 `modify/order-and-pay`，固定 `AutoVoucher=1` 和 30 秒超时。
- 正常升配不加白名单/功能开关，以 `scene=modify` CategoryID seed 作为启停门禁。
- 后端暗发，国内先发布并观察至少 24 小时，再评估国际站。

## scan_scope

- `trade/`、`ctl/`、`sandbox/`、`.ci/runtime/`、`argocd/services/{ctl,sandbox,trade}/`、目标 runbook/seed。

## scan_output

- 直接记录在本 Task Pack 的 `evidence` 与最终交接中。

## handoff

- 正常功能矩阵已8/8闭环；当前交接仍保留真实故障时序、后续部署配置一致性、完整证据归档和owner签字。未操作生产/GitOps；生产计费事项保持TODO，不宣称生产可用。

### 2026-09-07 16:15 继续执行检查点

- 新鲜代码验证：Trade、Sandbox、CTL 全量 `go test -p 4 ./... -count=1` 和 `go vet ./...` 均通过。CTL 必须显式使用本工作树 `CONF_DIR`、Colima `DOCKER_HOST` 与 `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`；最初两次启动配置失败不计通过。
- 发现并修复回调参数校验缺口：checkModify/modifyResource 对非法、0、int64 溢出 UIN 和缺失 curDeadline 均必须拒绝。8 个新增用例在旧实现全部 RED（误返 returnCode=0），修复后 GREEN；Trade 全量/vet、两个受影响包 race 通过。真实历史回调形状回归也通过。修复尚未构建部署，既有线上测试证据不能证明新修复已在环境生效。
- `.ci/runtime/tests/contract_tests` 143 tests 通过；`git diff --check` 通过。
- strict Kustomize 实际重跑韩国 CTL/Trade，均因 SOPS 解密组 0 成功失败。跳板机没有 kustomize/sops，未输出或复制密钥。
- 真实负向接口测试：跨 SP、降配 HTTP400/PASS_MODIFY_TARGET_NOT_ALLOWED；非资源所有者 HTTP404/NOT_FOUND。再次 GET Pass：Cruise/active、积分200/200、quota1/1、expiry不变。GET modify/bundles 返回空目标集，当前已购 mock Pass 不能继续作为低配升配源。
- 新 AI 专用测试账号走正式注册与 binding/retry：注册成功；UIN `450860000014` / AppID `1374220501`，计费开户返回 `billing_account_open_failed`、`FailedOperation.UinNeedBaseInfo`、`failed to query mdmId`，RequestId `570805ef-6488-4c2c-b15c-459a2278ee62`。此为开户阻塞，不是 checkModify/发货回调故障；未代造绑定或人工插 Pass，未更改计费配置。
- 原 TAPD 需求新增关联14个真实请求/返回用例；其中历史新购410599和新账号开户失败分别保留为失败/阻塞证据，不抹去或标记为通过。checkModify/queryFlow 回读了真实请求及响应业务字段日志，不伪造日志未记录的HTTP头/响应信封。完整脱敏原始内容留存在本地测试证据与 TAPD 记录中，不把约 500KB 的流水导出提交到代码 MR。需求汇总评论 `1010132091215702164`。
- 计费侧待办见 `docs/handover/2026-09-07-pass-modify-billing-release-todo.md`：只调研，未操作接入单/审批/发布。

### 完成态重投幂等追加收口

- 复核发现：CTL已FinalizeModify，但Trade的RecordAcceptedByID失败时，重投会以旧source对已切换的Pass误判409，Trade进而退款。已用本地Go/SQLite测试复现，不宣称真实环境发生过该退款。
- 新增 `modify_completed_retry_test.go`：分别覆盖父task CREATED/RUNNING/SUCCESS；修复前全部RED（source bundle mismatch）。实现完成态持久化任务凭证校验后GREEN；对原flow/deal/UIN/source篡改均拒绝，且任务数保持1；CAS竞争后resume路径同样复用凭证。
- 凭证必须逐项匹配pass/user/source/target/flow/deal，不能仅凭“已是目标套餐”放行。既有父任务继续重试终态回调，不重复派发或重做权益。
- 同时补齐校验与CAS之间的完成竞态：`TryAcquireSlotForModify` 必须匹配 active 和预期源bundle。原DAO对已active目标套餐仍可抢占的测试先RED，增加源套餐条件后GREEN，未命中进入完成态凭证恢复，避免Pass被旧请求再次卡在modifying。
- 异常时序本地回归用例 `1010132091121591300` 已关联原TAPD；总计15个关联用例，其中14个为真实环境/流水证据，1个为本地异常时序回归。
- CTL全量/vet/logic-pass race补跑通过；两处Trade严格参数校验与本项CTL修复均尚未部署。上线前仍需真实测试环境注入受理落库失败、快速完成、计费重投，观察无退款且order/flow收敛。

后续顺序（19:10更新）：补足完成态精确时序证据 → 恢复测试接线并核对最终候选/配置 → 补齐原需求测试证据 → 交owner签署。首轮响应丢失/真实重投、正常8项矩阵、mock复用销毁以及SOPS严格渲染已完成，不重复设为前置阻塞。

## 2026-09-07 17:46 实测续记（覆盖前述过时阻塞）

- 无需新注册账号。韩国既有mock账号本轮Cruise Pass `pass-6y9mcv28` 已完成真实退订（退款单 `20260907002021870399011`）、回调进入isolated、用户销毁接口200、列表为空；随后复用同一账号成功新购Launch AI。
- AI新购单 `20260907002021870382941`，Pass `pass-mp0o70u8` active，积分4500/4500。创建实例 `ins-5156fff96b6e4836a4b8ffcf9a33e64b` 后查询Running，Sandbox `3ebdcb55-a8a6-48c2-882e-4b3d9d07d847`。
- AI有实例升配订单 `20260907002021870400001` 已支付受理，Pass进入modifying。此为未完成用例，不判通过。
- 首个真实阻塞为CTL→Sandbox modify接口401：现场CTL env/TOML及Sandbox env均缺SANDBOX_API_KEY。仅韩国两个runtime Secret补齐同一随机共享密钥、重启消费者；未打印密钥、未改生产或GitOps。原任务自动重试后POST modify返回202，operation `mod-d385d993-ef0e-4645-8414-7ac093899561`。
- 后续云侧阻塞为 `UnsupportedOperation.StoppedModeStopChargingSameFamily`，RequestId `aab81167-82f5-422d-9af9-1f501f3d35f8`。云实例 `ins-kaddgpfh` 从2c4g目标升到SA5.LARGE8/80GB，升级停机复用STOP_CHARGING路径；修复与回归正在进行。保留原订单及任务恢复验证，不重新扣费。
- 北京bj7新购已完成，Pass `pass-gfheifmf` active，订单 `20260907995023587976501` provisioned，Flow327 create_resource/completed。当前Trade digest版本缺少 `/internal/trade/inquiry/modify`，404导致CTL询价500；正在独立修正测试部署，不能描述成计费不通。
- SOPS严格渲染韩国CTL/Trade、北京bj7 CTL/Trade/Sandbox共5/5通过。证据 `/tmp/lv-pass-release-gates-20260907-resume.md`。最新本地receipt/CAS及严格参数修复仍须部署证明和真实回归。
- 本轮真实请求持续存于 `/tmp/lv-pass-gates-AxaZKR/requests.jsonl`，北京证据 `/tmp/lv-bj7-evidence/requests.jsonl`。TAPD追加用例时保留失败和中间态，不把HTTP200等同闭环。

## 2026-09-07 18:26 韩国有实例闭环与收尾

- 已部署最新CTL/Trade固定digest：CTL `dc77d73e2cb6df610b75dc59f4dfb8568a15c2a6b52e96dc711ba60add8c5952`，Trade `3f18ffcd2ef01dd5373f23b5f564e059467077556ac99643522db1578b73a3aa`；实际消费者更新且Ready。mentor现有计费路由未覆盖。
- Sandbox最终worker digest `73608e9775a694d6213083431595e7a7ccdcd4b98b833ee49772980429807a9d` 包含专用KEEP_CHARGING停机、旧停机状态恢复、未知计费模式拒绝，以及resolution_source短类别修复。最后一项已用MySQL8严格模式RED/GREEN验证，不扩列、不新增迁移。
- 同一operation `mod-d385d993-ef0e-4645-8414-7ac093899561` 于18:18回读 `completed/done`。18:19 Pass `pass-mp0o70u8` 已为Cruise AI/active，积分10000/10000，quota1/0（已用名额不变），到期时间保持 `2026-10-07T09:24:06Z`。
- 原CTL实例仍Running，原云实例 `ins-kaddgpfh` 经DescribeInstances确认SA5.LARGE8、4C8G、80GB、RUNNING。新购/升配订单均provisioned，Flow51 completed。
- 18:22:25计费真实queryFlow51事件86375424返回 `returnCode=0,data.status=0`，留证为同pod/时间的入站与业务返回字段，不伪称完整HTTP抓包。
- 清理未完成：18:20至18:25多次真实OnlineRefund返回100151 `ERR_RESOURCE_LOCK`。最近Transaction `70b0357ba146da574ce48e2570e0fbc6`；CTL将上游错误显示成404，不能把404解释为Pass不存在。保留现有Pass/实例/订单，不删库，不伪造回调。等待计费锁释放或明确后续业务收尾要求，通用有实例及AI零实例余项不得提前判通过。
- 北京识别到副本2而shard-total8的测试缩容缺口，已将live参数改2；韩国同样核查并对齐为2。须将分片覆盖和双端密钥存在性纳入部署门禁，当前仅测试runtime修正，尚未形成生产配置验收。

## 2026-09-07 18:53 正常矩阵与最新部署证据

| 环境/场景 | Pass | 新购Deal / 升配Deal | 创建/变配Flow | 实际验收终态 |
|---|---|---|---|---|
| 北京通用零实例 | `pass-9ltu18vz` | `20260907995023588176481` / `20260907995023588163161` | 339 / 340 | 两单provisioned、两Flow completed；Cruise active200/200、quota1/1，到期不变 |
| 北京AI零实例 | `pass-gfheifmf` | `20260907995023587976501` / `20260907995023588121681` | 327 / 336 | 两单provisioned、两Flow completed；CruiseAI active10000/10000、quota1/1，到期不变 |
| 北京通用有实例 | `pass-ji18f29n` | `20260907995023588233361` / `20260907995023588184811` | 343 / 344 | 两单provisioned、两Flow completed；Cruise active200/200、quota1/0，原CVM `ins-lds0j8x9` 为4C8G80GB RUNNING，Pool重绑完成，到期不变 |
| 北京AI有实例 | `pass-bkkn81r1` | `20260907995023588428291` / `20260907995023588398231` | 347 / 348 | 两单provisioned、两Flow completed；CruiseAI active10000/10000、quota1/0；原CVM `ins-eqahqw25` 为SA5.LARGE8/4C8G80GB RUNNING、磁盘ID不变、Pool重绑完成 |
| 韩国通用零实例 | `pass-6y9mcv28` | `20260907002021870275321` / `20260907002021870292991` | 46 / 47 | 两单provisioned、两Flow completed；Cruise active200/200、quota1/1，到期不变 |
| 韩国AI有实例 | `pass-mp0o70u8` | `20260907002021870382941` / `20260907002021870400001` | 50 / 51 | 两单provisioned、两Flow completed；CruiseAI active10000/10000、quota1/0；原CVM `ins-kaddgpfh` 为SA5.LARGE8/4C8G80GB RUNNING，原operation完成 |
| 韩国通用有实例 | `pass-et5oaqso` | `20260907002021870332311` / `20260907002021870419201` | 54 / 55 | 两单provisioned、两Flow completed；18:42:56为Cruise active200/200、quota1/0；18:46:47原CVM `ins-0wmip315` 为SA5.LARGE8/4C8G80GB RUNNING，到期仍2026-10-07T10:35:06Z |
| 韩国AI零实例 | `pass-04mcbzie` | `20260907002021870352651` / `20260907002021870296401` | 58 / 59 | 两单provisioned、两Flow completed；18:51:11为CruiseAI active10000/10000、quota1/1，无实例，到期仍2026-10-07T10:49:45Z |

以上为授权测试账号、真实下单支付及后台直连API/DB/CVM回读，不代表浏览器公开网关鉴权或生产验收。有实例的云状态、磁盘与Pool验收不以CTL中间态替代。

### 资源锁与正常清理

- 韩国早期AI有实例退款100151已不再阻塞：实例正常删除后，18:32:55退款请求成功，退款单`20260907002021870352211`，真实隔离后用户销毁，18:34:11 Pass列表为空；随后同一mock完成通用有实例和AI零实例。时间先后不能单独证明实例删除是计费解锁的原因。
- 北京AI有实例同样出现暂时100151，而非国际站特有故障：18:27:30真实queryFlow348返回status0，18:28:35退款成功，隔离Flow349、销毁Flow350 completed，18:29:03 Pass空、18:29:32实例total0。
- 两站正常矩阵创建的Pass/用户实例均已通过支持的删除/退款/隔离/销毁流程清理；未删库或伪造回调。池库存仍由正常池生命周期管理，不代表把所有池CVM销毁。北京随后新建的fault专属Pass另计，不包含在正常矩阵清理声明中。

### 候选与已关闭的实现阻塞

18:50前后只读回读两站workload：CTL api/service/bypass各1 Ready，digest `dc77d73e2cb6df610b75dc59f4dfb8568a15c2a6b52e96dc711ba60add8c5952`；Trade各2 Ready，digest `3f18ffcd2ef01dd5373f23b5f564e059467077556ac99643522db1578b73a3aa`；Sandbox sharded worker各2 Ready，digest `73608e9775a694d6213083431595e7a7ccdcd4b98b833ee49772980429807a9d`。分别来自北京/韩国测试镜像仓库，不等于生产已发布。

- CTL/Trade的严格UIN/curDeadline、完成态receipt和source CAS修复已进入上述测试候选，正常计费回调在部署后通过；不再写“最新fix未部署”。
- Sandbox升配专用KEEP_CHARGING、旧STOP_CHARGING恢复、未知计费模式拒绝及`resolution_source="modify"`均进入最终worker。真实MySQL8严格模式复现1406后GREEN，字段保持VARCHAR(32)，未扩列；原operation从verify_delivery继续rebind完成，没有重新扣费或重做云升级。
- SOPS5/5、Sandbox最终全量test/vet、provider/service race及真实本机MySQL回归已有通过证据。local测试不冒充计费故障注入。

### 留证进度与剩余门禁

- 北京原始请求、回调和DB/CVM证据位于`/tmp/lv-bj7-evidence/`；18:50只读TAPD回读确认已创建168例全部关联原需求。随后逐例回读审计确认其中92例非HTTP响应被转换器误放入http_status、response.raw为空；已用12条关联原用例ID的需求评论补齐原始返回，不把归档纠正当成新执行。纠正评论ID从`1010132091215723084`至`1010132091215723122`（非连续，完整清单在`tapd-response-corrections.jsonl`）。转换器9项回归通过；首轮新增及第二轮前置录入后216例关联成功，持续增加的补测证据去重追加，最终数以归档账本为准。
- 韩国真实请求位于`/tmp/lv-pass-gates-AxaZKR/requests.jsonl`；后续77条录入由主任务执行中，本检查点不宣称全部归档完毕。早期仓库JSON仅包含最初14条，不代表完整新矩阵。
- 北京受控fault仍在执行：必须看到真实计费重投、同task/flow与准确中间时序，才能判通过；临时harness本地12项/race通过仅证明工具行为。响应丢失恢复不等于精确SQL acceptance写失败，普通并发不等于已证明CAS竞态。
- runtime共享鉴权键、shard-total与实际副本数的一致性需进入后续部署审查；故障工具撤销后应回读原接线、镜像和Ready状态，避免临时配置遗留。

## 首轮真实响应丢失与重投门禁（18:58完成）

- 北京Pass `pass-cllw8bfj`，新购单`20260907995023588648931`，升配单`20260907995023588524511`，Flow352，确定性父任务`task-modify-pass-d89d3e22b104d6942130bf00f8e43634`。18:51:13真实支付成功；首次modifyResource返回600903，真实计费retry1返回0并复用Flow352。
- 注入只丢弃一次成功CTL受理响应；真实queryFlow在延迟完成期间返回status2。18:53:57唯一Flow completed、唯一升配单provisioned、唯一父任务SUCCESS；权益200/200、quota1/1、到期不变，未重复增加权益。18:57:46/49正常退款隔离销毁后Pass空、instances0；18:58:21原直连上游恢复且工作负载健康，临时Deployment/Service/NetworkPolicy已移除。
- **覆盖边界**：首轮真实重投发生在同一秒，首次快照回执已持久化，未独立证明“Pass完成但Trade回执NULL之后再重投”的精确排序；不是字面SQL写失败，也不是validation与CAS竞争注入。该窄窗口由补充测试单列，不能据此提前解除P0门禁。
- 韩国18:55:52真实migration为CTL29/Sandbox9、dirty0；18:56候选Pods Ready；18:57实际worker为StatefulSet `sandbox-worker-sharded` 2/2且currentRevision=updateRevision、shard-total2。旧Deployment `sandbox-worker` replicas0为停用组件，不代表实际worker为0。共享API键仅记录PRESENT/MATCH。
- 本机最终复跑：Trade、CTL、Sandbox全量test及vet通过；相关包race全部通过，143条contract通过。CTL显式正确CONF_DIR及Colima Docker后通过，先前本机配置/运行时启动错误不计产品故障。19:08:52另用真实本机MySQL8以`-count=1 -race`运行`TestModifyRebindResumeMySQLLengthBoundary`通过：隔离数据库应用迁移、rebind恢复完成并自动删除；不是仅靠可选测试skip或旧证据。

## 追加验收预期：完成凭证不得依赖后续Pass状态

此前精确active+NULLreceipt窗口已由第二轮真实测试通过：Pass `pass-lgzh2wpn`，升配单`20260907995023588869061`，Flow357。19:10:31 Pass active Cruise/权益200；19:10:32只读DB response_body=NULL；放开后19:11:12真实retry4 event31888614返回0/原Flow357；19:11:22原Flow回执已写入且父任务唯一；19:11:57同Flow completed、同task SUCCESS。19:15:59原上游恢复、临时工具资源移除并清理测试Pass。该通过仅覆盖后续状态仍active，不覆盖本节新增renewing/isolated边界。

证据归档再审计发现同case不同utc的9个快照被旧去重键跳过，现转换器以case+utc去重，旧账本只兼容认作case第一条；不改原始JSONL。9个补充用例`1010132091121592294`至`1010132091121592302`分别保留原始utc，包含NULL→receipt完整DB时序。`BJ-RECEIPT2-RESTORED-RUNTIME`在11:09:22Z实为接入harness时误用名称，须以记录内真实URL为准，后续恢复快照才证明撤销。转换/去重11项回归通过。

归档规则：case+utc为唯一证据键；非HTTP的SQL/JSONL/云查询/业务日志原文完整保留，不伪造HTTP状态；已有结构化response不得覆盖为空。历史92例归档修正的原用例→评论映射保存在`/tmp/lv-bj7-evidence/tapd-response-corrections.jsonl`。本检查点北京253条、韩国113条，合计366条原始证据均已关联原需求；新候选增量另行追加。缺失历史HTTP信封不能从业务日志推造，也未实现自动历史回执查询。

- 原升配确实完成后，分别在active、renewing、isolated状态重投原flow/deal：均返回原任务/Flow受理凭证，不退款、不新增父任务、不再次应用权益；不得把当前状态回写active或覆盖后续续费/隔离。
- 完成通知延迟到续费或隔离之后，worker仍须依据原升配持久完成凭证完成原订单/Flow；不能因当前非active而卡死、重做云变配或误回退。
- 篡改user/UIN/AppID/pass/source/target/flow/deal、只有父任务但无原升配finalized凭证，必须拒绝；不能把CREATED/RUNNING任务自身当作已经发放权益的证明。
- finalized凭证、目标套餐与权益更新应有同事务证据；事务失败不应留下“凭证成功但权益未完成”或相反状态。需要RED→GREEN、真实MySQL事务回归、新CTL候选镜像及部署后重投证据；新结果录入前本节均为待验收。

## 部署源配置持久化差异（只读核查，未修改GitOps）

| 差异 | 已核实源码位置 | 待处理与验收 |
|---|---|---|
| 北京worker副本2但继承shard-total8 | `argocd/services/sandbox/sandbox-bj-7/patch-playground-scale-down.yaml:24`只设置replicas2；`sandbox/k8s/base/manifests.yaml:434`固定8 | 在北京测试overlay同时覆盖worker命令/分片总数；不得直接把共享base生产8分片改2。渲染后ordinal0/1覆盖total2，真实StatefulSet2/2 |
| CTL→Sandbox共享键仅live已核对 | `ctl/pkg/adapter/sandbox/adapter.go:177`与`sandbox/api-gin/config.go:57`均读SANDBOX_API_KEY；CTL/Sandbox各自envFrom runtime Secret | 受控更新对应SOPS源的同名键，只输出PRESENT/MATCH；固定Secret名须显式验证消费者滚动，不能把Secret更新当Pod已经生效 |
| 北京键的加密源 | `argocd/secrets/sandbox-bj-7/ctl-runtime-secrets.sops.yaml`和`sandbox-runtime-secrets.sops.yaml` | 分别由CTL ksops-assets及Sandbox ksops-secret-generator引用；无须明文进入platform.env |
| 韩国CTL键的加密源 | `argocd/secrets/sandbox-kr-1/ctl-runtime-secrets.sops.yaml`，由`argocd/services/ctl/sandbox-kr-1/ksops-assets-generator.yaml`引用 | 与韩国Sandbox真实消费端配对核查；仅定位文件，不声称加密值已校验 |
| 韩国Sandbox GitOps来源缺口 | 本候选树不存在`argocd/services/sandbox/sandbox-kr-1/`，也不存在`argocd/secrets/sandbox-kr-1/sandbox-runtime-secrets.sops.yaml` | 先查实际部署来源/owner；若需纳入本仓，新增韩国测试overlay及对应加密Secret/generator/应用注册需单独授权。不能臆造已有路径，或用生产sgprod代替韩国测试 |

以上仅差异清单；未编辑Secret、SOPS、overlay、应用注册、生产或GitOps。新候选发布前仍需owner确认配置持久化方案。

## 最终CTL候选现场增量（2026-09-07 19:37检查点）

- 新候选：两站CTL api/service/bypass Ready，digest `2a9b8ed7103d2ee0ef3c358c82458af83368d940150358b2b1977aea0387aa62`。下列证据归属于此候选；上方8/8正常矩阵属于旧CTL候选，不能冒充新候选全矩阵无异常回归。
- 北京`pass-q1k3ll3x`：19:33:31 active Cruise；19:33:33原Flow365仍NULL回执而原task finalized marker=true；19:36:52真实计费retry恢复原受理凭证，19:37:11只读确认复用原task。此为新marker路径真实active完成态恢复证据。真实续费尝试被100151资源锁拒绝，**未进入renewing**，不可算跨状态live通过。当前正disarm、恢复接线与清理，须后续回读才可签署环境已恢复。
- 韩国`pass-6uip9jak`：CruiseAI active10000/10000，expiry `2026-10-07T11:31:15Z`不变；唯一任务SUCCESS且marker=true，升级Flow65 completed、本地升级订单95 provisioned；退款隔离Flow66/销毁Flow67 completed，19:36:22 Pass列表空。已验证新候选AI升级收敛及清理，不重复下单。
- **韩国新购异常观察（本需求外，另行跟踪）**：该Pass新购provider返回100238非成功，但后续真实create Flow62 completed并使Pass active；新购deal `20260907002021870403681`在本地trade_order没有对应行，仅存在升级订单95。必须保留原始非成功响应及异步成功流水，不把资源最终可用等同本地新购交易完整；但新购实现已发布且本 MR 不修改新购协议或状态机，因此该观察不作为升配发布阻塞项，应由 Trade/计费 owner 在独立问题中判断对账和补偿。
- 当前升配范围内缺口：新候选跨状态live证据、北京最终恢复清理回读、配置持久化与发布审批。可以交付代码与证据，不作生产门禁全部绿色签署。
- 尚无生产计费四单现网发布/财管审批/CategoryID与回调配置回读，也未开始国内至少24小时生产灰度。其责任方、证据与边界见计费上线TODO。
