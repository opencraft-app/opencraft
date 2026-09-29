---
id: personal-devcloud-intl-e2e
type: task
status: complete
owner: shawnmy
---

## goal

用全新国际 testing SaaS 影子账号在个人 DevCloud 完成计费回调注册、新购、支付、三条跨 SP 升配和退款闭环，并把真实遇到的网络、注册和依赖准备问题固化进 `personal-devcloud-environment` Skill。

## non_goals

- 不修改生产环境或生产账号。
- 不提交、push、创建 MR 或发布 GitOps；这些动作仍需用户单独确认。
- 不复用历史未支付订单作为本轮验收证据。

## acceptance

- DevCloud 页面地址支持实际存在的 `9.0.0.0/8` 与 `21.0.0.0/8`，显式地址必须校验。
- 国际注册接受服务端从可信代理链确认的 NAT 来源 IP；可选严格来源 IP 预检不匹配时 fail closed。
- 注册失败输出安全的业务 `code/message`，不只显示 curl 退出码。
- Shadow SDK 自动跟随父仓库 HTTPS/SSH 协议，并能修复仅剩 `.git` 的中断 checkout。
- 新账号真实完成新购/支付、`Launch → Launch AI`、`Cruise → Cruise AI`、`Launch → Cruise AI`、退款/隔离/销毁，并保留请求、回调和终态证据。

## context_receipt

| 文件 | 用途 |
|---|---|
| `AGENTS.md@7e907e1a3` | 仓库安全、Task Pack 和验证门禁 |
| `.agents/skills/personal-devcloud-environment/SKILL.md@7e907e1a3` | 个人 DevCloud 注册、回调和安全边界 |
| `docs/context/domains/release-gitops.md@7e907e1a3` | testing manifest 与发布证据边界 |
| `docs/context/project/services/trade.md@7e907e1a3` | 真实计费和回调验收边界 |
| `docs/context/project/services/cloudladdergateway.md@7e907e1a3` | 动态路由、强认证和审计边界 |
| `cloudladdergateway/AGENTS.md@7e907e1a3` | CloudLadder 服务验证要求 |

## current_evidence

- 国际 testing UIN/AppID：`450860000023 / 1374222817`。账号已开户并完成 SaaS 平台映射；首次开户超时后通过官方 binding retry 成功。
- 中央 testing 用户：`usr_6f227841b2a1564273a779c9`；个人环境用户：`usr_b3496462bba969391ebc2976`。两者不是同一个 `user_id`，但个人 Auth 已对齐中央 binding 的 `shadow_user_name / uin / owner_uin / app_id`。
- 新账号先完成不支付订单 `20260921023021873753241`，证明 Account/订单中心映射可用；充值 500000 分后再执行本轮真实支付，充值 reqId 为 `5b002ce505d44dcdb88d99c00c6545dd`。
- 页面 IP 为 `21.214.48.147`。注册 POST 的来源 IP 由 Auth 从可信代理链确认，不再由客户端自报。实际先后观测到 NAT 池 `14.22.11.160/29` 和 `14.116.239.32/29`；只给 SG 集群 testing 工作负载追加这两个最小网段，生产未修改。
- 个人 DevCloud 动态目标为 `uin-450860000023.sg.tunnel.internal`，callback listener 为 `:18084`。2026-09-21 16:32:26 UTC 续租后服务端确认 `targetIp=14.116.239.36`，租约有效至 2026-09-22 00:32:26 UTC。
- 个人完整 localstack 的页面、Gateway、Trade callback、Trade internal、动态注册、devtunnel agent、heartbeat 和所有非 Job Pod 均通过 `status`；paid-E2E runtime 的 Trade/CloudLadder HMAC fingerprint 一致。

## account_and_route_evidence

| 项目 | 实际结果 |
|---|---|
| 中央 testing 身份 | `usr_6f227841b2a1564273a779c9`，持有真实 shadow binding |
| 个人浏览器身份 | `usr_b3496462bba969391ebc2976`，只承载个人 localstack session |
| UIN / AppID | `450860000023 / 1374222817` |
| 个人页面 / API | `21.214.48.147:5173 / :8085` |
| callback listener | `21.214.48.147:18084`，只暴露 callback proxy |
| 内部 Trade | `127.0.0.1:28084`，不对 DevCloud 网络公开 |
| 动态 tunnel | `uin-450860000023.sg.tunnel.internal` |
| 最新服务端来源 IP | `14.116.239.36`，位于实测最小池 `14.116.239.32/29` |
| 路由租约 | 2026-09-21 16:32:26 UTC active，2026-09-22 00:32:26 UTC 到期 |

## paid_e2e_matrix

### Launch → Launch AI

