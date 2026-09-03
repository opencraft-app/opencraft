---
name: personal-billing-devenv
description: 当开发者要在自己的 DevCloud 上搭个人测试环境、接腾讯云计费（jifei）测试环境做真实回调联调时使用。覆盖自助注册专属影子账号 uin、把本地栈切到国际站、申领 jifei-callback-dev-N 回调槽位、部署 devtunnel 反向隧道与 agent、下单不支付验证真实 checkCreate 落到本机，以及回调打不回来（稳定 10s 超时 / context deadline exceeded）时如何定位。
---

# 个人 DevCloud 真实计费联调环境

在自己的 DevCloud 上跑本地栈，**出站**打到 jifei 测试环境真实计费，**入站**让 jifei 的真实回调穿回本机的 trade。

难点不在本地栈，在**回调怎么回来**：jifei 只能配一个固定回调地址，而 TKEx 反向连不到 DevCloud。解法是云梯按回调体里的 `uin` 把请求改派到你的槽位，再经 devtunnel 反向隧道由你机器上的 agent 主动拉走。

**走国际站**（`sandbox-kr-1`）。国内站需要人脸核身实名，无法自助完成，账号请走智研（CLE）手工申请。

## 铁律

1. **只用自己的影子账号 uin**。共享 uin（如 `700000164995`）不在改派表里，回调会兜底到共享环境，在别人环境里静默建出属于不存在用户的 active pass，且不报错。
2. **不碰生产**：不改 `lightvela-proxy`（prod）/ `lightvela-proxy-staging`、不改 prod/staging 的 `*-platform.env`。只动 `-testing` 资源。
3. **不点 app 级 Argo Sync**。手动 sync 时只勾自己那几个 testing 资源，否则会把别人积压的待同步项（含生产）一起放出去。
4. **只做「询价」和「下单不支付」**。不要打 `place-and-pay` / `pay-url`，那会产生真实支付动作。仓库里没有任何护栏会拦住你。
5. token 只存 600 权限文件，不进 argv、不进 shell history、不进仓库。

## 拓扑：出站和入站是两条独立的路

```
出站（询价 / 下单）
  DevCloud trade → 云梯 testing CLB /v1/proxy/jifei-test → jifei 测试环境

入站（jifei 主动回调）
  jifei → 云梯 testing → 按回调体 uin 改派 jifei-callback-dev-N
        → devtunnel 服务（按 Host 分流） → DevCloud agent 长轮询取任务
        → 回放到本机 http://127.0.0.1:18084/trade/jifei/callback → 响应沿原路回传
```

国内站落 tkexgz testing，国际站落 tkexsg testing，两套各一份 devtunnel，互不相干。

## 先分清两个 uin（最容易混）

| | 值示例 | 管什么 |
|---|---|---|
| 出站 header `JIFEI_CGW_X_QCLOUD_USER_ID` | 国际站 `450860000002` | **环境身份**。只告诉 jifei「我是测试环境调用方」，据此决定回调发给哪套云梯。**与落哪台开发机无关，别填自己的 uin** |
| 下单报文里的 `uin` | 你自己的，如 `450860000011` | **决定落点**。云梯读它查改派表，命中则转给你的 `jifei-callback-dev-N` |

两者互不干扰。填反了的典型症状：回调压根不发。

## 步骤 0：准备本地栈

需要一套**含 `trade` 和 `ctl`** 的栈，trade 监听 `127.0.0.1:18084`，且 trade 的 jifei 出向指向**真实云梯**。

> ⚠️ **已知缺口：仓库里现成的两套本地栈都不能直接用于本 SOP。**
>
> | | 现状 | 为什么不能直接用 |
> |---|---|---|
> | `deploy/local`（docker-compose） | 只有 auth / payment / subscription / ai-gateway / sandbox / service-gateway / frontend | **没有 `trade`、`ctl`、`fake-jifei`**，计费链路无从谈起 |
> | `deploy/localstack`（Kustomize + 本地 K8s） | **有** trade / ctl / shadow / cloudladdergateway，都是真实服务二进制 | ① 上下文守卫只认 `orbstack` / `docker-desktop`，镜像硬编码 `linux/arm64`（`localstack.sh:65,202`）——**DevCloud 是 Linux x86，跑不了**；② 它的 jifei 出向默认指向集群内 fake（`trade/kustomization.yaml` 的 `JIFEI_CGW_GATEWAY_URL` 指 in-cluster cloudladdergateway → fake-jifei），且 `JIFEI_CGW_X_QCLOUD_USER_ID=700000164995` 正是**铁律 1 禁用的共享 uin**，照抄会污染共享环境 |
>
> 所以要让本 SOP 真正可复用，需要先补其中一条路：把 `trade` / `ctl` 补进 `deploy/local`，或让 `localstack` 支持 Linux x86 且能把 jifei 出向切到真实云梯。**在此之前，本 SOP 从步骤 1 开始，适用于已经有含 trade 本地栈的人。**

