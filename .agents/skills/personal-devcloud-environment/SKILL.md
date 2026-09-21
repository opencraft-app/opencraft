---
name: personal-devcloud-environment
description: 在个人 DevCloud 从零启动可浏览器点测的完整 LightVela 环境，注入个人测试配置和短期登录态，并按真实 testing 影子账号动态注册国内、国际计费回调。用于个人全功能联调、状态检查和验收；不用于生产发布或生产账号。
---

# Personal DevCloud Environment

在 `mono2` checkout 内使用本 Skill。主要入口是
[`scripts/personal-devcloud.sh`](scripts/personal-devcloud.sh)，不要手工改共享测试环境的 UIN
路由、SOPS 或 Argo 状态来替代注册 API。

## 已验收范围

截至 2026-09-21，这套 Skill 已分别在个人 DevCloud 串行完成两站真实 testing 闭环：

- `cn`：北京国内 testing，覆盖登录、影子账号对齐、动态回调注册、询价、新购支付、跨 SP 变配、
  `checkModify`、`modifyResource`、退款、隔离和销毁。
- `intl`：韩国国际 testing，覆盖同一组环境与计费链路，并验证国际 devtunnel、来源 IP allowlist、
  Billing APIGW 内层签名和 CloudLadder 外层 HMAC。

验收请求与终态证据分别记录在
[`2026-09-20-pass-cross-sp-modify.md`](../../../docs/context/tasks/2026-09-20-pass-cross-sp-modify.md) 和
[`2026-09-21-personal-devcloud-intl-e2e.md`](../../../docs/context/tasks/2026-09-21-personal-devcloud-intl-e2e.md)。

这里的“一键”是指 `up` 自动搭建完整个人环境、对齐 testing 身份、注册/续租计费回调并启动浏览器
入口；它不表示免前置条件。默认模式不支付，真实 paid-E2E 仍要求有效 testing session、可扣费余额和
仓库外 0600 计费签名配置。任一条件缺失时必须 fail closed，不能降级为共享路由、Mock 支付或生产配置。
同一状态目录一次只激活一个站点；北京与韩国应按“当前站点 `down`，目标站点 `up`”串行切换。

## 安全边界

- 只允许 `cn` 和 `intl` testing；脚本拒绝 production Auth origin。
- UIN 只来自当前 testing 登录会话的 active shadow binding，客户端不能提交或覆盖。国内、国际站
  都只提交回调端口和 TTL，来源 IP 由 Auth 从可信代理链确认。国际站经 NAT 时，注册响应中的
  `targetIp` 是服务端观测到的出网来源 IP，不要求等于页面访问使用的 DevCloud IP；需要严格预检时
  可设置 `PERSONAL_DEV_REGISTRATION_SOURCE_IP`。
- 默认 `up` 不读取或下发共享 CloudLadder HMAC、SOPS、`DEVTUNNEL_TOKEN`。显式执行
  `prepare-paid-e2e` 时，只允许从当前站点对应的 testing SOPS 读取三项计费值；调用者必须已拥有
  合法解密权限，脚本只生成个人 0600 override 并打印 fingerprint，不输出明文、不读取 production
  文件或共享 Kubernetes Secret。国内、国际站都只接收绑定 UIN、TunnelHost 和 Auth testing registry
  状态的短期 capability；脚本不把 capability 明文写入状态文件。
- 不操作共享 Kubernetes context。脚本只接受自己创建的 `kind-lightvela-personal-<site>`，
  且 API server 必须是 loopback。
- Auth、CTL、Trade、Payment、Subscription、AI Gateway、Sandbox、Service Gateway 和前端
  均运行当前 checkout 的真实代码；插桩只处理个人环境配置和测试身份，不以 Mock 替代内部服务。
- 国内账号复用智研准备的 testing 账号；国际账号复用可闭环的 testing 账号。Skill 只对齐登录会话、
  active shadow binding 和本地身份，不允许客户端自报 UIN。
- 默认验收只下单不支付，不得描述为支付/发货闭环。不要调用生产、真实支付或生产数据库。
- 真实 testing 支付是显式 opt-in：Skill 不自动读取、解密或复制共享 SOPS/Kubernetes Secret。
  只有使用者从受控渠道准备 0600 私有输入文件后，才安装个人环境所需的计费签名配置。
- `commit`、`push`、MR、GitOps、Argo Sync 和发布仍需用户明确确认。

## 一键启动

首次使用先打印当前站点的完整前置条件：

```bash
# 北京使用 cn；韩国使用 intl。
PERSONAL_DEV_SITE=intl \
  bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh prerequisites
```

该命令会给出智研 testing 账号、国际开户、充值、Gateway Dashboard 影子绑定、受控计费配置和
终态验收的完整步骤。账号池入口是
<https://zhiyan.woa.com/cle/11113/resource/#/resource/account/4/?current=1&pageSize=20>；账号必须为
`正常`，UIN/APPID 非空，且 `international` 与站点一致。国际新账号还必须在计费助手命令模式执行
`/国际开户`。两站余额均通过 `/充值` 调整，金额单位为分，并以机器人返回的“操作后余额”为准。