| 证据 | 值 |
|---|---|
| Pass | `pass-6bsug0a1` |
| 新购 Deal / Big Deal | `20260921023021873838801` / `20260921023021873838791` |
| 新购 Transaction | `ace1411dac844bf8b33a505ec71f84a3` |
| 升配 Deal / Big Deal | `20260921023021873820661` / `20260921023021873820651` |
| 升配 Transaction | `33cec03f7d2dea65732a9dc14fa3880f` |
| Modify Flow / Task | `2` / `task-modify-pass-995e199572c023d715d98fa5bfe96ca2`，`SUCCESS` |
| 退款 Deal / Big Deal | `20260921023021873820721` / `20260921023021873820711` |
| 退款 Transaction | `1a4b94b2f0fa2f59e3f9395877eaa205` |
| 销毁 Reference / eventId | `pass-6bsug0a1_1790001854131354956` / `677264467` |
| 销毁 Transaction / Task | `dbe6832501ff4a38223daced13de597f` / `task-e0c50f4232f74ad796df59eecff99481`，`SUCCESS` |
| 终态 | `history_pass.status=deleted` |

### Cruise → Cruise AI

| 证据 | 值 |
|---|---|
| Pass | `pass-7re8qtu5` |
| 新购 Deal / Big Deal | `20260921023021873771711` / `20260921023021873771701` |
| 新购 Transaction | `88a5ec7b265e8786622000121dc0e951` |
| 升配 Deal / Big Deal | `20260921023021873878191` / `20260921023021873878181` |
| 升配 Request / Transaction | `eabc694f-dd3e-42c1-9772-6258906bcfa1` / `6c0f45b48e024486ca99b27b7b41efc6` |
| `checkModify` / `modifyResource` eventId | `83855912` / `59124838` |
| Modify Flow / Task | `6` / `task-modify-pass-1b00458c4820493acd6e06f9b5c5200f`，`SUCCESS` |
| AI Plan | `00000000-0000-4000-8000-000000000005` |
| 退款 Deal / Big Deal | `20260921023021873821321` / `20260921023021873821311` |
| 退款 Request | `61383e2e-230f-4f9d-914e-d6b65ccd04ae` |
| 隔离 / 销毁 Flow | `7` / `8` |
| 销毁 eventId / Transaction | `1108079103` / `efa3e9e2134a1d57bb3019fe0bd2690f` |
| 删除 Request | `c0f28c8e-1665-474f-b449-ebf446009da3` |
| 终态 | `history_pass|pass-7re8qtu5|deleted|bundle_cruise_ai_01|biz` |

### Launch → Cruise AI

| 证据 | 值 |
|---|---|
| Pass | `pass-g7o1lr49` |
| 新购 Deal / Big Deal | `20260921023021873858501` / `20260921023021873858491` |
| 新购 Request / Transaction | `b8d0d4f1-af1d-43a6-be51-1561ea790ec7` / `a3a77bfbded0c5e297f5cfff7e88aaf9` |
| 升配 Deal / Big Deal | `20260921023021873771801` / `20260921023021873771791` |
| 升配 Request / Transaction | `cd2f6443-03d5-45b0-93d8-32704310634e` / `0996c02fbcb8bf3d1f2dc47c46455353` |
| `checkModify` / `modifyResource` eventId | `75702037` / `75791486` |
| Modify Flow / Task | `10` / `task-modify-pass-c9e35b529aca947457a1fcfc2a634c00`，`SUCCESS` |
| 退款 Deal / Big Deal | `20260921023021873783471` / `20260921023021873783461` |
| 退款 Request / Transaction | `04b133dd-1e4d-4691-b9a3-614471594869` / `04e16229d10dbae09b27b38b3788f899` |
| 隔离 / 销毁 Flow | `11` / `12` |
| 删除 Request | `46bb5512-27ad-4c85-a537-8808e783fd89` |
| 销毁 eventId / Transaction | `1431160914` / `52553e3c67e9e5098fcf0d3e1f8813b9` |
| 销毁 Task | `task-d360e452ae1544ecb6f6cc31d93a7b58`，`SUCCESS` |
| 终态 | `history_pass|pass-g7o1lr49|deleted|bundle_cruise_ai_01|biz` |

## cleanup_and_entitlement_evidence

- 三个 Pass 均已通过正式退款、隔离、销毁流程迁入 `history_pass`，没有删业务库或伪造回调。
- `ai_gateway.subscriptions` 中对应一条 Launch AI plan 与两条 Cruise AI plan 均为 `cancelled`，没有残留 active subscription。
- 三条路径均保持原 Pass/resource identity 和原地域；未做跨地域变配。

## incident_evolution_and_root_cause

