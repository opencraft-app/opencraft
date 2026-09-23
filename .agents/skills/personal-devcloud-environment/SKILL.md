---
name: personal-devcloud-environment
description: 在个人 DevCloud 从零启动可浏览器点测的完整 LightVela 国内或国际 testing 环境，对齐真实 testing 影子账号，动态注册计费回调并安装短期计费 capability。用于个人全功能联调、状态检查和验收；不用于生产发布或生产账号。
---

# Personal DevCloud Environment

在 `mono2` checkout 内使用本 Skill。主要入口是
[`scripts/personal-devcloud.sh`](scripts/personal-devcloud.sh)。不要手工改共享 testing 的 UIN 路由、
Secret 或 Argo 状态来代替 registration API。

## 能力与证据边界

历史上已分别在个人 DevCloud 完成两站真实 testing 闭环：

- `cn`：北京国内 testing，覆盖登录、影子账号、动态回调、询价、新购支付、同/跨 SP 变配、
  `checkModify`、`modifyResource`、退款、隔离和销毁。
- `intl`：韩国国际 testing，覆盖同一链路，并验证国际 devtunnel、来源 IP allowlist、Billing APIGW
  内层签名和 CloudLadder 外层 HMAC。

历史证据见
[`2026-09-20-pass-cross-sp-modify.md`](../../../docs/context/tasks/2026-09-20-pass-cross-sp-modify.md) 和
[`2026-09-21-personal-devcloud-intl-e2e.md`](../../../docs/context/tasks/2026-09-21-personal-devcloud-intl-e2e.md)。

2026-09-22 起，个人环境不再读取或持有 Jifei AppSecret、CloudLadder HMAC、SOPS/age identity。
`up/register` 从中央 testing Auth 取得绑定当前 UIN 与 TTL 的短期 capability，个人 Trade 只携带该
capability；中央 testing Trade 使用其现有运行时 Secret 代签。此新路径在部署到两个 testing 环境后，
必须重新保存国内、国际真实支付、回调与终态证据；历史闭环或本地单测不能冒充当前 live 验收。

默认模式下，sandbox Auth 从环境 owner 维护的账号池自动租用已具备 testing 资格、余额和 active binding
的账号；新同学不再准备账号密码、admin token、SOPS 或 owner 文件。`up` 自动领取短期 session、搭建完整
个人环境、对齐身份、注册/续租回调、注入/轮换短期计费能力并启动浏览器入口。账号池扩容、国际开户和充值
仍由环境 owner 通过智研账号池与计费助手正式命令完成，不是每位使用者的前置步骤。

## 安全边界

- 只允许 `cn` 和 `intl` testing；脚本拒绝 production Auth origin。
- testing 账号租约接口默认关闭，只能在公共地址精确匹配的 `sandbox-bj-7`、`sandbox-kr-1` Auth 启用；
  账号池配置只含 Auth
  `user_id`，不含密码或云凭据。服务端只选择当前站点合格且 active binding 的候选账号：国内必须完成实名，
  国际必须完成开户映射；两站都重新校验 UIN、OwnerUIN 与 AppID。MySQL 租约、TTL、版本号和 session
  revocation 防止不同 DevCloud 并发复用。首次领取只依赖受控 DevCloud 网络；已有租约的续租必须携带当前
  `developer_lease` session，不能只伪造另一个 DevCloud 的 `targetIp` 冒领新 session。
- 租约 POST/DELETE 只接受 Service Gateway 覆盖并规范化的 `X-Lightclaw-Client-IP`，且必须命中实测的
  DevCloud 出口 allowlist；客户端自报 forwarding header 不生效。组织信任边界仍只是 sandbox-only
  配置、DevCloud 出口和 `9/8`、`21/8` 目标地址，不是独立 WOA OAuth 用户证明；不得把它开放到
  production/staging 或扩大到公网 CIDR。