## 步骤 1：自助注册拿到专属 uin

国际站注册入口是**邮箱+密码**，不是手机号。不发短信、不需要真实收件箱、不需要实名、可无限重复（换个邮箱就是一个新 uin）。

```bash
B=https://api-sandbox-kr-1.lightclaw.tech
EMAIL="lv-intl-$(date +%s)@example.com"

# 1) 注册，直接拿到会话
TOKEN=$(curl -sS -X POST "$B/auth/password/sign-up" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"intl-dev\",\"email\":\"$EMAIL\",\"password\":\"<至少 8 位>\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["sessionToken"])')

# 2) 触发影子注册 + 自动开通计费账户（必须重试，见下）
for i in 1 2 3 4 5; do
  curl -sS -X POST "$B/auth/shadow/binding/retry" -H "Authorization: Bearer $TOKEN"
  sleep 8
done

# 3) 读 uin
curl -sS "$B/auth/shadow/binding" -H "Authorization: Bearer $TOKEN"
```

拿到形如 `krsbx_u5266971417 / uin=ownerUin=450860000011 / appId=1374212056 / status=active` 即成功。

要点：

- **token 字段是 `session.sessionToken`**，不是 `session.token`；响应只有 `session` 一个顶层键。
- **第一次 retry 报错是正常的**：会返回 `status=failed` + `FailedOperation.UinNeedBaseInfo`，这是云侧账号建档延迟的中间态，**约 20 秒后自愈**，实测第 3 次成功。看到 `failed` 别急着判此路不通。
- **不需要验证邮箱**：密码注册建号时 `email_verified` 直接置真。邮箱域名有一次性邮箱黑名单，常用域名（`gmail.com` / `example.com` / `qq.com` 等）均放行。
- **不需要实名**：全程 `realnameVerified: false` 也能 active。
- 若返回 `FailedOperation.UinNeedBindCard`（需绑卡），这条路走不通，换账号来源。

国内站账号请走智研（CLE）手工申请，不要在国内站尝试自助注册——能拿到 uin，但下单必然被 jifei 以 `800200 未实名认证` 拒绝，而该环境实名模式要求活体人脸核身。

## 步骤 2：本地栈切国际站

| 变量 | 值 | 说明 |
|---|---|---|
| `LIGHTVELA_SITE_KIND` | `intl` | 注意不是 `TRADE_SITE_KIND`——后者只是 CI 的替换占位符，代码不读它 |
| `LIGHTVELA_TRADE_REGION` | `ap-singapore` | — |
| `JIFEI_CGW_GATEWAY_URL` | `http://43.153.246.14/v1/proxy/jifei-test/interfaces/interface.php` | **必须指 tkexsg testing**。用国内站那个云梯会把 Host 重写成 `trade.itd.com`，打不到国际站计费 |
| `JIFEI_CGW_X_QCLOUD_USER_ID` | `450860000002` | 环境身份，见上文「两个 uin」 |

本地库还要有**国际站**的商品规格：从 `sandbox-kr-1` 的 `trade_bundle_definition` 取国际站定义（`sp_lighthouse_lightvela_bundle_intl` / pid `1059132` / purchase `2025255`、renew `2025256`）。用国内站规格会被 jifei 以 `100001 param error` 拒绝。

**自检**：跑一次询价，拿到 **USD** 报价即通过。出向报文里应有 `extraPara={"site":"2","language":"en"}`、`currency=USD`、`regionId=9`。

## 步骤 3：申领一个回调槽位

槽位池已预留在 `cloudladdergateway/config.example.yaml`（`jifei-callback-dev-1/2/3`，`base_url` 是黑洞占位）。**申领只改环境变量，不用重建镜像。**

改 `argocd/services/cloudladdergateway/tkexsg/statefulsetplus-testing.yaml`（国内站则是 `tkexgz/`），三处：