退款后的销毁链路依次暴露三层不同问题：

1. `BillingAPIGWBaseURL is required for signed interface`：个人 Trade 缺 testing Billing APIGW 地址。
2. `401 missing authentication credentials`：计费协议只有内层签名，缺 CloudLadder 外层 HMAC。
3. `401 invalid authentication signature`：个人 Trade 与 SG testing CloudLadder 的 HMAC 不一致。

最终确认 `ModifyResourceStatus` 同时要求计费协议内层签名和 CloudLadder 外层 HMAC；普通询价/下单与 Billing APIGW 的签名边界不同。因此代码将 general HMAC 与 billing-only HMAC 分离，只在 signed Billing 路由选择 `TRADE_BILLING_CLOUDLADDER_HMAC_SECRET`，避免把计费专用密钥污染普通 Jifei 路由。

动态路由续租还验证了另一个独立问题：页面 IP 不是可信的回调来源 IP。Auth 在 2026-09-21 16:16:40 UTC 实际观测 `14.116.239.35`，旧 allowlist 只有 `14.22.11.160/29`，因此返回 `target_ip_not_allowed`。追加实测最小池 `14.116.239.32/29` 后，续租成功并落在 `.36`；未放开整段公网网段。

## skill_changes

- testing Billing APIGW URL 固定为 `jifei-billing-apigw-test`，明确拒绝 prod 路由。
- paid-E2E 三项输入只允许来自 0600 私有文件，持久化到 0700 私有目录；state 只保存 SHA-256 fingerprint，不保存明文。
- Trade 与个人 CloudLadder 的 billing HMAC 强制一致，可选用共享 testing fingerprint 前缀 fail closed。
- localstack 支持默认 override 与个人私有 override 分层应用；重跑 `up` 不需要再次提供原始输入文件。
- `ctl-passes` Service Gateway `response_header_timeout` 调整为 30 秒。
- `up` 在构建前执行当前站点跨 SP seed 预检，并在 rollout 后重建 endpoint exposure。
- `central_user_id` 与 `local_user_id` 分离持久化；影子映射 SQL 改为命令参数执行，避免 `kubectl exec -i` 吞 stdin。
- 防止 runtime kustomize wrapper 自递归；Shadow SDK 跟随父仓库 remote 协议并修复仅剩 `.git` 的中断 checkout。
- 注册只提交端口和 TTL；Auth 服务端确认来源 IP。错误输出保留清洗后的业务 `code/message`。

## validation

- `bash .agents/skills/personal-devcloud-environment/tests/contract_test.sh`
- `bash deploy/localstack/tests/shadow_sdk_test.sh`
- `bash deploy/localstack/tests/validate.sh`
- DevCloud 只重跑 `personal-devcloud.sh register`，验证 registration、agent、heartbeat 和 callback probe。
- 全新订单真实支付与三条跨 SP 回调、Pass/Flow/Task/AI Gateway、退款终态。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format text`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-files-file <(git diff --name-only)`
- `git diff --check`

## validation_results

- Trade focused packages：通过。
- CTL Pass/worker/transport focused packages：通过。
- Sandbox provider：`GOWORK=off go test ./internal/provider` 通过。
- Personal DevCloud Skill contract：通过，包含 SG testing CloudLadder/devtunnel allowlist 一致性与禁止全网段规则。
- `shadow_sdk_test.sh` 与完整 `deploy/localstack/tests/validate.sh`：通过；校验使用 Ruby 标准 YAML 库，不要求额外安装 PyYAML。
- Frontend `next-site/__tests__/subscribe-page.test.tsx`：25/25 通过。
- 文档校验与 change-impact：通过；`release-gitops`、`subscription-entitlements`、`agent-gateway-runtime` 的正式设计均随代码同步。
- `bash -n`、Python compile、`gofmt -d`、`git diff --check`：通过。
- 2026-09-21 16:32 UTC 后再次执行个人环境 `status`：页面、Gateway、Trade callback/internal、registration、tunnel、heartbeat、Pods 与 billing HMAC fingerprint 全部通过。
- SG testing 运行时复核：`lightvela-proxy-testing` 两副本与 `devtunnel-testing` 一副本均 `Running/Ready`，两个 allowlist 完全一致。

## safety_boundary

- 未读取、输出或提交 paid-E2E 密钥明文；仓库内只有变量名、默认 testing fixture 和 fingerprint 校验逻辑。
- 只修改个人 DevCloud 和 SG 集群 testing 工作负载；未修改 production 工作负载、生产账号或生产数据库。
- 本地 source desired state 已同步 testing allowlist，但未执行 GitOps 发布。
- 当前 worktree 仍未 commit、push、创建 MR 或发布。
