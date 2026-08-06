# 实例身份与建站凭据方案交接文档

- 日期：2026-08-07
- 状态：**已实现（Tasks 1-5 完成，Task 6 SKILL 待落盘）**
- 关联：`docs/handover/2026-08-06-cos-site-gateway-handover.md`（静态建站二期）
- 建站 Skill：`.agents/skills/cloudbase-site-builder/SKILL.md`

## 零、实现摘要（2026-08-07 更新）

**选定方案**：方案 A——平台签发永久 per-instance key，通过 TAT 参数化命令下发到机器 systemd 环境变量。

### 已完成

| 组件 | 文件 | 说明 |
|---|---|---|
| Redis 凭据存储 | `ctl/pkg/websiteauth/store.go` | `vwk_<key_id>_<secret>` 格式，SHA-256(salt‖secret)，无 TTL，无明文 |
| CTL 签发/校验 | `ctl/main/api/website_credential_handler.go` | POST issue / DELETE revoke + `Vela-Instance-Key` 中间件 |
| CreateSite bundle 推导 | `ctl/pkg/logic/website/logic.go` | `bundle_id` 省略时从 active pass 自动推导 |
| Service Gateway 路由 | `argocd/services/service-gateway/*/config.yaml` | `ctl-instance-websites` 公开路由 + 8 条精确 allowlist |
| TAT 下发脚本 | `images/helpers/install-hermes-website-credential.sh` | 写 `/etc/vela/website-credential.env`，注入 systemd drop-in |
| TAT 命令创建 | `.ci/runtime/commands/create_hermes_website_credential_command.sh` | 参数化命令，`{{tat-hidden:website_key}}` |
| TAT 命令调用 | `.ci/runtime/commands/invoke_hermes_website_credential_command.sh` | JSONL 输入，每实例独立 InvokeCommand |
| 行为测试 | `images/tests/test-hermes-website-credential-scripts.sh` | 31 项断言全通过 |

### 鉴权链路（最终）

```
Skill: Authorization: Vela-Instance-Key vwk_xxx_yyy
  → service-gateway ctl-instance-websites route (public, allowlist)
  → ctl websiteInstanceAuthMiddleware (validate against Redis)
  → inject X-User-Id / X-Instance-Id
  → ctl /v1/websites handlers (unchanged)
```

### 待落盘

- `.agents/skills/cloudbase-site-builder/SKILL.md`：改好了但 `.agents/` 在沙箱只读，待用户 `cp docs/handover/SKILL-pending-update.md .agents/skills/cloudbase-site-builder/SKILL.md`
- `images/README.md`：待补充新脚本文档

## 一、要解决什么

用户在对话里说「帮我建个网站」，实例上的 Hermes agent 产出静态文件后，需要调平台建站 API（ctl 的 `/v1/websites`）创建站点、创建 release、查状态。**agent 拿什么向平台证明自己是谁？**

关键约束是渠道无关：用户可能从 Web、Telegram、Discord、微信任一渠道发起，所以方案**不能依赖浏览器在场**。这一条否掉了一大批看起来可行的做法。

用户明确的三条硬约束：

1. 不预置长期凭据
2. token 不落 DB
3. 不做批量补存量实例

现状是这条链路在生产上完全不通。6 台测试机是**手工塞用户 session token** 才跑通的，那是目前唯一 work 的形态，不能带着上线。

## 二、现有鉴权链（事实）

```
Skill: Authorization: Bearer <token>
  → service-gateway.introspect()          server.go:1036
  → GET lightclaw-auth /auth/session      server.go:1042
  → session.user.id
  → 注入 X-User-Id 转发给 ctl              server.go:1155
```

两个决定方案空间的事实：

- **ctl 自己完全不校验凭据**，只信上游注入的 `X-User-Id`（`ctl/main/api/server.go:43`、`newRequestContext` 在 `server.go:1236`）
- **`/auth/session` 是唯一校验入口**，系统里没有 API key / PAT 概念

转发前 `stripIdentityHeaders`（`service-gateway/internal/gateway/server.go:1145-1150`）会删掉客户端自带的 `X-User-Id` / `X-Uin`，所以身份头无法伪造。这一层是可信的。

## 三、被否掉的方案

**本节是这份文档最有价值的部分。** 每条都写清楚否定理由，后来人不必重走。

### 3.1 给实例发一个长效用户 session ❌

最省事——service-gateway 和 auth 一行不用改，Skill 也不用改（它本来就按 `Authorization: Bearer` 写的）。