```yaml
- name: CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_UIN_ROUTES
  value: <你的uin>=jifei-callback-dev-N        # 多人用逗号分隔
- name: CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_N_BASE_URL
  value: http://devtunnel-testing.<namespace>.svc.cluster.local:8080
- name: CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_N_HOST_HEADER
  value: <每人唯一>.tunnel.internal            # devtunnel 靠它分流
```

`argocd/services/**` 是 source-facing 真源，合入 master 后由 auto-pin 投影到 `gitops` 并自动合并，**不需要手写第二个 gitops MR**。但合入不等于生效：合完要**手点 Sync，只勾 testing 资源**。

只改 `-testing` 那份文件。

## 步骤 4：部署 agent

二进制本地交叉编译成静态 ELF（DevCloud 上没有 Go 工具链和仓库）：

```bash
cd cloudladdergateway && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -o /tmp/devtunnel-agent ./cmd/devtunnel-agent
scp -P 36000 /tmp/devtunnel-agent <you>@<your>.devcloud.woa.com:~/devtunnel-agent
```

token 经 stdin 落到 600 文件，不要写进命令行（argv 会被 `ps` 看到）：

```bash
ssh <devcloud> 'umask 077; cat > ~/.devtunnel.token' < /tmp/dt.token
```

启动（`$(cat ...)` 让 token 只进进程环境，不进 argv）：

```bash
cd ~ && DEVTUNNEL_TOKEN="$(cat ~/.devtunnel.token)" setsid nohup ~/devtunnel-agent \
  -hub http://<云梯 CLB>/v1/proxy/devtunnel \
  -env <你的>.tunnel.internal \
  -local http://127.0.0.1:18084 \
  -allow-prefix /trade/jifei/callback \
  > ~/devtunnel-agent.log 2>&1 < /dev/null &
```

| 操作 | 命令 |
|---|---|
| 看日志 | `tail -f ~/devtunnel-agent.log` |
| 确认挂上 | 启动行有 `auth=true`，且后续无 `poll error` |
| 停止 | `pkill -f 'devtunnel-agent -hub'` |

`setsid` 是必须的，否则 ssh 会话退出时 agent 被 SIGHUP 带走。

## 步骤 5：验收（下单不支付）

`POST /internal/trade/orders` 会让 jifei **同步回调一次** `lightvela.pass.checkCreate`。不涉及支付、不触发发货、按设计连 `trade_flow` 都不写，是零副作用的真实回调探针。

```bash
# token 从容器 env 取，经 curl -K 配置文件传，不进 argv
umask 077; CFG=$(mktemp)
TOK=$(docker inspect <trade-容器> --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | sed -n 's/^LIGHTCLAW_INTERNAL_SERVICE_TOKEN=//p')
printf 'header = "Authorization: Bearer %s"\n' "$TOK" > "$CFG"; unset TOK

curl -sS -m 90 -K "$CFG" -X POST http://127.0.0.1:18084/internal/trade/orders \
  -H 'Content-Type: application/json' \
  -d '{"externalUserId":"probe_'"$(date +%s)"'","uin":"<你的uin>","appId":"<你的appId>",
       "bundleId":"bundle_cruise_01","period":1,"timeUnit":"m","goodsNum":1,"payMode":1}'
rm -f "$CFG"
```

三个入参要求，缺一个就会得到误导性结果：

- **`externalUserId` 必须全新**。checkCreate 会做互斥占用判定，该用户已有 pass 就返 `600106`，jifei 拒单——看起来像链路坏了，其实是业务规则。
- **显式传 `uin` / `appId`**，这样跳过 binding 反查，让「落点 uin」和「配额校验用的 externalUserId」各管一层。
- **bundle 选 ONLINE 且非点石活动**，要在 `trade_bundle_definition` 里有定义。`bundle_cruise_01` 合适。

### 成功判据（三条都要对上）

1. 接口返回 `{"dealName":"...","bigOrderId":"..."}`，HTTP 200，约 2~4 秒。**拿到 dealName 才证明 jifei 真的消费了我们的响应**，不只是收到请求。
2. 云梯审计出现 `"operation":"jifei-callback-dev-N"`、`upstream_url` 指向 devtunnel svc、`status_code:200`、`duration_ms` 几十毫秒。`request_body_bytes` 国际站约 **863**、国内站约 **1001**——手工探针只有几十字节，用这个区分真假流量。
3. agent 日志新增 `rid=... → 200 (NNNB)`，`NNN` 与审计的 `response_body_bytes` **完全吻合**，说明是同一个响应穿回去的。