- UIN 只来自当前 testing 登录会话的 active shadow binding，客户端不能提交或覆盖。
- 国内提交脚本发现并校验过的 DevCloud `9/8` 或 `21/8` 地址、回调端口和 TTL；这是因为北京公网
  Gateway 之后的代理链无法稳定保留开发机源地址。国际只提交端口和 TTL，经 NAT 时注册响应的
  `targetIp` 以服务端观测值为准，不要求等于浏览器访问的 DevCloud IP。
- `up/register` 不读取或下发共享 HMAC、AppSecret、SOPS、age identity、`DEVTUNNEL_TOKEN` 或共享
  Kubernetes Secret。capability 只注入个人 kind 的 `trade-runtime-secrets`，不写入 `state.json`、
  日志、回复、测试报告或 Git。
- capability 只允许固定 testing billing 路径和动作。Jifei 请求在 Auth 与中央 Trade 校验
  `ownerUin/uin`；Billing CloudAPI 的用户身份继续由当前影子账号短期 TC3 凭证校验，客户端不能提交
  `X-Qcloud-User-Id`，该 testing 路由账号只由中央 Trade 注入。续租会轮换 digest；过期、disabled 或
  `unregister` 后旧 capability 必须返回 `401`，且不会回落共享路由。
- 脚本只接受自己创建的 `kind-lightvela-personal-<site>`，且 Kubernetes API server 必须是 loopback；
  不操作共享 Kubernetes context。
- Auth、CTL、Trade、Payment、Subscription、AI Gateway、Sandbox、Service Gateway 和前端均运行
  当前 checkout 的真实代码；插桩只处理个人环境配置和测试身份，不以 Mock 替代内部服务。
- 默认验收只下单不支付，不得描述为支付/发货闭环。不要调用生产、真实支付或生产数据库。
- `commit`、`push`、MR、GitOps、Argo Sync 和发布仍需用户明确确认。

## 从零启动

先打印当前站点的前置条件：

```bash
# 北京使用 cn；韩国使用 intl。
PERSONAL_DEV_SITE=intl \
  bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh prerequisites
```

正常使用不需要逐项人工准备。全空私有 state 会按 DevCloud 地址从对应 sandbox 领取账号租约；池满时
返回 `409 developer_test_account_busy`，不得绕过并发占用或改用生产账号。

环境 owner 扩容账号池时才执行以下一次性工作：在
<https://zhiyan.woa.com/cle/11113/resource/#/resource/account/4/?current=1&pageSize=20>
准备状态正常、UIN/APPID 完整且站点匹配的 testing 账号；国际账号完成 `/国际开户`；使用 `/充值` 充值；
国内账号完成实名，在 testing Gateway Dashboard 建立 active binding；最后只把持有该 active binding 的
中央 Auth `user_id`（不是个人 localstack 用户）加入该 sandbox 的
`PERSONAL_DEV_ACCOUNT_POOL_USER_IDS`。不得把账号密码、机器人凭据、admin token 或 SOPS identity 放入配置。

## 一键启动

确认当前 checkout 是要验证的代码，然后执行：

```bash
PERSONAL_DEV_SITE=intl \
  bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh up
```

国内站改为 `PERSONAL_DEV_SITE=cn`。`up` 会完成工具检查/安装、个人 kind 集群、完整 localstack、
testing 登录、本地身份对齐、动态回调注册、短期 capability 注入、个人 Trade 滚动及续租进程。

默认中央身份来自短期账号租约。`PERSONAL_DEV_SESSION_TOKEN` 或
`PERSONAL_DEV_EMAIL/PERSONAL_DEV_PASSWORD` 只保留给已有受控 testing 账号的兼容模式；本地 Auth 身份使用独立的
`PERSONAL_DEV_LOCAL_EMAIL/PERSONAL_DEV_LOCAL_PASSWORD`，通常无需设置并由脚本随机生成。两组凭据分别
保存在私有 `state.json` 的 `central_*` 与 `local_*` 字段，不能互相覆盖。兼容模式下已有中央账号的
session 失效后必须用同一账号的 session 或登录凭据续签；租约模式则对同一 DevCloud 幂等续租，不会
并发占用第二个账号。