测试账号准备好后，在 testing Gateway Dashboard 的“认证用户 → DevCloud 测试绑定”中，将当前
testing 登录用户绑定到对应 UIN/OwnerUIN/APPID，确认状态为 `active`。不得把浏览器填写的 UIN
当作可信身份；Skill 始终从当前 testing session 的 active binding 获取账号。

先确认当前 checkout 是要验证的代码，然后执行：

```bash
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh up
```

国内站改为：

```bash
PERSONAL_DEV_SITE=cn bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh up
```

`up` 会自动完成工具检查/安装、个人 kind 集群、完整 localstack、测试账号登录或创建、
本地身份对齐、动态回调注册及续租进程。需要复用预置账号时，通过环境变量传入 testing
凭据或 session；不得把凭据写入仓库、命令输出或报告。

若当前 testing 用户还没有 active shadow binding，优先在 Gateway Dashboard 的
“认证用户 → DevCloud 测试绑定”页面分配 mock 账号。受控 Codex 环境也可从本机 secret
provider 临时取得 `PERSONAL_DEV_ADMIN_TOKEN`，并同时传入 `PERSONAL_DEV_SHADOW_USER_NAME`、
`PERSONAL_DEV_SHADOW_UIN`、`PERSONAL_DEV_SHADOW_OWNER_UIN`、`PERSONAL_DEV_SHADOW_APP_ID`
和 `PERSONAL_DEV_BINDING_REASON`。由于公网 Service Gateway 不暴露 Auth admin 路由，受控环境还需
把 Auth testing 服务转发到 loopback，并通过 `PERSONAL_DEV_AUTH_ADMIN_BASE_URL` 传入该本地地址；
`up` 会从当前 testing session 派生 LightVela user ID，
调用 Auth testing 管理接口完成绑定。admin token 不写入 DevCloud 状态文件、请求正文或输出。
不要把共享 admin token 发给开发者，也不要把上述变量写进仓库或 shell profile。

页面地址自动识别 DevCloud 的 `9.0.0.0/8` 和 `21.0.0.0/8` 地址；显式传入
`PERSONAL_DEV_IP` 时也执行同样校验。Shadow Tencent Cloud SDK 默认跟随父仓库 remote
选择 HTTPS 或 SSH，首次 clone 中断后仅剩 `.git` 的 checkout 会在重跑时自动修复。

Skill 的 runtime kustomize wrapper 会在内存流中注入 DevCloud IP、Auth 回跳、站点和
testing Account/Billing 地址。生成状态只写入私有状态目录，不修改业务源码或生产 manifests。

中央 testing 用户和个人环境用户是两个不同的 `user_id`：中央用户持有真实 testing shadow
binding；个人环境用户只承载本地浏览器 session。`up/register` 会把中央 binding 的
`shadow_user_name / uin / owner_uin / app_id` 写入个人 Auth，并在私有 `state.json` 中分别记录
`central_user_id` 与 `local_user_id`，不能把二者混成同一个账号。

脚本从本地 Auth 申请短期 E2E session 后，只输出一个两分钟内有效、单次消费的随机 nonce URL。
该 URL 在 DevCloud 本机内存中换取登录态，再跳转到前端；session token 不写状态文件、不进入
命令输出、回复、Git、测试报告或 shell history。Codex 完成浏览器登录后，只向用户展示普通页面地址。

成功后以脚本最后打印的地址为准：

- 页面：`http://<DevCloud-IP>:5173`
- API：`http://<DevCloud-IP>:8085`
- 计费回调 listener：`<DevCloud-IP>:18084`
- 一次性登录地址：`http://<DevCloud-IP>:19050/<短期 nonce>`

一次性地址只把本地 session 交给浏览器，不打印 session token；成功使用一次或等待两分钟后
自动失效。地址失效后运行 `browser-login` 生成新的登录入口。

## 验证与日常操作

```bash
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh status
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh browser-login
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh verify-order-no-pay
```

只操作 testing 绑定的受控命令：

```bash
PERSONAL_DEV_SITE=cn bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh bootstrap-binding
PERSONAL_DEV_SITE=cn PERSONAL_DEV_AUTH_ADMIN_BASE_URL='http://127.0.0.1:<受控转发端口>' \
  PERSONAL_DEV_BINDING_RELEASE_REASON='test completed' \
  bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh release-binding
```

`bootstrap-binding` 不接受浏览器自报 user ID，而是从当前 testing session 查询目标用户；
相同映射可幂等重试，改绑和 UIN 转移必须先执行 `release-binding`。绑定、解绑均要求非空原因，
由 Auth 记录包含 request ID、用户、UIN 和原因的结构化审计日志。

`verify-order-no-pay` 只验证询价和创建 `pending_pay` 订单；因为没有支付，所以不期待、也不宣称
收到计费 `checkCreate` 或发货回调。只有当当前 checkout 已实现真实变配 API 时，才能增加并执行
`checkModify` 用例。现有 `verify-checkmodify-no-pay` 会明确失败，防止把普通下单误报成升配覆盖。

