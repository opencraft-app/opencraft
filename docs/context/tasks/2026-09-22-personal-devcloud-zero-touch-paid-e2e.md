---
id: personal-devcloud-zero-touch-paid-e2e
type: task
scope: Personal DevCloud testing-only billing capability broker and zero-touch paid E2E bootstrap.
triggers: ["personal DevCloud", "paid E2E", "testing billing capability", "zero touch"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-22-personal-devcloud-zero-touch-paid-e2e.md
status: active
reviewed_at: 2026-09-22
review_due: 2026-10-22
revision: 1.0.0
precedence: task
derived: false
---

# Personal DevCloud zero-touch paid E2E

## goal

让普通内部开发者只凭 testing 登录态执行 `personal-devcloud.sh up`，即可在个人 DevCloud
拉起国内或国际环境、注册影子账号与计费回调，并取得与注册 UIN、TTL 绑定的短期 testing
计费代理能力；个人环境不再解密或持有共享 Jifei/CloudLadder 长期密钥。

## non_goals

- 不改变 production/staging 计费调用、Secret、路由或发布状态。
- 不把 SOPS age 私钥、Jifei appSecret、CloudLadder HMAC 或解密 payload 写入 Git、Skill、
  state、日志或用户回复。
- 不把个人 DevCloud 变成任意接口/任意 UIN 的通用内网代理。

## requirement_ids / requirement_refs / requirement_excerpt

- TAPD `1010132091137784162`：Pass 变配及完整计费闭环。
- 用户要求（2026-09-22）：新同学拿到 Skill 后不需要理解 SOPS、找 owner 或复制 Secret，
  能直接完成国内/国际 testing 闭环。

## interface_refs / data_structure_refs

- `POST /auth/dev-environments/registration`：基于 testing session 和 active shadow binding
  签发短期 capability。
- `developer_route_registrations.tunnel_token_hash`：只保存 capability 摘要；disabled/expired
  必须立即撤销代理能力。
- 新增 testing-only billing proxy：Auth 校验 capability；Jifei 同时校验业务 UIN，Trade 使用共享
  testing runtime Secret 代签/转发；个人 Trade 只持有短期 capability。
- 允许的 Jifei 签名接口首期固定为 `qcloud.operation.ModifyResourceStatus`；CloudAPI 仅允许
  `CreatePayUrl` / `DescribeOrderList`。用户身份由影子账号短期 TC3 凭证校验；
  `X-Qcloud-User-Id` 是站点级 testing 路由账号，不是购买用户 UIN，个人客户端不得提交，只能由中央
  Trade 注入。

## history_context

- `current_design_refs`：
  - `docs/context/tasks/devcloud-personal-environment-self-service.md`
  - `docs/context/tasks/2026-09-21-personal-devcloud-intl-e2e.md`
  - `docs/engineering/domains/site-environment-routing.md`
  - `docs/engineering/domains/identity-access.md`
  - `docs/engineering/domains/subscription-entitlements.md`
- `relevant_evolution`：MR !4380 加入从 testing SOPS 导入三项长期配置的临时能力；真实检查
  发现 testing 与 production SOPS recipient 相同，不能把 age identity 分发给 Skill 用户。
- `superseded_refs`：`prepare-paid-e2e` 本地 SOPS/0600 owner 文件方案仅作为过渡实现，不再是
  最终自助契约。

## acceptance

- `up` 不调用 `sops`，不要求 `PERSONAL_DEV_PAID_E2E_SECRET_FILE`、owner 文件或 admin token。
- capability 只对当前 active UIN 有效，TTL 到期或 unregister 后代理返回拒绝。
- 个人 Trade 的 signed Jifei 与 Billing CloudAPI 请求经 testing 中央代理完成；Jifei 错误 UIN、
  CloudAPI 错误 action/客户端路由账号、production host/path 均 fail closed。
- 国内/国际 contract、Auth、Trade focused tests、localstack validation、Secret scan 和文档门禁通过。
- live testing 最终仍须分别保存真实支付、回调、订单/Pass/Task 终态证据；未执行时不得宣称闭环。

## affected_paths

- `.agents/skills/personal-devcloud-environment/**`
- `user/auth/**`
- `trade/**`
- `argocd/services/lightclaw-auth/sandbox-bj-7/**`
- `argocd/services/lightclaw-auth/sandbox-kr-1/**`
- `argocd/services/trade/sandbox-bj-7/**`
- `argocd/services/trade/sandbox-kr-1/**`
- `docs/engineering/domains/{identity-access,subscription-entitlements,release-gitops}.md`

## required_context

- 根 `AGENTS.md`、`user/auth/AGENTS.md` 与 `trade/AGENTS.md`。
- Context router query `personal DevCloud testing billing capability proxy skill auth trade gitops` 命中
  `release-gitops`、`identity-access` 与 `commerce-trade-ops`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@7595dcaeb` | P0、Task Pack 与验证边界 | 限制 Secret、生产与发布动作 |
| `.agents/skills/personal-devcloud-environment/SKILL.md@7595dcaeb` | 当前使用契约 | 删除本地长期密钥前置 |
| `docs/context/tasks/devcloud-personal-environment-self-service.md@7595dcaeb` | 动态 UIN 路由真源 | 复用 registration/capability/TTL |
| `docs/context/tasks/2026-09-21-personal-devcloud-intl-e2e.md@7595dcaeb` | 真实踩坑与 paid E2E 证据 | 保留 Billing APIGW 双层认证语义 |
| `docs/context/project/adjacency/cloudladdergateway.md@7595dcaeb` | 计费代理邻接要求 | 检查配置与相邻测试 |
| `docs/engineering/domains/identity-access.md@7595dcaeb` | session、shadow、内部 token 边界 | capability 必须绑定 active identity |
| `docs/engineering/domains/site-environment-routing.md@7595dcaeb` | 双站 testing/production 隔离 | 只开放 sandbox-bj-7 / sandbox-kr-1 |
| `docs/engineering/domains/subscription-entitlements.md@7595dcaeb` | 支付闭环证据标准 | 禁止用 HTTP 200 冒充终态 |
| `user/auth/AGENTS.md@7595dcaeb` | Auth 正式配置与 Secret 边界 | capability proxy 默认关闭、sandbox 显式启用 |
| `trade/AGENTS.md@7595dcaeb` | 计费 provider 与内部接口边界 | 中央 Trade 代签、幂等与测试要求 |
| `docs/context/domains/release-gitops.md@7595dcaeb` | GitOps 验收边界 | 源码与 testing 发布证据分离 |
| `docs/context/domains/identity-access.md@7595dcaeb` | capability 身份约束 | UIN、TTL、disabled 必须 fail closed |
| `docs/context/project/services/trade.md@7595dcaeb` | Trade 派生上下文 | 外部计费仍以 provider 为 authority |

## evidence

- 2026-09-22：四份 testing SOPS 与上海/新加坡 production SOPS 使用同一 age recipient；
  当前开发机无可用 age identity，真实 `sops --decrypt --extract` 失败且未输出明文。
- MR !4380 已于 2026-09-21 合入；过渡实现位于 commit `7b86f980a`。
- 2026-09-22：Skill contract suite 覆盖 capability 注入/轮换不落 `state.json`，以及 `unregister`
  后旧 capability 必须返回 `401`；Auth handler 覆盖 active→disabled 同 token 从 200 变 401。
- 2026-09-22：Auth 与 Trade focused Go tests 通过；Trade internal proxy 错误响应已改为固定消息，
  不把下游错误或 capability 内容返回给个人环境。
- 2026-09-22：仓库与 iWiki 检索未找到 `/充值`、`/设置金额` 的正式可编程契约。当前只能把智研账号、
  国际开户、计费助手充值和 active binding 的自助步骤写入 Skill，不能伪造自动充值。

## risks

- 代理滥用：Auth 必须从 capability 解析 UIN，并逐请求验证 registry active/TTL/digest；Trade
  再校验业务 body/header UIN，接口与 upstream 使用静态 allowlist。
- capability 泄露：只注入个人 kind Secret，不写 state/stdout；轮换后旧 token 因 digest 更新失效。
- 跨环境：代理目标由 shared testing 服务端配置决定，客户端不能提交 URL、host 或 route ID。
- 生产回归：新逻辑默认关闭；只有两个 sandbox Auth overlay 显式开启。
- 账号资金：中央代签不等于账户有余额。没有正式 funding API 前，`up` 只能在已有余额的合法 testing
  账号上实现一键环境和计费链路，不能自动获得额度。

## validation

- `bash .agents/skills/personal-devcloud-environment/tests/contract_test.sh`
- `cd user/auth && go test ./internal/devroute ./internal/httpapi ./cmd/lightclaw-auth`
- `cd trade && go test ./internal/jifeiclient ./internal/cloudbillingclient ./internal/personaldevbilling ./internal/httpapi/internalapi ./internal/httpapi ./internal/config ./cmd/trade`
- `bash deploy/localstack/tests/validate.sh`
- `python3 <skill-creator>/scripts/quick_validate.py .agents/skills/personal-devcloud-environment`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions

- 不拆发当前 production/testing 共用的 age identity，也不把 testing 明文长期密钥下发到个人环境。
- 复用 registration 已签发的一次返回 capability；Auth 负责身份/TTL/digest，Trade 负责业务
  白名单、UIN 二次校验以及使用当前 testing runtime Secret 代签。
- 测试账号余额准备优先通过公司 testing 账号工具的受控接口或预充值池自动完成；在正式接口
  尚未接入前，Skill 必须明确报告该外部能力缺口，不能伪造充值成功。
- `status` 使用不在 allowlist 的 Jifei envelope 做只到 Auth 的策略探针：有效 capability 为 403，
  disabled/expired/rotated capability 为 401；该探针不能到达中央 Trade 或 Jifei。
- `unregister` 保留旧 capability 在个人 Secret 中完成 401 撤销验证；只有随后 `down` 才停止本地工作负载。

## scan_scope

- `.agents/skills/personal-devcloud-environment/**`
- `user/auth/internal/{devroute,httpapi}/**`
- `trade/internal/{jifeiclient,cloudbillingclient,httpapi}/**`
- 双站 sandbox Auth/Trade 非敏感 overlay。

## scan_output

- 有界定位结果记录在本 Pack，不生成含 Secret 的扫描文件。

## handoff

- 本地实现与 focused test 已进入收口阶段；尚未 commit、push、创建 MR、部署 testing 或宣称 live 闭环。
- 下一步完成全量门禁、静态/可渲染 GitOps 校验与 secret scan；合入部署后再分别做北京、韩国真实 paid-E2E。
