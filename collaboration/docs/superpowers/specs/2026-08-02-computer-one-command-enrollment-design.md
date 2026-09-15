# Computer 一键接入与 COS 产物发布设计

> 权限与 macOS 生命周期部分已被
> `2026-08-02-computer-user-launchagent-design.md` 取代。当前实现是无 root 的用户级
> LaunchAgent；本文中 system LaunchDaemon、`sudo` 与 `/Library` 相关描述只保留为历史
> 设计记录，不再作为实现依据。

日期：2026-08-02

## 1. 目标与边界

把 Computer 首次接入改造成普通用户可理解的一键安装流程：用户只输入名称，复制一条
安装命令，等待 Computer 变为在线。V1 固定 macOS ARM64；Computer 产品 DTO、产品界面
和产品文案不出现 Region、腾讯云、TAT、managed/CVM/Lighthouse、PTY 或底层注册码。

内部仍使用腾讯云 TAT 完成外部机器纳管、命令执行和终端连接。去云厂商化只发生在产品
边界，不删除数据库和 adapter 所需的地域、实例 ID、provider state。

V1 不配置 CDN、自定义域名或公开桶 ACL；不实现自升级、回滚 UI、批量安装或企业软件
分发；Go API 不代理二进制或终端字节流。

## 2. 已批准基础设施与产物

- COS 桶：`an-computer-1388575217`
- 地域：`ap-beijing`
- ACL：私有，无匿名读写
- Go API 只校验下载授权并重定向到短期签名 URL，不传输文件内容。
- 首次只发布真实完成构建、安装和测试的平台；当前基线 target 是 `darwin-arm64`。
- Linux/Windows 目录可预留，但在完成各自安装权限和服务管理设计前不得出现在产品选项。

每个版本全部不可变，包括第一段安装器：

```text
computer/releases/<version>/
├── manifest.json
├── manifest.sig
└── darwin-arm64/
    ├── install.sh
    └── chatserver-computer
```

V1 不引入 `latest`。Human 安装命令固定具体版本；同一 object key 禁止覆盖。manifest
记录每个文件的 target、object key、字节数与 SHA-256，并用离线 Ed25519 key 签名；公钥
固定在版本化安装器中，安装器自身的 SHA-256 固定在 Human API 返回的命令里。

后台部署内置只追加、不可修改的 release catalog，条目按 `releaseVersion + target` 唯一，
记录 manifest object/hash、signature object/hash、installer object/hash 和 signing key ID。
同一版本条目若内容不同，进程拒绝就绪；切换当前版本只能选择已经完整校验的 catalog
条目，不能原地修改条目。生成命令时把这组值全部复制到 Computer 当前 enrollment
generation；后续下载和 claim 只读取数据库中的固化值，不再读取“当前 release”。因此即使
滚动发布期间不同 Pod 的当前版本短暂不同，已签发命令仍只能使用签发时绑定的完整对象集。

## 3. 产品流程

1. Owner/Admin 点击“添加 Computer”。
2. UI 从后台当前批准 release 读取可安装平台，并展示当前支持环境的说明。
3. Human 只提交 `name`；后台固定当前批准平台并选择 provider routing 与 Region。
4. Computer 以“等待连接”创建。
5. Human 请求“生成安装命令”；后台以 Computer revision 做 CAS，签发短期单次
   enrollment token，并使上一份尚未 claim 的 generation 失效。Computer 一旦 claim，
   V1 不允许重新生成命令或换机器复用该 Computer。
6. 页面展示“在这台电脑的终端中运行以下命令”、复制按钮和过期时间。
7. 命令把版本化安装器下载到权限受限临时文件，核对固定 SHA-256 后再执行；禁止
   `curl | sh` 或等价 PowerShell 管道执行。
8. 安装器下载并验证签名 manifest、程序大小与 SHA-256，然后原子安装。
9. Computer 在本机生成长期 credential secret，只把 digest 提交给后台；后台不生成或
   返回长期 secret。
10. Computer 内部取得 provider bootstrap 并启动；后台对账后产品状态收敛为“在线”。

产品文案映射：

| 内部事实 | 产品表达 |
|---|---|
| provisioning / unknown | 等待连接 |
| provider online | 在线 |
| provider offline | 离线 |
| provider error | 连接失败 |
| registration script | 安装命令 |
| PTY | 终端 |
| managed/cvm/lighthouse | 不展示 |
| Region | 不展示 |