中央 testing 用户与个人环境用户是两个不同的 `user_id`：中央用户持有真实 testing shadow binding；
个人用户只承载本地浏览器 session。`up/register` 把中央 binding 的
`shadow_user_name / uin / owner_uin / app_id` 写入个人 Auth，并在私有 `state.json` 记录
`central_user_id` 与 `local_user_id`；不能把二者混成同一个账号。registration 返回的 capability 只在
进程内和个人 kind Secret 中短暂存在；每次续租覆盖旧值并滚动个人 Trade。

脚本从本地 Auth 申请短期 E2E session 后，只输出一个两分钟内有效、单次消费的随机 nonce URL。
session token 不写状态文件、不进入命令输出、回复、Git、测试报告或 shell history。地址失效后运行
`browser-login` 生成新入口。

成功后以脚本打印的地址为准：

- 页面：`http://<DevCloud-IP>:5173`
- API：`http://<DevCloud-IP>:8085`
- 计费回调 listener：`<DevCloud-IP>:18084`
- 一次性登录入口：`http://<DevCloud-IP>:19050/<短期 nonce>`

## 状态与非支付验证

```bash
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh status
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh browser-login
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh verify-order-no-pay
```

`verify-order-no-pay` 只验证询价和创建 `pending_pay` 订单；因为没有支付，所以不期待、也不宣称收到
计费 `checkCreate` 或发货回调。`verify-checkmodify-no-pay` 会明确失败，防止把普通下单误报成升配覆盖。

`status` 会用个人 Trade Secret 中的 capability 向中央 Auth 发一个无计费副作用的 readiness 探针：

- `200` + `{"code":"OK","message":"ready"}`：capability 有效，且请求已穿透中央 Auth 与中央 Trade；
  Trade 在调用 Jifei/CloudAPI 前终止探针。
- `401`：capability 已过期、撤销或被续租轮换；重新执行 `register`。
- 其他状态：中央 proxy、网络或配置异常，不能宣称计费链路已通。

## 真实支付、变配、退款与销毁

完成账号、余额和 active binding 后，`up` 已具备真实 testing 计费能力，无需个人准备长期 Secret。
通过浏览器入口或当前 checkout 已实现的 testing API 发起流程。验收至少保存同一笔业务链的：

1. 询价目标 bundle、币种和非负差价；变配必须保持源地域，缺目标容量时在支付前拒绝。
2. 新订单支付结果；余额不足的旧 `pending` 单不复用。
3. 计费 `checkModify` 请求和 LightVela 响应，不能只凭前端“处理中”。
4. `modifyResource`/资源回调、Trade Flow、订单、Pass、Task 和实例终态。
5. 退款订单/流水，以及隔离、销毁和 `ModifyResourceStatus` 回调。
6. `unregister` 后旧 capability 返回 `401`，再执行 `down`。

真实 paid-E2E 不是 `up` 的默认副作用；不要自动创建付费订单或退款。只有用户明确要求真实测试时才执行，
并优先使用新订单，不尝试恢复余额不足或状态不明的历史订单。

支付、退款和销毁请求都按“最多提交一次”处理。客户端超时、`502/504`、`Empty reply` 或 port-forward
重连不等于上游没有受理：先按 transaction/event/deal 查询 Trade 日志，再查 `trade_order`、
`trade_flow`、CTL Pass/Task/实例终态。只有同时证明计费未生成订单/Flow、业务库未落单且回调未到达时，
才能创建一笔**新**请求；禁止重放原请求。testing 的 `order-and-pay` 曾在客户端收到超时后继续收到
`checkCreate/createResource` 并生成 active Pass，这类情况必须按已支付成功收敛，不能再次扣费。

## 切站与清理

