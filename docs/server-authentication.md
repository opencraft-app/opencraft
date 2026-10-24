# 服务器登录与自然人身份

标准 Headless 分发自带官方账号插件 `opencraft.account` 和通用 OIDC 登录。企业身份 是可选企业身份来源；三者使用核心的稳定 human Actor。用户名、邮箱、显示名相同不会自动合并账号。实例登录与 Workbench 内的下游产品等产品账号分别管理。

入口为 `/__opencraft_auth/`，提供登录、退出、绑定本地账号或 OIDC、解绑。已有身份必须从当前账号中主动绑定；如果目标身份已经属于另一 Actor，会拒绝操作，不能借绑定迁移资源。增加绑定和解绑要求最近十分钟内的登录证明；OIDC 绑定同时要求身份平台重新认证。解绑使该 Actor 的旧登录上下文失效，需要用保留的方式重新登录。最后一种登录身份不能解绑。

## 自部署账号插件

### Headless composition contract

Headless owns admission, Actor authority, local/OIDC login and execution/resource
lifetime. Its public startup closure must not import enterprise verification or
infer human identity from an enterprise provider name or employee identifier.
A trusted server-side composition may supply verified identity providers, a
request presentation service, Thread metadata, a human-qualification predicate
and owned storage diagnostics/disposal. This is compiled operator-owned code,
not a browser extension or a module path accepted from private JSON.

The managed site preserves its existing enterprise CLI, verification, allowlist compatibility,
participant presentation and persisted preferences in `products/join/`, outside
the replaceable upstream tree. Managed and standalone packaging select that
entry explicitly; generic builds never search for it in parent directories.
Configured identity errors fail before execution starts. Startup rollback and
normal close retire consumers before identity providers and release every owned
store/lock even when a disposer fails. Implementation and delivery evidence are tracked separately; this boundary
does not imply that private plugin directories or all client dependencies moved.

`opencraft.account` 是随包编译的第一方服务端插件（`@opencraft/plugin-local-account/server`）。每个部署的数据目录独立保存账号和密码摘要，不依赖官方账号中心或联网账号服务；不同部署的同名账号不是同一身份，浏览器登录态也不能跨部署复用。

插件拥有用户名规范、密码策略、scrypt 验证及改密/禁用的凭据版本证明。核心通过窄存储端口保留既有 `human-logins.sqlite` v1 表与 checksum，继续拥有浏览器登录态、自然人绑定和授权；核心不导入插件。已有账号、密码、local subject、绑定及权限无需迁移或重新注册。

配置 `local: true` 由服务器启用随包插件；`false` 禁用本地登录并撤销原本地浏览器登录态，OIDC 登录与 Actor 权限独立。普通服务重启保留有效登录态。插件缺失或停用不能关闭成员准入，未完成的密码验证/创建在插件释放后不会写入或签发登录态。服务端激活的 disposer 只退休自身代次并撤销本地登录，不改变其他身份或权限。

本插件属于受信服务端能力，不通过浏览器扩展安装器下载执行。服务器、受管 Web/Linux 包与现有 `human-account` 操作人命令均使用同一插件；界面入口继续为 `/__opencraft_auth/`。本期使用操作人初始化/恢复账号和已登录用户显式绑定，不开放匿名注册、首访者管理员或邮件找回。

## 本地账号初始化

登录能力通过 `--human-auth-config /absolute/private-auth.json` 显式配置。不配置时保留原有匿名本机工作区行为。`--access-control` 独立决定是否要求实例成员资格；配置了登录并不自动关闭匿名访问。

已有前置中继仍执行其显式配置的身份验证。实例的内建登录不自动替换中继认证来源；本指南的标准 Headless 入口可独立完成本地和 OIDC 登录。

### 同机浏览器诊断入口

受管 Web 和 Headless 可以显式共享 `OPENCRAFT_LOCAL_ACCESS_FILE`，恢复仅供本机
操作人使用的匿名工作区。文件必须由运行用户拥有、权限 `0600`、非符号链接，内容为
独立随机的 32 字节密钥（64 个小写十六进制字符）；保存在 Web 根目录之外，不输出到日志。
Headless 也接受 `--local-access-file /absolute/private-file`。默认不启用。

