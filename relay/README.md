# Join 内部发行版 Relay

构建独立的 Join Relay 包：

```sh
npm run join:build:relay -- /absolute/output
node /absolute/output/relay.mjs /absolute/private-config.json
```

包内包括 Join Relay 入口、Grasp 重写 worker、分享图片和运维 CLI。
可直接使用 mono2 旧版私有 IOA 配置。若使用核心 `authentication` 对象，
通过 `JOIN_TENCENTOA_TOKEN_FILE` 提供绝对路径。使用 `OPENCRAFT_GRASP_UPSTREAM`
显式配置 Grasp 上游。启用多副本时按[核心 Relay 契约](../docs/relay-deployment.md#redis-backed-replicas)
设置 `clusterFile`、Hub 初始状态与每副本环境变量。

产品入口和代理在本目录。身份继续复用 `products/join/plugins/tencentoa`，
共享登录状态、Redis 租约、跨副本转发和滚动排空由 `apps/relay-server` 维护。
纯中继可以接入并转发其他节点的路由，无需发布本地业务服务。

## 内部 IP 自助加入

`JOIN_RELAY_INTERNAL_ENROLLMENT=1` 在现有 TLS 机器入口启用
`POST /__opencraft_hub/join`。来源 IPv4 为 `9.*`、`10.*`、`11.*` 的机器
可自行登记，不需要管理员事先分发邀请或密钥。接入日志只包含来源 IP、结果和
固定事件名，不记录个人身份、请求内容或凭据。其他来源继续使用原有邀请方式。

入口直接读取 TCP 来源，不信任 `X-Forwarded-For`、`Forwarded` 或 `X-Real-IP`。
TKE LoadBalancer Service 须保留真实来源 IP（`externalTrafficPolicy: Local`），
发布时从负载均衡入口验证实际记录的地址；不能把节点转发地址当作客户端地址。
配置依据见 [TKE 源 IP 指引](https://cloud.tencent.com/document/product/457/48949)。
此接口仅接受直达 TLS 入口的机器请求，拒绝浏览器 Origin 与明文 HTTP。
现网机器入口为 `https://join.woa.com:18490`；443 的办公网浏览器入口继续由企业
网关持有。自助加入不替代业务站点的登录、成员权限或显式身份信任。

更新后的 `hub-admin.mjs` 可按地址加入。停止该机器的 Hub owner 后，将如下
JSON 保存为 owner-only 的命令文件，再执行
`node hub-admin.mjs /absolute/hub-network.json /absolute/connect.json`：

```json
{
  "action": "connect",
  "relay": "https://join.woa.com:18490",
  "publishOrigin": "https://my-server.join.woa.com",
  "trustIdentity": true,
  "caFile": "/absolute/trusted-public-relay-ca.pem"
}
```

`caFile` 为已受信任的公共 CA；没有关闭证书或主机名校验。无本地业务服务时省略
`publishOrigin`。运行中的 owner 也支持管理员向原 Hub settings API 提交
`{ "action": "connect", "relay": "https://join.woa.com:18490", "trustIdentity": true }`。
已有邀请和已登记节点的连接方式保持兼容；旧客户端不会自动获得新接入命令。

系统仍校验机器自身的 Ed25519 身份，防止冒名。请求绑定 Relay 地址和短时 nonce，
Redis 在副本间原子防重放；登记及路由归原 Hub owner 持久化。丢失登记响应后可
重新请求，得到同一机器的稳定接入凭据，不会重复创建节点。已有 Origin 不可被
另一节点抢占；新自动登记默认不授予多跳发布权限。当前 Hub 的 128 个接入记录
预算继续生效，达到上限时明确拒绝新登记。

```sh
npm run test:relay
npm run test:hub-network
npm run join:test:relay
node relay/verify-sources.mjs
```

`recovery/mono2/` 保存首次原样提取的产品文件。其摘要由 `sources.json`
固定。内部仓库的维护入口使用本目录的适配版本。此次核心与产品来源见
[来源记录](PROVENANCE.md#mono2-integration)。

企业微信回调由 Join 装配。启用时，在 Relay 的私有 JSON 中添加
`wecomCallback: { hubId, origin }`，并配置 `hubNetwork`。两个值分别是
已登记的收件 Hub ID 和该 Hub 公告的服务 Origin，示例中的占位值须替换为部署配置：

```json
{
  "wecomCallback": {
    "hubId": "hub-0000000000000000000000000000000000000000",
    "origin": "https://receiver.example.com"
  }
}
```

Relay 仅接管 `POST /wecom_callback`，沿指定 Hub 隧道转交
`/__opencraft_im/shadow-callback/wecom`。查询串和 XML 原样转发，收件端
负责签名和收件人校验。目标撤下或暂时不可达时返回 503，回调进入 Relay 的
限时排空流程。回调日志仅记时间、固定路径和状态。启用配置前核对现网 Hub
公告的 ID 和 Origin。公开入口的接入策略由入口网关持有。

企业微信的命令、成员登记和存储转发由[企微转发子模块](../products/join/plugins/wecom/mirror/README.md)持有。
是否启用暂存由私有运行配置决定，不能从源码存在推断现场状态。


现网补充入口通过显式环境配置装配。`JOIN_TEST_ENVIRONMENT_UPSTREAM` 指向
现有测试环境 broker，继续校验入口会话、同源写入与最小 Cookie。
`JOIN_MOBILE_PREVIEW_UPSTREAM` 指向原 Metro 预览 owner。
回调目标也可通过 `JOIN_WECOM_CALLBACK_HUB_ID` 和
`JOIN_WECOM_CALLBACK_ORIGIN` 提供，与 JSON 中的 `wecomCallback` 二选一。

沿用 Hub 回调接收端时，可将 `JOIN_WECOM_NOTICE_FILE` 指向 owner-only 的绝对路径
JSON 文件，内容是已有企微 `corpId`、`serviceId`、`corpSecret`、`token`、`aesKey`。
Relay 校验签名及收件人后，直接回复单聊“暂不支持单聊，请将我加入企业微信群后，在群聊中使用。”。
群回调的原始密文与查询串仍交给原 Hub 接收端；该配置不启用 Redis 暂存，不更改群绑定。
与 `JOIN_WECOM_MIRROR_FILE` 二选一；暂存模式本身已包含单聊提示。
有共享 Redis 时，同一子模块还会处理群内 @ 命令及服务器关系记录。可信企微发送人
自动对应已有 OA 登录账号，复用 Relay 服务器选择器及目标服务器的实时权限检查；
无需关联码或服务器另行登记。尚无已验证员工账号记录时，提示通过统一入口使用
服务器后自动识别。该路径不会自动开启 200 条暂存。
