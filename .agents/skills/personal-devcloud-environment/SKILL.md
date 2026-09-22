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

这里的“一键”是指账号已经具备 testing 资格、余额和 active binding 后，`up` 自动搭建完整个人环境、
对齐身份、注册/续租回调、注入/轮换短期计费能力并启动浏览器入口。账号创建、国际开户和充值目前仍通过
智研账号池与计费助手正式命令完成；仓库内没有已确认的自动充值 API，不得声称“完全无前置自动充值”。

## 安全边界

- 只允许 `cn` 和 `intl` testing；脚本拒绝 production Auth origin。
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

## 从零准备 testing 账号

先打印当前站点的前置条件：

```bash
# 北京使用 cn；韩国使用 intl。
PERSONAL_DEV_SITE=intl \
  bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh prerequisites
```

1. 在智研 testing 账号池创建/导入自己的账号，或占用明确允许共享的空闲账号：
   <https://zhiyan.woa.com/cle/11113/resource/#/resource/account/4/?current=1&pageSize=20>。
   账号必须为“正常”，UIN/APPID 非空，且 `international` 与目标站点一致。
2. 国际新账号在计费助手命令模式执行 `/国际开户` 并确认成功；国内不执行。
3. 两站均使用 `/充值` 调整余额，金额单位为分。保存机器人返回的站别、操作后余额和 `reqId`。
   `/设置金额` 只用于需要精确目标余额的受控场景。余额不足产生的旧 `pending` 单不要重试，充值后
   创建新订单。
4. 在 testing Gateway Dashboard 的“认证用户 → DevCloud 测试绑定”中，把当前 testing 登录用户
   绑定到该 UIN/OwnerUIN/APPID，并确认状态为 `active`。浏览器表单里的 UIN 不是可信身份。

当前没有安全、稳定且已确认的机器人充值 API，所以 Skill 只能把上面步骤教完整，不能复制机器人凭据、
抓取私有接口或硬编码共享账号来假装自动完成。

受控管理员可用 `bootstrap-binding`，但 admin token 只能来自本机 secret provider，不得发给开发者、
写入仓库、shell profile、状态文件或回复。公网 Service Gateway 不暴露 Auth admin 路由，因此还必须
把目标 Auth testing 服务转发到 loopback，并传入 `PERSONAL_DEV_AUTH_ADMIN_BASE_URL`。

## 一键启动

确认当前 checkout 是要验证的代码，然后执行：

```bash
PERSONAL_DEV_SITE=intl \
  bash .agents/skills/personal-devcloud-environment/scripts/personal-devcloud.sh up
```

国内站改为 `PERSONAL_DEV_SITE=cn`。`up` 会完成工具检查/安装、个人 kind 集群、完整 localstack、
testing 登录、本地身份对齐、动态回调注册、短期 capability 注入、个人 Trade 滚动及续租进程。

`PERSONAL_DEV_EMAIL/PERSONAL_DEV_PASSWORD` 只表示中央 testing 账号；本地 Auth 身份使用独立的
`PERSONAL_DEV_LOCAL_EMAIL/PERSONAL_DEV_LOCAL_PASSWORD`，通常无需设置并由脚本随机生成。两组凭据分别
保存在私有 `state.json` 的 `central_*` 与 `local_*` 字段，不能互相覆盖。已有中央账号的 session 失效后，
必须用该账号的 session 或登录凭据续签；脚本不会静默新建另一个国际账号。

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
`401` 才算撤销完成，然后停止 devtunnel。`down` 会先注销，再停止本地工作负载并保留 PVC。
完整回收账号映射时先执行 `release-binding`，再执行 `down`；不要删除 tombstone 后回落共享环境。

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
- 验收以 `status`、相关业务终态、CloudLadder 审计、本机 agent 日志和
  [`tests/contract_test.sh`](tests/contract_test.sh) 为准；HTTP 200、MR 合入或页面状态不能单独证明闭环。