否掉的理由是**爆炸半径**。一个 `authenticated` session 在 shprod 能打到的接口（`argocd/services/service-gateway/shprod/config.yaml`）：

| 接口 | 后果 |
|---|---|
| `POST /v1/passes/{id}/renew/order-and-pay` | 一体化下单**加支付**，不返支付 URL、不跳中转页，**直接扣钱** |
| `POST /v1/passes/{id}/delete` | 销毁套餐 |
| `DELETE /v1/instances/{id}` | 删实例 |
| `POST /v1/instances/{id}/debug/exec` | 任意命令执行（`config.yaml:63`） |
| `/auth` | 开着 GET/POST/PUT/DELETE（`config.yaml:124-128`） |

而承载这个凭据的进程是 Hermes agent——它整天在处理不可信内容：抓网页、装第三方 skill、读邮件。**prompt injection 面极大**。一个恶意 skill 或被投毒的网页，骗 agent `cat` 一下凭据再发出去，攻击者拿到的是全账号权限，包括花钱和删数据。

建站只需要「创建站点 / 创建 release / 查状态」三个调用，给全权令牌差了两个数量级。

需要澄清一点：**这不是防用户**。机器在用户自己账号下、SSH 开着，而且他用自己的 session 调 `debug/exec` 跑 `cat` 就能读到——任何"用户看不到"的假设都是错的，凭据必须假定用户已持有。用户自己拿到不构成越权。scope 是为了在 **agent 被注入**时把损失限制在「站点被乱改」而不是「钱被花掉」。

### 3.2 腾讯云 metadata 签名身份文档 ❌

最干净的理论解：实例读本机 metadata 拿到云厂商签名的身份文档，ctl 验签得到可信 instance-id。零预置、零下发、零状态。

**腾讯云不提供这个能力。** 依据：