URL 可以展示；页面不解释 URL 背后的云厂商实现。

## 4. 契约隔离

采用两份独立权威契约：

- `platform/v1/openapi.yaml`：Human 产品 API，只生成 Web/Expo/TUI Human 客户端；
- `platform/v1/computer-bootstrap.openapi.yaml`：Computer bootstrap 和 provider 内部 API，
  只生成 Go Computer 客户端。

CI 对 Human `Computer` 资源执行产品字段 allowlist。该资源不得包含旧的
`ComputerRegistration`、`tatRegion`、`tatInstanceKind` 或 `tatAgentState`；Computer 内部
契约可以保留兼容所需的 provider 字段，但不得进入 Computer 页面状态或文案。

终端属于明确的技术例外：浏览器需要直连 provider，所以 Human 技术契约可携带短期连接
参数，但 UI 只能呈现“打开终端”，不得显示或要求用户理解这些字段。Operation 在普通产品
界面同样先映射为动作名和稳定错误；原始 service/kind 只用于管理员诊断。

## 5. Human 产品 API

### 5.1 可安装平台

```http
GET /v1/computer-installation-options
```

```json
{
  "releaseVersion": "0.1.0",
  "platforms": [{"osType": "macos", "architectures": ["arm64"]}]
}
```

该响应由后台当前固定的已签名 release manifest 派生。创建、生成命令和 Computer claim
都校验同一 target allowlist，不能只依赖 UI。

### 5.2 创建 Computer

```http
POST /v1/servers/{serverId}/computers
```

```json
{"name": "研发机"}
```

公开 `Computer` DTO：

```json
{
  "id": "...",
  "serverId": "...",
  "name": "研发机",
  "osType": "macos",
  "connectionState": "waiting",
  "connectionIssue": null,
  "lastSeenAt": null,
  "revision": 1
}
```

`connectionIssue` 只允许后台可观测的稳定产品码：`setup_expired`、`unsupported_platform`、
`connection_failed`；结构为 `{code,message,occurredAt}`。claim 前的 sudo、下载、签名或
本机权限失败只在执行终端输出稳定本地错误，不伪造为后台状态。内部 provider 错误码不
透传，请求 ID 另行保留用于排障。

### 5.3 生成安装命令

```http
POST /v1/servers/{serverId}/computers/{computerId}/setup-commands
If-Match: <computer revision>
```

该请求不自动重试、不进入可重放 IdempotencyRecord。Repository 在一个事务内验证
Owner/Admin、Computer 从未 claim、target 可用、revision 匹配，随后递增 generation、写入
token hash/过期时间和完整 release 绑定并递增 revision。并发请求只能有一个成功，其余返回
`revision_conflict`。响应带 `Cache-Control: no-store`、`Pragma: no-cache`：

```json
{
  "computerId": "...",
  "command": "...",
  "expiresAt": "...",
  "revision": 2
}
```

产品提示“仅最后一次生成的安装命令有效”。命令不得进入 Zustand 持久层、URL、Service
Worker/cache、分析事件、错误遥测或剪贴板遥测；关闭面板即从内存清除。

固定命令模板使用 shell builtin 在 `umask 077` 的 `mktemp -d` 中写 token 和 curl config。
所有 curl 调用都把 `-q`/`--disable` 放在第一个参数，显式忽略用户和系统 `.curlrc`；只使用
`--location`，禁止 `--location-trusted`，重定向仅允许同一中性入口签发的一次 HTTPS 跳转。
curl 通过绝对路径 `/usr/bin/curl` 在 `env -i` 的最小环境中运行，只按明确配置继承
`HTTPS_PROXY`/`NO_PROXY`，不继承 trace、home、netrc、CA override 或 TLS key-log 环境。
后续 `/usr/bin/curl -q --config <file>` 的进程参数、环境变量和入口 URL 均不含 token。
安装器只接收 token 文件路径，并通过预先打开的文件描述符把 token 交给 Computer；所有
退出路径用 trap 清理。
token 仍会存在于 Human shell history 的原始命令文本，这是“一条可复制命令”的剩余风险，
由短有效期、单 generation 和完成后立即失效控制；产品明确提示不要转发命令。

## 6. Enrollment token 与分片

token 固定格式：