## 真实 testing 支付与退款

需要真实新购、支付、变配、退款和销毁时，优先使用受控 SOPS 自助导入。北京和韩国分别只读取
`sandbox-bj-7 + tkexgz`、`sandbox-kr-1 + tkexsg` 的 testing 加密源；不会读取生产文件：

```bash
# 北京使用 cn；韩国使用 intl。
PERSONAL_DEV_SITE=intl \
  bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh prepare-paid-e2e
```

如果当前同学没有 testing SOPS 解密权限，则由 LightVela testing owner 通过受控渠道提供包含以下
三项的仓库外 0600 文件。不要在命令行、聊天、测试报告或 Git diff 中展开值：

```text
JIFEI_BILLING_APP_ID=<testing value>
JIFEI_BILLING_APP_SECRET=<testing value>
TRADE_BILLING_CLOUDLADDER_HMAC_SECRET=<testing value>
```

然后按目标站点执行；国内使用 `cn`，国际使用 `intl`：

```bash
chmod 600 /private/path/paid-e2e.env
# 北京使用 cn；韩国使用 intl。
PERSONAL_DEV_SITE=intl \
PERSONAL_DEV_PAID_E2E_SECRET_FILE=/private/path/paid-e2e.env \
PERSONAL_DEV_EXPECTED_BILLING_HMAC_SHA256=<shared-testing fingerprint prefix> \
bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh up
```

`up` 会完成以下事情：

- 预检当前站点的普通套餐、AI 套餐、AI Gateway plan、SP/PID/CategoryID/SV seed；缺项时在构建前失败。
- 只接受 `jifei-billing-apigw-test` 路由，拒绝 `prod` Billing APIGW 路径。
- 把完整 Secret override 生成到
  `.localstack/personal-devcloud/<site>/private-overrides/`，目录权限 0700、文件权限 0600；原始输入可在
  成功生成后删除。后续 `up` 会复用私有 override，不会被 checked-in 默认值覆盖。
- 同一 HMAC 同时注入个人 Trade 的 billing-only 配置和个人 CloudLadder 的 trade caller；只输出
  SHA-256 fingerprint，并可与共享 testing fingerprint 前缀做 fail-closed 比对。
- 重启完成后重建本机 endpoint exposure，避免 Trade Pod rollout 后旧 `port-forward` 指向已退出 Pod。

个人环境只保存这三项的派生 override。`prepare-paid-e2e` 必须使用调用者已有的 testing SOPS 权限；
没有权限时应按 `prerequisites` 给出的模板向 testing owner 申请，禁止尝试 production SOPS、共享
Kubernetes Secret 或他人 namespace。

注册临近过期或 DevCloud IP 变化时可手工续租：

```bash
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh register
```

## 切站与清理

同一状态目录一次只允许一个站点处于 active。切换前先注销并停止原站点：

```bash
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh down
PERSONAL_DEV_SITE=cn bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh up
```

`down` 会先写 disabled tombstone，再停止本地工作负载并保留 PVC。只注销路由可用
`unregister`。它不会擅自释放共享 mock 账号；完整回收流程是先 `release-binding`，再 `down`。
不要删除 tombstone 后让旧订单静默回落共享环境。

## 失败处理

- 先运行 `doctor`，再看 `.localstack/personal-devcloud/<site>/logs/`。
- `status` 任一依赖失败都按失败处理；不要只凭页面可打开宣称计费链路已通。
- paid-E2E 模式下，`status` 还会校验个人 Trade 与个人 CloudLadder HMAC 完全一致，并只打印
  fingerprint；不一致时立即失败。
- `BillingAPIGWBaseURL is required` 表示缺少 testing Billing APIGW 配置；`401 missing authentication
  credentials` 表示缺 CloudLadder 外层签名；`401 invalid authentication signature` 表示 HMAC 与目标
  testing CloudLadder 不匹配。这三类问题都发生在退款后的 `ModifyResourceStatus`/销毁补发链路，
  不能用询价、新购或 `checkModify` 成功替代验证。
- 任一站点若缺 `tunnelToken`，脚本会注销刚创建的注册并 fail closed；此时检查 testing Auth、
  CloudLadderGateway 和 devtunnel 是否为同一版本，不要补共享 token 到 DevCloud。
- 注册失败会输出经过清洗的业务 `code/message`。`target_ip_not_allowed` 表示 Auth 实际观测到的
  来源 IP 未进入对应 testing CloudLadder/devtunnel 的精确 allowlist；先核对服务端观测值，
  不要把页面 IP或整段公网 CIDR 盲目加入配置。
- 验收以本 Skill 的 `status`、`verify-order-no-pay` 和
  [`tests/contract_test.sh`](tests/contract_test.sh) 为准；真实 testing 回调还必须保留
  CloudLadder 审计与本机 agent 日志作为同一请求的证据。