- [查看实例元数据](https://cloud.tencent.com/document/product/213/4934) 的字段表是完整列举的，没有任何 `instance-identity` / `document` / `signature` / `pkcs7` 路径；也没有 AWS 那种 `/latest/dynamic/` 命名空间（腾讯只有 `/latest/meta-data/` 和 `/latest/user-data`）
- 官方文档明确写了安全定位：「虽然只能从实例自身内部访问实例元数据，但数据并未被加密保护。可访问实例的人员均可查看其元数据。」——它被设计成配置数据，不是身份凭据
- 对比：[阿里云 instance identity](https://help.aliyun.com/en/ecs/user-guide/use-instance-identities)、[华为云实例身份文档签名](https://support.huaweicloud.com/usermanual-ecs/ecs_03_2166.html) 都提供 PKCS#7 签名 + 证书 + `audience` 防重放，可离线验签。腾讯云文档无对应章节
- 因此也不存在服务端验签的腾讯云 API

所以 metadata 里的 instance-id / uuid / IP **全部不是秘密**：机器在用户自己账号下，他在控制台就能列出所有 `ins-xxx`，填在请求 body 里谁都能填。

附带发现：Hermes 现有出网策略**主动拉黑了** `metadata.tencentyun.com`（`cloudagent/research/hermes-rs/crates/hermes-core/src/tools/egress_policy.rs:226`，`:275` 还有断言测试兜着），走这条路还得先改策略。

### 3.3 CAM 实例角色 + STS GetCallerIdentity ❌

metadata 里唯一有密码学强度的东西是 `cam/security-credentials/${role-name}`（12h 有效的角色临时凭证）。ctl 拿它调 [STS GetCallerIdentity](https://cloud.tencent.com/document/api/1312/66098) 可以确认调用方身份。

四条否掉的理由：

- **只到账号粒度**。返回 `AccountId=<主账号 Uin>`、`UserId=<roleId>:<roleSessionName>`。「CVM 实例角色场景下 roleSessionName 等于实例 ID」**没有官方依据**（未验证，见第六节）
- **角色在用户可控的影子账号里**。同账号下任意机器绑同一角色就能得到等价凭证，所以它只能证明"属于用户 X"，不能证明"是我们发的那台 Hermes 实例"
- **是凭证转交，不是自证**。agent 要把 12h 有效、权限面远超建站的临时密钥交给平台侧，"不落盘、用完即弃"的清洁性就没了
- 还要为每台实例绑角色（`cvm.qcloud.com` 载体、VPC 网络），并解掉 3.2 那个 egress 封禁

### 3.4 源 IP 交叉核对 ❌

ctl 用请求源 IP 核对实例已知 IP。三处脏：

- **ctl 库里没存 IP**。`instances` 表只有 `instance_id/user_id/sandbox_id/ai_gateway_key_id/gateway_auth_token/status/...`（`ctl/pkg/model/instance/entity.go:34-48`），连实例 gateway 都是按 sandbox_id 拼域名（`ctl/pkg/instance/chatclaw_state.go:1336-1338`）。IP 在 sandbox 服务的 `address` 字段（`sandbox/migrations/000001_init_schema.up.sql:25`），而且按 pool 配置**可能是内网 IP**（`sandbox/internal/provider/tencent.go:908-945` 按 `AddressType == "public"` 决定）
- **走 `lightvela.com` 拿不到真实源 IP**。它 CNAME 到 EdgeOne，回源 IP 不在 gateway 的 `trusted_proxy_cidrs`（shprod 只有 `100.64.0.0/10`，`config.yaml:12-13`），按 `canonicalClientIP`（`service-gateway/internal/gateway/client_ip.go:28-51`）从右往左剥可信跳的逻辑，网关会停在 EdgeOne 节点 IP 上。走 `api.lightvela.com`（直连 CLB）才能看到实例真实公网 IP
- **同机无法区分调用者**。用户对自己的 CVM 有 root，他手写的 curl 和 agent 从同一个公网 IP 出网，源 IP 核对只能证明"来自这台机器"，防不了机器内的越权调用

### 3.5 走 ctl→实例的已有入站通道（方案 B）❌

思路很有吸引力：ctl 本来就会连进实例（`wss://18789-<sandboxID>.sandbox.lightclaw.tech`），**是 ctl 主动拨的号、sandboxID 从自己库里查的、本来就绑着 user_id，所以对面是谁 ctl 一开始就知道**。agent 在这条已鉴权的连接上发请求、ctl 代它建站，就一个 token 都不用发。

三层同时挡着：

- **协议不支持实例主动发起**（最根本）。帧类型只有 `req`/`res`/`event` 三种（`ctl/pkg/adapter/openclawgateway/adapter.go:29-51`），读循环 `readMethodResult`（`adapter.go:227-253`）是 `if res.Type != "res" || res.ID != requestID { continue }`——任何服务端主动推的 `event` 帧被静默丢弃。适配器接口 `Call(ctx, url, token, method, params, out) error`（`adapter.go:17`）本身就是纯 request-response 语义，没有事件出口
- **连接不常驻**。`websocket.DialConfig` 在每次 `Call` 内部拨号（`adapter.go:111`），`defer ws.Close()`（`adapter.go:115`），10s deadline（`adapter.go:72`）。全仓库只有 5 处调用，全是 cron CRUD（`ctl/pkg/instance/automation.go:274/373/449/464/476`），连接只存在几百毫秒
- **实例侧 gateway 源码不在 mono2**。是 npm 装的 `openclaw`（`images/build.sh:1849`）和 COS 拉的 `hermes`（`images/build.sh:2187`），要支持主动 push 得改上游仓库

要支持的话需要：ctl 侧新建常驻连接管理层（连接池 + 心跳 + 重连 + 每实例长连接生命周期）、把 `Call` 改成带事件分发的双向 session、新增 event 路由与 handler，再加上外部仓库的协议扩展。这不是补丁级改动。

**而且这条通道的地基本来就没打**——见 5.1。

### 3.6 基于用户登录态加盐 ❌

登录态在浏览器里，实例不在那条链路上。只用 Telegram 的用户在 agent 建站的那一刻可能根本没有活跃会话，甚至从没打开过网页。任何以登录态为根的方案都会把浏览器耦合重新引进来——加盐只改变凭据形态，没改变来源。

### 3.7 复用实例上已有的 LLM key 作为身份（曾一度否掉，后又捡回）

第一次否的理由是"跨系统耦合、轮换 LLM key 会打挂建站"。**这个理由不成立**：key 轮换时本来就要重新下发、它保持有效是前提；所谓耦合其实就是"用平台已有的实例身份"。

这条后来成了存活方案 C，见 4.2。

## 四、两个存活方案

### 4.1 方案 A：TAT 挑战应答

```
1. agent 调无鉴权接口：「我声称是 ins-xxx，给我个 token」
2. ctl 不信 → 用 TAT 往 ins-xxx 这台机器写一个随机 nonce
3. agent 本机读到 nonce，回传
4. ctl 核对 → 签发 10 分钟、只能建站的 token
```

**信任根**：TAT 的投递目标由 ctl 指定、用的是我们（影子账号）的云凭证，调用方无法影响 nonce 送到哪台机器。nonce 能回来就证明调用方控制着 ins-xxx。不是自己发明密码学，是借云平台控制面当信任根。

对三条硬约束：不落 DB（token 是 HMAC 自签自验的无状态凭据，唯一需要暂存的是几十秒 TTL 的 nonce，那是一次性挑战不是凭据）；不补存量（TAT 对任何运行中的实例都可用，存量和新实例同一条码路，无迁移、无回填、无对账）；不预置（无）。

附带好处：agent 发请求时实例必然在运行，TAT 可用性天然满足。

代价：一次 TAT 往返（几秒，未实测）；需要一个 nonce 暂存（Redis 或进程内存）。

### 4.2 方案 C：复用已有的 ai-gateway key

agent 用手上已有的 LLM key 调一个 broker 接口换 token。

**强不变量**：任何 agent 能正常工作的实例，这个 key 必然存在且有效——否则它连话都说不了。所以零下发、零补存量。

- key 表 `api_keys`（`ai-gateway/migrations/000001_init_schema.up.sql:78-93`）：`user_id` / `key_hash`(UNIQUE) / `key_prefix` / `name` / `is_active`
- 现成入口 **`GET /v1/me`**（`ai-gateway/internal/router/router.go:155`），用 key 自身鉴权（`middleware.Auth`，`router.go:148`），返回业务 user_id（`ai-gateway/internal/model/user.go:20`）
- 内部方法 `ApiKeyService.Validate`（`ai-gateway/internal/service/apikey_service.go:86-95`）

**只能到 user 粒度**：两个后端的 key 表都没有 instance 维度，ctl 建 key 时 name 还硬编码成 `"default"`（`ctl/pkg/instance/async.go:1839`、`:1850`）。ctl 侧存了 `instance.ai_gateway_key_id`（`entity.go:17/40`）理论上可反查，但 DAO 层没有按该列查询的方法（`ctl/pkg/model/instance/dao.go`）。

**两个后端能力不对等**：ctl 按用户订阅路由到 ai-gateway 或 llmgateway/velagw（`ctl/pkg/instance/async.go:1720-1784`）。velagw 只有内部方法 `GetAPIKeyBindingByExternalKey`（`velagw/internal/gateway/mysql_store.go:3489-3506`），**没有暴露成 HTTP introspect 接口**，走这个后端就得新建。

代价：把 LLM 凭据当身份用，爆炸半径没变窄（但也没变糟，它今天已经在盘上了）。

### 4.3 选型未决

两条都满足三条硬约束。差一个决定性问题：

> **建站需要精确到实例，还是到用户就够了？**

站点归属、配额（站点数/流量/存储）、计量都是 user 级的，倾向**不需要** instance 粒度。若如此，C 的"缺陷"不构成缺陷，且它不新增任何机制，工作量最小。必须到实例则走 A。

**选型前必须先确认目标环境实际走哪个 gateway 后端**——这决定 C 是"零新增"还是"要建一个 introspect 入口"。

## 五、调研中发现的独立问题

以下**与建站方案无关**，但都是真实存在的问题，各自独立成待办。

### 5.1 `gateway_auth_token` 从来没有下发代码（P0）

不是"下发失败"，是**根本没有下发路径**。

- `configureOnboard`（`ctl/pkg/instance/async.go:2051-2114`）里 `gatewayAuthToken` 的**唯一**用途是 `:2055-2057` 的非空校验
- 函数体三条命令：`:2076` 装 CLI、`:2088-2094` 设 model（`renderHermesModelSetCommand` 在 `:2254`，参数只有 `modelID/providerID/baseURL/apiKey/compat`，**没有 gatewayAuthToken**）、`:2108` 打日志返回
- `:2015` 传参之后，token 唯一去向是 `:2023` `persistGatewayAuthToken`——**只写 ctl 自己的 DB 列**（`ctl/pkg/model/instance/entity.go:41`）

此前有结论说"`:2051` 会写入实例"，那是把**传参**当成了**写入**——`:2051` 是函数签名行。

两条佐证 18789 不监听：

- 镜像构建时装完 gateway 立刻停掉：`images/build.sh:1298-1299`，`hermes gateway install` 后紧跟 `hermes gateway stop`
- ctl 重启的单元名 `openclaw-gateway.service`（`ctl/pkg/instance/chatclaw_state.go:732-738`）与 hermes 镜像装的单元名**不一致**；`configureGatewayRuntimeAndRestart`（`async.go:2119`）在非测试代码里**没有任何调用方**

另有一处语义问题：实例侧 gateway 配置被投影成 **trusted-proxy 模式**而非 token 模式（`chatclaw_state.go:698-701`），`:699` 明确保留实例上已有的 token、否则置空——再次确认 ctl 从不推自己生成的 token。这段投影只在 `reconcileChatClawDerivedState`（`chatclaw_state.go:945`）里跑，不在 create 主链路。

**结论：ctl→实例的入站通道从未通过。**

### 5.2 `config/reset` 撤旧 key 后不下发新 key（P0）

`ctl/pkg/instance/reset_config.go:13-57`：`:28` 建新 key → `:33-39` **立即** revoke 旧 key（无 grace period）→ `:41` 更新指针 → `:46-56` 把新 key 明文返回给调用方。

**函数体内没有任何 sandbox exec / configureOnboard 调用，新 key 不会被下发到实例。** ai-gateway 侧 revoke 是即时的（`apikey_service.go:155-167` 置 `is_active=false` 并清 Redis 缓存）。

所以任何一次 reset 之后，实例上的 key 立即变废、agent 不能干活，除非前端补做下发（前端确实是拿到 config 后调 `debug/exec` 写入的，见 `frontend/src/repositories/types.ts:353-359` 的注释）。命令行路径本身也值得注意：harness 回退支把 key 直接放在命令行参数里（`async.go:2328`）。

### 5.3 `/v1/websites` 生产未配路由（P0，建站上线阻断项）

这条 gateway route **只存在于 `argocd/services/service-gateway/beijing-sandbox/config.yaml:140`**，shprod 和 sgprod 都没有。生产上请求到 gateway 直接 404，与 token 怎么解决无关。

补的时候注意要**两条 route**：前端走 `authenticated`，实例走 ctl 自校验（`access: public` + `path_policy: allowlist`）。把权限边界写在路由表里而不是 handler 的 if 里，review 时一眼能看出实例能碰哪些接口。

### 5.4 agent 出站域名是隐式约束

agent 必须走 `api.lightvela.com`（直连 CLB，L7 Ingress 见 `argocd/services/service-gateway/shprod/api-lightvela-com-ingress.yaml:17-40`），不能走 `lightvela.com`（过 EdgeOne，真实源 IP 被吃掉，理由见 3.4）。

这条约束**目前代码里没有强制**。`~/.vela/api-base` 填什么应该由 ctl 按环境定死，不要让前端或 Skill 拼——`.agents/skills/cloudbase-site-builder/SKILL.md:68` 已经警告过"拿测试 token 打生产只会 401"，但那只是文档约定。

### 5.5 Hermes egress 拉黑 metadata

`cloudagent/research/hermes-rs/crates/hermes-core/src/tools/egress_policy.rs:226` 及 `:275` 的断言测试。仅在选 3.2/3.3 类方案时才需要处理，当前两个存活方案都不涉及。

## 六、不确定项（需实测才能拍板）

| # | 事项 | 影响 |
|---|---|---|
| 1 | TAT 往返实际耗时（2s 还是 20s） | 决定方案 A 的体验是否可接受 |
| 2 | CVM 实例角色 `roleSessionName` 是否等于 `ins-xxx` | 3.3 已因其他理由否掉，仅存档 |
| 3 | 腾讯云普通公网 IP 关机/重启/重装后是否不变 | 3.4 已否掉，仅存档；`sandbox/internal/provider/tencent.go:374/379` 用的是 `PublicIpAssigned`，未见 EIP 绑定 |
| 4 | acli / harness 把 LLM key 落盘到哪个文件、权限如何 | 影响方案 C 的凭据可读性评估；acli/hermes 源码不在 mono2 |
| 5 | trusted-proxy 模式下 gateway 是否忽略 `params.Auth.Token` | 决定 ctl 现有 cron 调用在 gateway 起着时是否其实能通 |
| 6 | ctl 侧有无按需（非 provision 时）对任意存量实例执行命令的内部入口 | 方案 A 的落点；前端那条 `debug/exec` 是带用户 session 的，未确认是否同一套 |

## 七、建议的推进顺序

1. **先补 5.3 的生产路由**——独立阻断项，不依赖 token 选型，可以立刻做
2. **确认目标环境走哪个 gateway 后端** + 拍板是否需要实例粒度 → 定 A 还是 C
3. 实现选定方案（签发 + 校验 + 建站 route）
4. 5.1 和 5.2 各自独立开单，不要和建站混在一起做

---

**写作说明**：本文档所有代码事实附 file:line，均为 2026-08-07 当日读代码所得，未做实机验证的一律标注在第六节。文档中不含任何 token、密钥、密码的实际值。