```text
cen1.<server_uuidv7>.<computer_uuidv7>.<generation_decimal>.<base64url_32_bytes>
```

服务端严格限制总长度和各段长度，拒绝非 canonical UUIDv7、前导零 generation、0、
溢出、非 strict base64url 或非 32 字节 secret。先解析 `server_id` 路由 TDSQL 分片，再用
`server_id + computer_id + generation` 精确读取 Computer，最后常量时间比较完整 token 的
SHA-256。禁止按 token hash 跨分片扫描；无效路由按账号/IP 限流且统一返回认证失败。

在 `computers` 增加：

```text
enrollment_generation          BIGINT NOT NULL DEFAULT 0
enrollment_token_hash          BINARY(32) NULL
enrollment_expires_at          TIMESTAMP NULL
enrollment_claimed_at          TIMESTAMP NULL
enrollment_credential_version  BIGINT NULL
enrollment_release_version     VARCHAR(64) NULL
enrollment_target              VARCHAR(64) NULL
enrollment_architecture        VARCHAR(64) NULL
enrollment_manifest_object     VARCHAR(512) NULL
enrollment_manifest_sha256     BINARY(32) NULL
enrollment_signature_object    VARCHAR(512) NULL
enrollment_signature_sha256    BINARY(32) NULL
enrollment_installer_object    VARCHAR(512) NULL
enrollment_installer_sha256    BINARY(32) NULL
enrollment_signing_key_id      VARCHAR(64) NULL
enrollment_program_object      VARCHAR(512) NULL
enrollment_program_sha256      BINARY(32) NULL
enrollment_program_size        BIGINT NULL
```

SQLite 使用等价 BLOB/TIMESTAMP 表达；迁移和审计同时覆盖 SQLite 与 TDSQL。所有更新仍以
`server_id + computer_id + generation + revision` 做单分片 CAS，不新增业务表。

TDSQL 已发布的 `20260801000000` baseline 保持逐字节不变；enrollment 字段由
`20260802100000_computer_enrollment.sql` 增量引入。baseline 和后续 migration 都使用
owner claim、revision identity 和逐语句 CAS 记录，不使用可 upsert 的通用 revision store。

## 7. 私有 COS 下载闭环

安装命令只出现中性平台 URL，不直接出现 COS URL：

```http
GET /v1/computer-artifacts/{version}/{target}/{file}
Authorization: Enrollment <token>
```

`manifest.json`、`manifest.sig`、`install.sh` 和 V1 唯一 program 都是 generation 所固化
release 元数据中的固定对象，由后台精确匹配 object key/hash/size；manifest 不列出自身或
签名，只列 program descriptor，且必须与 generation 固化值完全相等。后台验证 token、
绑定的 version/target 和这四个固定对象后生成不超过 token 剩余有效期、最长 5 分钟的
COS GET URL，并返回
`307 Location`；Go 不读取或转发对象字节。

入口和重定向响应均 `no-store`。COS 签名 query 必然短暂出现在后端内存中的 `Location` 和
curl 的出站 URL；这两个位置是唯一例外。访问日志不得记录 Authorization、Location query
或出站 query；Human URL、应用状态、本地持久状态和遥测不得包含它们。安装器只允许
HTTPS、最多一次重定向，并拒绝从非配置入口直接选择任意 object key。COS 保持私有，无
Bucket listing 和匿名 GetObject。

命令先下载 `releases/<version>/<target>/install.sh` 到 `mktemp` 文件，再用 API 响应中固定
的 SHA-256 校验，成功后才执行。安装器再经同一中性入口下载 manifest/signature/program，
验证 Ed25519、target、大小和 hash。因而首段远程代码也在完整性链内。

## 8. Computer claim 与响应丢失

安装器在本地用 CSPRNG 生成 32 字节长期 secret，构造候选 Computer credential，并先将
secret 写入 `credential.pending`：目录 `0700`、文件 `0600`、临时写入、fsync、原子改名。
随后提交：

```http
POST /v1/computer/enrollments:claim
Authorization: Enrollment <token>
```

```json
{
  "osType": "macos",
  "architecture": "arm64",
  "credentialDigest": "<sha256>",
  "installerVersion": "0.1.0"
}
```

