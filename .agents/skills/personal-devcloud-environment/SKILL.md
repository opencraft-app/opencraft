---
name: personal-devcloud-environment
description: 在个人 DevCloud 从零启动可浏览器点测的完整 LightVela 环境，注入个人测试配置和短期登录态，并按真实 testing 影子账号动态注册国内、国际计费回调。用于个人全功能联调、状态检查和验收；不用于生产发布或生产账号。
---

# Personal DevCloud Environment

在 `mono2` checkout 内使用本 Skill。主要入口是
[`scripts/personal-devcloud.sh`](scripts/personal-devcloud.sh)，不要手工改共享测试环境的 UIN
路由、SOPS 或 Argo 状态来替代注册 API。

## 安全边界

- 只允许 `cn` 和 `intl` testing；脚本拒绝 production Auth origin。
- UIN 只来自当前 testing 登录会话的 active shadow binding，客户端不能提交或覆盖。国际站只提交
  回调端口和 TTL，由 Auth 从可信代理链派生来源 IP；国内站额外提交自动探测到的 `9.0.0.0/8`
  DevCloud IP，且 Auth 仅在 sandbox 显式开关开启时接受，并把目标严格限制为 `9/8:18084`。
- 不读取或下发共享 CloudLadder HMAC、SOPS、`DEVTUNNEL_TOKEN`。国际站只接收绑定
  UIN、TunnelHost 和 Auth testing registry 状态的短期 capability；脚本不把 capability 明文写入状态文件。
- 不操作共享 Kubernetes context。脚本只接受自己创建的 `kind-lightvela-personal-<site>`，
  且 API server 必须是 loopback。
- Auth、CTL、Trade、Payment、Subscription、AI Gateway、Sandbox、Service Gateway 和前端
  均运行当前 checkout 的真实代码；插桩只处理个人环境配置和测试身份，不以 Mock 替代内部服务。
- 国内账号复用智研准备的 testing 账号；国际账号复用可闭环的 testing 账号。Skill 只对齐登录会话、
  active shadow binding 和本地身份，不允许客户端自报 UIN。
- 默认验收只下单不支付，不得描述为支付/发货闭环。不要调用生产、真实支付或生产数据库。
- `commit`、`push`、MR、GitOps、Argo Sync 和发布仍需用户明确确认。

## 一键启动

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

Skill 的 runtime kustomize wrapper 会在内存流中注入 DevCloud IP、Auth 回跳、站点和
testing Account/Billing 地址。生成状态只写入私有状态目录，不修改业务源码或生产 manifests。

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

`verify-order-no-pay` 只验证询价和创建 `pending_pay` 订单；因为没有支付，所以不期待、也不宣称
收到计费 `checkCreate` 或发货回调。只有当当前 checkout 已实现真实变配 API 时，才能增加并执行
`checkModify` 用例。现有 `verify-checkmodify-no-pay` 会明确失败，防止把普通下单误报成升配覆盖。

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
`unregister`。不要删除 tombstone 后让旧订单静默回落共享环境。

## 失败处理

- 先运行 `doctor`，再看 `.localstack/personal-devcloud/<site>/logs/`。
- `status` 任一依赖失败都按失败处理；不要只凭页面可打开宣称计费链路已通。
- 国际站若缺 `tunnelToken`，脚本会注销刚创建的注册并 fail closed；此时检查 testing Auth、
  CloudLadderGateway 和 devtunnel 是否为同一版本，不要补共享 token 到 DevCloud。
- 验收以本 Skill 的 `status`、`verify-order-no-pay` 和
  [`tests/contract_test.sh`](tests/contract_test.sh) 为准；真实 testing 回调还必须保留
  CloudLadder 审计与本机 agent 日志作为同一请求的证据。