同一状态目录一次只允许一个站点 active：

```bash
PERSONAL_DEV_SITE=intl bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh down
PERSONAL_DEV_SITE=cn bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh up
```

`unregister` 会保留 disabled tombstone，使用仍在个人 Secret 中的旧 capability 发起撤销探针，只有返回
`401` 才算撤销完成，然后停止 devtunnel。正常清理直接执行 `down`：先写 tombstone，再释放租约并撤销
该用户全部 developer-lease sessions，最后停止 localstack 并保留 PVC。`release-binding` 是显式提前回收
命令，也严格执行 unregister → release；其后再执行 `down` 不会重新领取账号。不要删除 tombstone 后回落共享环境。

## 失败处理

- 先运行 `doctor`，再看 `.localstack/personal-devcloud/<site>/logs/`。
- `status` 任一依赖失败都按失败处理；页面可打开不等于计费链路已通。
- `personal_dev_capability_invalid`：capability 过期、撤销或 digest 不匹配；重新 `register`。
- `personal_dev_uin_mismatch`：请求 UIN 与 active binding 不一致；修复 testing binding，禁止改 header 绕过。
- `PersonalDevBillingProxyFailed`：中央 Trade 代签/转发失败；用 transaction ID 查 CloudLadder/计费流水。
- registration 若缺 capability 或本机 devtunnel-agent 启动失败，脚本会立即 DELETE 注册并 fail closed。
- Linux localstack 由 supervisor 自动重建失效的 `kubectl port-forward`。Pod rollout 的重连窗口内，单个
  请求仍可能失败；查看对应 `localstack/logs/<name>.log`，按上面的“先查终态、禁止盲重试”规则处理。
- 多目标变配询价应并行返回并保持服务端策略顺序；当前 CTL 单目标预算 20 秒，Service Gateway
  `ctl-passes` 上游预算 30 秒。任一目标询价失败时整条请求失败，不能把临时故障展示成“无可升级套餐”。
- `target_ip_not_allowed`：Auth 观测到的来源 IP 未进入对应 testing allowlist；核对服务端观测值，不要把
  页面 IP 或整段公网 CIDR 盲目放开。
- `developer_test_account_source_forbidden`（HTTP 403）：按下述顺序排查，不要先怀疑网段。
  1. **先确认 Auth Pod 是否已滚动**。`PERSONAL_DEV_ACCOUNT_LEASE_SOURCE_CIDRS` 只在进程启动时解析，
     改 ConfigMap 不会自动重启 Pod；新旧 Pod 并存时同一台 DevCloud 会随机命中旧 Pod 而 403。
     修复方式是在 gitops 与 master 的 Deployment pod template 同步更新
     `lightclaw.tech/config-revision` 注解强制滚动，不是继续放宽网段。
  2. 再核对服务端观测到的来源 IP 是否落在 allowlist 内（当前为 `9.0.0.0/8`、`21.0.0.0/8`、
     `14.22.11.160/27`、`14.116.239.32/27`）。
  3. 采样要能区分变量：至少 12 次，并分别用“复用单连接”和“每次新建连接”两组对照；
     `curl ifconfig.me` 与业务请求是两条独立连接，不能用来给业务请求的 403 归因。
  4. 本机 Mac 直连必然 403，租约请求只能从 DevCloud 发起。
- `developer_test_account_busy`：池内账号都处于有效租约；等待其他 DevCloud `down`/TTL，或由环境 owner
  按正式流程扩容，不得复用仍有 active callback 的账号。
- `developer_test_account_renewal_requires_session`：目标 DevCloud 已有有效租约，但请求未证明持有当前
  `developer_lease` session；使用私有 state 中的现有 session 续租，不得无认证重领。
- 验收以 `status`、相关业务终态、CloudLadder 审计、本机 agent 日志和
  [`tests/contract_test.sh`](tests/contract_test.sh) 为准；HTTP 200、MR 合入或页面状态不能单独证明闭环。