后台验证实际 target 与 token/release 一致，在同一事务中分配单调 credential version，把
digest 写入现有 `computer_runtime_credentials`，并在 Computer 记录 generation 对应的
version。响应只返回非 Secret route/version，Computer 在本地把它和已有 secret 组合成
正式 `crc_...` credential；后台从不接触或返回 secret 明文。

同一 token + 同一 digest 的重试必须返回同一 version；同一 token + 不同 digest 返回
`enrollment_claim_conflict`。因此事务提交后响应截断、客户端超时或进程崩溃都可安全重试，
同一 generation 最多存在一个有效 credential。新 setup generation 只允许在 Computer
尚未 claim 时显式生成，并使上一份未 claim token 失效；一旦 claim，接口固定返回
`computer_already_claimed`。V1 不支持把同一 Computer 迁移到另一台机器；机器丢失时停用
原 Computer 并新建 Computer，由新资源取得新的 credential 和 provider identity。

原 token 普通过期后，只有“同 generation、已 claim、同 digest、只读取相同 route/version”
的 claim 重试可以继续；这项只读恢复不设固定时间上限，直到 Computer 首次 online 或被
Owner/Admin 显式停用。它不能下载 artifact、取得 provider bootstrap、提交不同 digest 或
改变任何状态。这样即使 claim 提交后回包长期丢失，本机仍能用持有的 secret 恢复正式
credential；未 claim 时生成新 generation、Computer online 或停用会立即终止该能力。

claim 后，Computer 使用正式 credential 幂等请求 provider bootstrap。HTTP 路径只在现有
`tencent_operations` 中创建/读取唯一操作，partition key 为 `serverId`，idempotency key 为
`computer-provider-enroll:<computerId>:<generation>:<credentialVersion>`；所有重复请求返回
同一 Operation，不直接调用 provider。Worker 以现有 lease CAS 保证 single-flight，并把
真实外部注册次数持久化在 Operation `attempts` 中。

provider 注册是明确的 at-least-once 外部副作用。Worker 每次取得 lease 后先按
`computerId + generation + credentialVersion` 标签对账已有候选：已有 winner 时不消耗新
attempt；没有候选且 `attempts < 3` 时，先在单分片事务中 CAS 预留并递增 attempt，再取得
一个只供该 attempt 使用的注册码并调用 provider。外部调用成功、失败或超时后，下一任
Worker 都先对账再决定是否预留下一个 attempt，因此崩溃不能并发突破三次。若本地已有原子
落盘的 provider identity/config，重启只绑定并复用该 identity，不再注册。

若远端注册成功但本地 identity 尚未落盘即崩溃，Worker 按上述标签列出候选，只接受创建
时间最早、已 online 且 OS 匹配的实例作为确定性 winner；adapter 自动注销其余候选并完成
后才允许产品状态变为在线。清理未完成期间保持 `connection_failed`，不随机选择、不让多个
候选同时工作。三个已预留 attempt 后仍无法唯一收敛则停止自动重试，要求停用原 Computer
并创建新资源。

Computer online 后 enrollment token 立即失效，本地删除 enrollment pending 文件。测试
必须覆盖“provider 注册成功后、写 enrollment 阶段前崩溃”，证明本地 provider identity
使重启路径不会创建第二个实例。

## 9. 安装状态机与权限

本地 `enrollment.state.json` 只保存阶段、version、target 和非 Secret 引用；token 放在独立
`0600` pending 文件，完成后删除。阶段为：

```text
downloaded → verified → binary_installed → credential_staged
→ credential_claimed → provider_registered → service_starting
→ service_started → complete
```

每一步先验证前一阶段的文件/hash/权限，再幂等执行；重跑不能重新生成长期 secret，也不能
覆盖一个不同 Computer 的合法状态。失败只清理当前临时文件，不删除已验证的旧安装。

同机全流程只有一个 writer。`install.sh` 在校验并启动临时 Go program 前不修改永久状态；
Go program 打开 root 管理、稳定 inode 的 `locks/enrollment.lock`，使用 `O_NOFOLLOW` 并核对
regular-file/owner/mode 后取得内核级排他 `flock`。锁 FD 覆盖程序安装、降权后的 enroll
子进程、claim、provider operation 创建和 LaunchDaemon 注册。并发执行第二条命令不能读取、
生成或覆盖 pending secret/state。进程崩溃由内核自动释放锁；持久 lock 文件不是锁状态，
下一进程取得锁后必须按 state/hash 恢复，禁止按文件年龄强删所谓“陈旧锁”。