最外层 Web 根据实际 TCP 对端、目标接口地址、监听端口及 IP/localhost Host 核对同机
来源；同端口 SSH/HTTP 分流将原 HTTP socket 交给同进程的 HTTP Server，保留真实
对端、目标与公开端口，不通过重新连接回环端口或转发头恢复来源。SSH 仍代理到私有
鉴权后端。远端访问本机 IP、伪造 Host/forwarded 头或跨站 Origin 都不能取得本机访问证明。
合法请求绕过外部中继登录，由 Web 在私有回环链路内加入短时 HMAC 证明，绑定原始
方法、路径及浏览器 origin；Headless 同时验证证明和回环来源。静态文件准入探针及
WebSocket 使用同一证明。浏览器不接触密钥或证明。

这只恢复当前实例的匿名工作区，不创建员工身份或 human Actor，不授予成员管理、
Hub 管理或 Session 的资源授权。外部访问保持原中继及实例准入策略。启用或撤回需
同时更新两个受管服务；替换私有文件并重启这两个入口后，旧证明失效，业务数据不变。

服务器数据目录要求同一运行用户持有、权限 `0700`；认证配置及临时密码 JSON 文件要求同一用户持有、普通文件、权限 `0600`，不允许符号链接。不要将它们提交到仓库或放入 Web 根目录。通过私有文件提供密码，避免放进命令参数和历史。

本地配置示例（HTTPS 由部署入口提供；HTTP 仅允许回环地址）：

```json
{
  "origin": "https://workbench.example.com",
  "local": true,
  "oidc": []
}
```

`origin` 必须是浏览器实际访问的固定 origin。反向代理保留该 Host；服务不从客户端的 forwarded headers 推导可信 origin。本地调试可用 `http://127.0.0.1:10000`。

用私有编辑器创建临时密码文件，格式为 `{"password":"REPLACE_WITH_A_PRIVATE_LONG_PASSWORD"}`，实际密码至少十二个字符，最多 1024 UTF-8 字节。然后由本机操作人执行：

```sh
# 源码 checkout：npm run auth:account -- <以下参数>
# 受管 Web 包：node runtime/human-account.mjs <以下参数>
# Linux tar 包：bin/node runtime/human-account.mjs <以下参数>
node runtime/human-account.mjs /srv/opencraft-data create admin /srv/opencraft-private/password.json
node runtime/human-account.mjs /srv/opencraft-data grant admin admin
```

`create` 只创建本地凭据，不授予实例权限。`grant USER admin|member` 显式将权限授予该账号对应的 Actor；首个访客没有初始化管理员的能力。初始化完成后移除临时密码文件。已有自然人希望添加本地登录时，应在登录页选择“设置新的本地账号”，以保留原 Actor；不要另建账号并先独立登录。

启动 Headless：

```sh
bin/opencraft-server --data-dir /srv/opencraft-data --host 0.0.0.0 --port 10000 \
  --human-auth-config /srv/opencraft-private/auth.json --access-control
```

受管部署在既有 Headless 私有配置的 `argv` 中加入相同参数。继续使用固定聚合版本及受管升级流程，不另起一个进程占用原数据目录。

账号维护命令：

```sh
node runtime/human-account.mjs /srv/opencraft-data password admin /srv/opencraft-private/new-password.json
node runtime/human-account.mjs /srv/opencraft-data disable admin
node runtime/human-account.mjs /srv/opencraft-data enable admin
node runtime/human-account.mjs /srv/opencraft-data revoke admin
```

修改密码、禁用及重新启用账号均使该本地账号的旧浏览器登录态失效。其他已绑定方式可以继续证明同一个人。`revoke` 撤销 Actor 的实例成员资格，所有登录方式都失去该实例权限。禁用整个 Actor 则沿用主体管理接口。恢复操作由本机操作人执行，本轮没有邮件找回、公开注册或跨 Actor 合并流程。

## 配置 OIDC

在身份平台注册 Web 客户端，配置精确回调地址：

```text
https://workbench.example.com/__opencraft_auth/oidc/callback/company
```