### 无污染核验

`ctl.pass` 与 `trade.trade_flow` 行数应**不变**（未支付 → 不发货）。只有本机 `trade.trade_order` 多一行 `pending_pay`，属正常测试数据，未支付订单自然过期。同时确认**共享环境**（如 kr-1）的订单数没有增加——如果增加了，说明改派没生效、回调兜底到了共享环境。

### 验隔离

拿一个**不在改派表**的 uin 打同样请求：agent 投递计数应不增加，云梯审计里 `operation` 应是兜底的 `jifei-callback`。这证明不会串到别的开发者环境。

## 排障：先分清是哪一种失败

这几种失败长得像，根因完全不同。**先看云梯审计里有没有 checkCreate 回调记录**：有记录但超时 = 链路问题；没有记录 = 账号或参数问题。

| 现象 | 根因与正解 |
|---|---|
| 约 **10 秒**后失败，审计 `status_code:0` / `duration_ms:10000` / `context deadline exceeded` | **回调回不来**：接线被冲掉 / agent 掉线 / 填了直连 IP。与账号无关 |
| **0.5~2 秒**快速失败，`returnCode=800200 未实名认证`；出向 `jifei-test` 有 200、无 checkCreate | 该 uin 云侧未实名。**只有国内站会遇到**，国际站 uin 免实名。国内站换智研申请的账号 |
| 快速失败，`returnCode=100001 param error[action: is invalid]` | **不是 action 写错、也不是账号问题**，是本地库装的商品规格不是国际站的。见步骤 2 |
| 快速失败，其他账号/权限类错误码 | 才轮得到怀疑「uin 未在 jifei 开通交易」 |
| 200 但返 `600106` | 业务互斥规则，换个全新 `externalUserId` |
| 打 devtunnel ingest 得 401 | 云梯转发不会自带 `Authorization`，靠 route 的 `headers_from_env` 注入 `DEVTUNNEL_TOKEN` |
| 本地 trade 日志看不到 `[jifei-out]` / `[jifei-in]` | log driver 是 journald，大响应体会被限速丢掉。**别用容器日志下结论**，查云梯审计 |
| 回调时好时坏、随机 504 | devtunnel 多副本了。hub 队列在进程内内存，`replicas` 必须为 1 |
| 新增 sops secret 后 Argo sync 报找不到文件 | bundle 的 `publish_paths` 里 secret 是逐个文件名列举的，新增 sops 必须同时补 `publish_paths` 和 `.ci/<service>.yml` 的触发 paths |

## 约束与限制（用之前先知道）

- **槽位上限 3 个**。`jifei-callback-dev-1/2/3` 是烤进镜像的，env 覆盖只能改**已有**槽位的 base_url / host / uin 映射，**造不出第四个**。第 4 个人要用得改 `config.example.yaml` 并重建镜像。
- **devtunnel token 每个集群一个，所有人共用**。鉴权只能证明「你是圈内人」，不能证明「你是谁」：拿到 token 的人只要知道别人的 host header（gitops 清单里是明文）就能截走别人的回调。轮换也是连坐的，要同时通知所有人更新本机 token 文件。
- **live `kubectl patch` 不持久**。pod 重建或别人点 Sync 就会被冲掉，症状是回调突然开始 10s 超时、agent 刷 `poll error: hub returned Not Found`。live patch 只当诊断手段，长期生效必须走 gitops 真源。
- **合入 master 不等于上线，但会写进生产期望态**。auto-pin 会把 tkexgz / tkexsg 共 5 份 platform env（含两地生产）一起 pin 进 gitops。因为 `auto_sync=False` 不会自动 rollout，但一旦有人点了 app 级 Sync，生产就会跟着换镜像。
- **不要假定有支付护栏**。`TRADE_PERSONAL_SANDBOX` 这类护栏从未提交进仓库，新环境默认裸奔，靠自己只打询价和下单端点。

## 不该做什么

- 不改生产与 staging 工作负载，不改它们的 `*-platform.env`。
- 不点 app 级 Argo Sync。
- 不打 `place-and-pay` / `pay-url` 去「跑通付费闭环」，那会产生真实支付动作，必须先获得明确授权。
- 不用本地 mock 产出的 uin 下单——那是铁律 1 禁用的共享 uin，看起来成功，其实污染的是别人的环境。
- 不把 token 写进仓库、提交信息、MR 描述或日志。