安装进程与 LaunchDaemon 使用显式锁交接，消除 release/acquire 窗口：

1. 安装进程持锁生成一个非 Secret `handoffNonce`，把它同时写入 root-owned plist 参数与
   `service_starting` state，连同 daemon label、binary hash、Computer ID 一起 fsync；
2. 安装进程持锁执行幂等 `launchctl bootstrap/kickstart`；新 daemon 已启动但阻塞在同一锁；
3. 安装进程释放锁并结束；只有携带与 state 完全匹配 `handoffNonce` 的 daemon 可以取得锁，
   原子推进为 `service_started/complete`，随后在整个生命周期持续持锁；
4. 交接窗口内若另一个安装进程先抢到锁，它看到 `service_starting` 后只能核对 plist/hash、
   幂等 kickstart、立即释放并只读等待，禁止生成 secret、改变 nonce 或回退阶段；
5. 若原安装进程在写入 state 后、kickstart 前崩溃，重跑执行第 4 步即可恢复；若 daemon
   已启动但在取得锁前任一进程崩溃，内核释放锁后 daemon 继续交接；nonce 不匹配的 daemon
   必须退出且不得写 state。已 `complete` 的同 nonce daemon 重启可直接恢复持锁运行。

当前 `darwin-arm64` 使用机器级 LaunchDaemon，需要安装时一次 sudo，但 daemon 的
`UserName` 固定为发起安装的非 root 用户，Agent/PTY/工作区均不以 root 运行：

- 程序安装到 `/Library/Application Support/AgentNetwork/Computer/bin`，root 所有、`0755`；
- `locks` 目录由 root 管理，lock 文件为 root 所有并只向目标运行用户组开放；state 目录中的
  普通用户不能替换 lock inode；
- 状态目录位于同一根下的 `state`，由目标运行用户所有、目录 `0700`、Secret 文件 `0600`；
- plist 原子写入 `/Library/LaunchDaemons`，root 所有、`0644`，固定 `UserName`、绝对路径和
  最小环境；使用 `launchctl bootstrap system` 与 `kickstart`，不依赖用户登录会话；
- 内嵌 provider 是同一 `chatserver-computer` 进程内的 Rust staticlib，不安装额外 daemon、
  内核扩展或系统插件；只在 state 下写 `config.dat/computer.json/log` 并向外建立连接；
- `raft-computer-go`、IM bridge 和 Agent workspace 由该非 root 用户在受限 Agent 目录运行；
- provider PTY/命令以同一非 root 用户执行，不继承安装阶段的 sudo 环境；
- 非目标用户所有、符号链接、宽权限目录或无法设置 owner/mode 时确定失败；
- 安装成功前不卸载/覆盖正在工作的旧进程，替换通过同目录临时文件、fsync 和原子 rename。

Canary 必须验证首次 sudo、安装用户与 daemon 实际 UID、重启后未登录即启动、注销/登录、
睡眠恢复、PTY 用户身份和所有 state 文件 owner/mode。任一底层 provider 操作要求 root，
则 `darwin-arm64` 不得发布，不能临时扩大 daemon 权限。

Linux/Windows 尚不在 V1 target。加入 Linux 前必须定义 rootless/systemd-user 与 system
service 选择；加入 Windows 前必须定义 UAC、服务账户、ACL 和运行中二进制替换。未完成
对应设计和测试前，后台、UI 和 manifest 均拒绝这些 target。

## 10. 发布与签名

V1 选择离线 Ed25519 签名；私钥不进入仓库、构建镜像、COS 或 Kubernetes Secret，发布
命令只通过受限文件描述符读取。正式环境后续可迁移 KMS，但不允许双签名语义并存。

发布工具只接受本地已构建文件，正式上传使用桶级最小权限 CAM Role/STS；聊天中出现过的
永久密钥必须在正式发布前轮换。顺序为：

1. 生成 manifest；
2. 离线签名；
3. 上传版本化安装器与程序；
4. 上传 manifest 和签名；
5. 对所有对象重新 GET，按实际字节核对长度与 SHA-256；
6. 把该版本写入后台固定 release 配置。