在上述私有配置中追加：

```json
{
  "origin": "https://workbench.example.com",
  "local": true,
  "oidc": [{
    "id": "company",
    "label": "企业账号",
    "issuer": "https://identity.example.com",
    "clientId": "opencraft-web",
    "clientSecret": "REPLACE_LOCALLY",
    "tokenEndpointAuthMethod": "client_secret_basic"
  }]
}
```

支持 discovery、Authorization Code、PKCE S256、state、nonce、JWKS 签名验证及 issuer/audience/有效期检查。支持 `client_secret_basic`、`client_secret_post` 和 `none`；无 secret 时默认 `none`，有 secret 时默认 `client_secret_post`。修改配置后通过部署流程重启认证 owner 生效。某个身份平台不可用不会阻止本地密码登录。

OIDC 身份键为完整 `[issuer, sub]` 元组的 SHA-256，避免不透明 sub 或 URL 的字符限制，不截断标识，不依赖 provider 显示名称、邮件或配置中的按钮 ID。绑定须先登录原账号，再选择“绑定企业账号”；独立登录一个此前未绑定的身份会注册独立 Actor。

## 登录态、权限与撤销

浏览器使用 host-only、HttpOnly、SameSite=Lax 的不透明 cookie；HTTPS 配置加 Secure。数据库只保存 token 摘要，登录最长八小时，OIDC 登录还受 ID Token 到期约束。每个 Actor 最多保留最近三十二个浏览器登录态。退出撤销当前 OpenCraft 登录态；企业 SSO 平台的会话由该平台管理。

OIDC 事务保存在认证 owner 内存中，十分钟过期、绑定发起浏览器且只能消费一次；取消、退出、原账号变化或服务重启均不能通过迟到回调建立绑定。写接口要求精确同源 JSON，密码验证有全局并发和尝试次数上限，密码使用 scrypt（N=131072、r=8、p=1、独立随机 salt）。实际部署仍需可信 TLS 入口。

`actors.sqlite` 拥有身份和绑定；`human-logins.sqlite` 拥有本地凭据与浏览器会话；`memberships.sqlite` v2 保存 Actor 成员资格。旧身份级授权在可信身份首次使用时导入 Actor，旧授权不覆盖已有 Actor 撤权。兼容 `access-admin` 和成员 HTTP API 可按旧稳定身份更新对应 Actor；新 API 也接受 `{actorId, role, enabled}`。资源权限、Session Actor 凭据及业务资源 owner 保持各自权威。

登录退出、账号禁用、Actor 解绑/禁用和成员撤权在持续连接上重新校验并退役 WebSocket。Session Actor bearer 不能调用登录或绑定接口，也不能借此进入旧的无资源范围执行 API。

服务端身份来源通过受信的 `WorkbenchRequestIdentity` 装配端口提供请求准入、
连接 sender/期限和自有 HTTP 路由；通用网关不解释 企业身份 字段或时钟容差。
核心的成员、Actor 和资源授权仍独立生效。静态网页导航探针使用
`GET /__opencraft_access/admission`：通过当前准入返回 204，否则返回相应拒绝，
未配置准入的匿名部署保持可用。WS 连接在成员证明或身份上下文任一较早期限
到达时关闭，证明缺失/过期或验证异常不建立连接。旧 企业身份 探针别名只由配置的
企业身份 插件兼容；没有该插件的私有 API 返回 404，不返回网页 HTML。

SQLite 升级遵循[生命周期契约](sqlite-lifecycle.md)。成员库追加 v2，保留 v1 checksum 与业务数据；旧程序不识别 v2 时会拒绝打开，不能靠覆盖数据库回退。优先向前修复；确需恢复迁移前备份时，先按受管流程停止写入并核对恢复范围，避免丢失新数据。

## 主体协作入口

自然人和 Session 可通过[主体协作接口](actor-collaboration-api.md)共用持久消息与显式 queue / steer 请求。登录成功或创建 Session 不授予这些动作；需要目标 Actor 的具体 grant，运行绑定由 registry 管理者设置。此接口未放开 Session bearer 对旧共享入口的访问，也不改变各产品账号或既有匿名策略。