桶保持关闭版本控制。所有 PUT/分块完成请求必须携带 `x-cos-forbid-overwrite: true`，发布
身份的 CAM policy 同时强制该条件；同 key 并发上传只能有一个成功。收到“对象已存在”后
重新 GET 实际内容，SHA-256 相同才视为幂等，不同立即失败。任何失败都不能让后台宣告新
版本；禁止把 ETag 当成 manifest SHA-256。两个发布者用相同 key 上传不同内容时，失败方
不得覆盖、激活或修改 catalog。

## 11. 失败恢复与安全日志

- token 过期且尚未 claim：产品显示“安装命令已过期”，允许基于最新 revision 重新生成。
- 下载、重定向、签名或 hash 失败：不执行程序，删除当前临时文件。
- claim 响应丢失：用同 token + 同 digest 重试，恢复相同 credential version。
- credential 已 claim、服务安装失败：保留本地 credential，重跑后从对应阶段继续。
- provider 注册失败：保持“连接失败”，公开 DTO 只返回稳定产品码和文案。
- 后台收敛超时：不重复创建 Computer；继续刷新同一资源。
- Computer 已 claim：禁止生成普通 setup command；本机重跑沿用 pending/正式 credential，
  换机器则停用原 Computer 并创建新资源。重装/迁移另立显式流程。

token、Computer credential 和 provider bootstrap 不得进入服务端访问日志、应用日志、
命令回显、UI 持久状态、URL、分析事件、错误遥测或测试 fixture。COS query 只允许短暂存在
于内部 `Location` 与 curl 出站 URL，不得出现在其他上述位置。所有日志和错误只保留阶段、
稳定码和 request ID。

## 12. 测试与验收

生产行为全部按 RED→GREEN 实施：

- Human/Internal OpenAPI 生成隔离、路由 allowlist 和 Human 契约禁词扫描；
- SQLite/TDSQL migration、分片路由和禁止 token hash 全分片扫描；
- token canonical parsing、常量时间比较、过期、限流、generation 溢出；
- `If-Match`、并发生成命令、仅最后一份未 claim generation 有效、claim 后拒绝重发；
- claim 提交前失败、提交后响应截断、同 digest 重试、不同 digest 冲突；
- claim 在原 token 过期后只读恢复同 route/version，直到 online/停用；未 claim 重发立即失效；
- 未 claim 重发原子撤销上一代 token；claim 后换机器必须创建新 Computer；
- 命令有效期内切换后台当前 release，旧命令仍只能使用固化的全部对象/hash/key ID/program；
- 私有 COS 307、对象白名单、签名 URL 过期/篡改、禁止 API 代理字节；
- 根对象特判、manifest 不自引用、bootstrap SHA、manifest 签名、program hash、错误 target；
- 每个安装阶段中断后重跑、权限错误、符号链接、原子替换和失败清理；同机双执行只能有
  一个 writer，进程崩溃释放内核锁后按 state 恢复；
- 锁交接在 state 写入前、写入后/kickstart 前、daemon 启动后/取锁前分别崩溃均可恢复；
  交接窗口内第二安装进程只能幂等 kickstart，nonce 不匹配 daemon 不能写 state；
- token 临时文件/curl config/文件描述符、全路径 trap、进程参数和环境无 token；恶意
  `.curlrc`、trace 环境、`--location-trusted` 均不能泄露 Authorization；
- provider Operation 并发请求 single-flight、attempt CAS 不超过三次；注册成功后本地
  identity 落盘前崩溃，候选有界、确定性选主并自动注销重复实例；
- LaunchDaemon bootstrap/kickstart、daemon UID、注销/登录、重启未登录、睡眠恢复和 PTY UID；
- 产品 DTO `connectionIssue` 只映射后台事实，claim 前本机失败不伪造后台状态；
- command/token/Authorization/Location/credential 的日志与产物扫描；
- UI 仅显示 release 支持平台，关闭命令面板后内存清除；
- 关闭 COS 版本控制、CAM 强制 forbid-overwrite、两个发布者同 key 不同内容竞争且失败方
  不得覆盖；激活前 GET 实际字节计算 SHA-256，禁止以 ETag 代替；
- 独立 Canary：复制命令 → 校验安装器 → 安装 → claim → provider 注册 → system
  LaunchDaemon 启动 → daemon 以目标非 root UID 运行 → 用户未登录时 Computer 在线；
  Human API、UI 和日志不出现云厂商实现文案。
