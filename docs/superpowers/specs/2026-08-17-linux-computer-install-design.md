# Vela Computer Linux 正式安装设计

日期：2026-08-17  
状态：已由产品方向确认，待规格审查

## 目标

在不分叉用户安装入口的前提下，让同一条公开命令：

```sh
curl -fsS <platform>/install | sh -s -- <setup-code>
```

自动识别并正式支持以下两个目标：

- `darwin-arm64`：macOS ARM64，launchd 用户服务；
- `linux-amd64`：glibc Linux x86_64，root systemd 系统服务。

首版 Linux 支持 TencentOS、CentOS 和 Ubuntu 一类采用 glibc、systemd 的服务器；不包含
Linux ARM64、Alpine/musl、Windows 和无 systemd 环境。

成功标准不是“Linux 能下载二进制”，而是公开安装命令在干净 Linux VM 上完成签名校验、
Computer enrollment、TAT 注册、systemd 持久启动并在平台显示在线，同时不回归 macOS 安装与升级。

## 第一性原理和对象语义

`Computer` 仍是执行资源的权威对象。平台类型是 Computer 的实际属性，不应由某个 Web 页面
永久猜定。创建 Computer 时 UI 可以选择一个平台用于初始展示和说明，但 provisioning 阶段该值
只是提示；公开 shell 检测到的实际平台在首次成功兑换 setup code 时成为 enrollment 的固定 target，
并更新 Computer 的 `osType`。UI 提示与实际平台不一致不阻断首次安装。

发布信息属于 registry，不是新的业务实体。一个版本由不可变的 Release Set 表示，Release Set
包含多个独立 target。一次 enrollment 在 target 绑定后仍只引用一份 `ReleaseBinding`，因此后续
下载、claim、替换和审计都保持单一且确定。

同一个 setup code 在相同 target 上可安全重试。首次成功绑定 target 后，不允许同一个 code 再切换
到另一个 target。这防止一个泄露或并发执行的 code 同时驱动两套机器；这不是 UI 平台不一致校验，
而是一次性 enrollment 的并发边界。

## 方案选择

采用“通用 bootstrap + 动态 target 绑定 + 多目标 Release Set”。

未采用以下方案：

- 兑换时无条件覆盖 target：会让一次 enrollment 并发指向多套制品，破坏幂等和审计；
- `/install-macos` 与 `/install-linux` 两套入口：会永久分叉安全校验、文档和运维流程；
- Mac 上直接 `GOOS=linux` 交叉编译：Linux TAT 是 Rust staticlib + Go CGO，普通 Go 交叉编译
  无法产生可验收的目标二进制；
- 只把 `stat -f` 改为 `stat -c`：下载到的仍会是 macOS 二进制，服务管理仍会落到 launchd，属于假支持。

## 发布模型

现有单 target catalog 升级为一个不可变 Release Set：

```text
release-set vX.Y.Z
├── darwin-arm64
│   ├── manifest.json
│   ├── manifest.sig
│   ├── install.sh
│   └── vela-computer
└── linux-amd64
    ├── manifest.json
    ├── manifest.sig
    ├── install.sh
    └── vela-computer
```

ConfigMap 仍只挂载一个名为 `release.catalog.json` 的 key，`serve` 仍使用现有
`--computer-release-file` 参数读取它；变化只发生在文件内容的 schema。新文件是严格 JSON：

```json
{
  "schema": "agent-network-computer-release-set/v1",
  "version": "vX.Y.Z",
  "targets": [
    {
      "target": "darwin-arm64",
      "osType": "macos",
      "architecture": "arm64",
      "signingKeyId": "computer-release-key-id",
      "manifest": {"objectKey": "computer/releases/vX.Y.Z/darwin-arm64/manifest.json", "sha256": "...", "size": 1},
      "signature": {"objectKey": "computer/releases/vX.Y.Z/darwin-arm64/manifest.sig", "sha256": "...", "size": 1},
      "installer": {"objectKey": "computer/releases/vX.Y.Z/darwin-arm64/install.sh", "sha256": "...", "size": 1},
      "program": {"objectKey": "computer/releases/vX.Y.Z/darwin-arm64/vela-computer", "sha256": "...", "size": 1}
    },
    {
      "target": "linux-amd64",
      "osType": "linux",
      "architecture": "amd64",
      "signingKeyId": "computer-release-key-id",
      "manifest": {"objectKey": "computer/releases/vX.Y.Z/linux-amd64/manifest.json", "sha256": "...", "size": 1},
      "signature": {"objectKey": "computer/releases/vX.Y.Z/linux-amd64/manifest.sig", "sha256": "...", "size": 1},
      "installer": {"objectKey": "computer/releases/vX.Y.Z/linux-amd64/install.sh", "sha256": "...", "size": 1},
      "program": {"objectKey": "computer/releases/vX.Y.Z/linux-amd64/vela-computer", "sha256": "...", "size": 1}
    }
  ]
}
```

Loader 使用 `DisallowUnknownFields`，要求 targets 按 target 字典序排列、不得重复、版本完全一致，且
正式目录必须恰好包含上述两个受支持组合。对象键必须精确位于
`computer/releases/<version>/<target>/`，hash 为小写 64 位十六进制，size 为正数。每个 target
的 manifest 内容只列出本 target 的 program，并由该 target 记录的 key 签名。

`computerrelease.LoadCatalog` 替换为返回 `ReleaseSet` 的 `LoadReleaseSet`；`serve` 启动时一次性
加载并校验整个集合，把它注入 enrollment API。发布脚本为两个 target 分别构建、验签和发布后，
再生成这一个索引；COS 对象继续 create-only，ConfigMap 继续使用不可变版本名并回读校验内容。

macOS 产物继续在 Mac 原生构建。Linux 产物通过 Docker Buildx 构建 `linux/amd64`：Mac 只发起
发布和验收，构建发生在已经配置好的远端 Linux Docker builder/BuildKit，产出 Rust TAT staticlib
和带 `vela_tat_cgo` build tag 的 Go 二进制。发布不依赖 Mac 本机 Docker daemon。

Buildx 构建必须使用固定基础镜像 digest、干净且已推送的 Git HEAD、`-trimpath` 和显式版本
ldflags。产出的文件通过 Buildx local output 返回，由发布脚本验证 ELF x86-64、版本、CGO TAT
bridge 自检和 SHA-256 后才进入 Release Set。发布证据记录源 commit SHA、builder image digest、
Buildx metadata/provenance、输出 SHA-256 和签名公钥 fingerprint。

## 安装数据流

1. Human 创建 provisioning Computer。UI 可选择 macOS 或 Linux 作为提示。
2. 生成 setup command 时，后台创建 generation、短码和 token，并把当时完整 Release Set 的
   版本化 snapshot 固化到 enrollment；暂不选择其中的 target。
3. 第一阶段 `/install` POSIX shell 在发送短码前执行本机前置检查：
   - `Darwin + arm64` 映射为 `darwin-arm64`；
   - `Linux + x86_64/amd64` 映射为 `linux-amd64`；
   - Linux 还必须是 root、存在 systemd 且 `systemctl` 可用；
   - 其他组合直接失败，短码不离开本机。
4. shell 继续仅通过 POST body 发送短码，并通过 `X-Vela-Computer-Target` 请求头发送规范化 target；
   短码不得进入 URL、header、文件名或日志。
5. 后台解析短码路由，在 Computer 所在 shard 上用 generation/CAS 原子完成 target 绑定：
   - 未绑定：保存目标 ReleaseBinding，并把 provisioning Computer 的 `osType` 更新为实际 OS；
   - 已绑定相同 target：返回同一安装脚本；
   - 已绑定其他 target：返回稳定冲突错误，不切换绑定。
6. 第二阶段 target 专属安装器下载 manifest、signature 和 program，逐项校验固定 SHA-256、大小和
   Ed25519 签名，再调用下载二进制的隐藏 `install` 命令。
7. Agent claim 继续只上报由编译目标推导的 `osType` 和 `architecture`；后台通过受支持映射推导
   target，并与 enrollment 的 ReleaseBinding 精确匹配，不在 claim DTO 中重复增加 target。
8. Agent 注册 TAT、写入本地状态并启动平台服务；成功后 journal 进入 `complete`。

请求中的 target 不是安全信任根：它只能从后台批准的 Release Set 中选择签名制品。最终 claim
还会由目标二进制再次证明平台组合，并与已绑定 ReleaseBinding 比较。

## Agent 平台抽象

安装服务增加一个只读 Platform 描述：`OSType`、`Architecture`、`Target` 和服务管理类型。
生产实现由 Go build target 给出：

- Darwin ARM64：`macos` / `arm64` / `darwin-arm64` / launchd；
- Linux AMD64：`linux` / `amd64` / `linux-amd64` / systemd。

claim、替换 preflight、journal 校验和 options 校验全部使用该描述，不再硬编码
`macos`、`arm64`、`darwin-arm64`。测试可以注入 Platform，避免依赖测试宿主机。

Linux 增加 CGO bridge，链接 Buildx 内构建的 `libvela_tat.a`。没有目标 native bridge 的构建
不得被发布脚本接受。

## Linux 文件与 systemd 约定

Linux 安装必须由 root 执行：

```text
/var/lib/vela/computer/
├── bin/vela-computer
└── state/

/etc/systemd/system/vela-computer.service
```

unit 使用绝对 `ExecStart` 执行 `daemon run --state-dir ...`，设置 `UMask=0077`、明确 PATH、
`Restart=always` 和有限的 `RestartSec`。manager 采用原子文件替换，然后执行
`systemctl daemon-reload`、`enable --now`，最后验证 enabled、active 和 MainPID。失败不能把
journal 写成 complete；相同配置重复执行必须幂等，二进制或 runtime config digest 变化时必须重载。

首版不增加可能阻断 TAT、Codex 或子进程运行的激进 systemd sandbox 选项。权限收紧应通过独立
运行时验证后逐项加入。

macOS 文件位置和 launchd 行为保持不变。

## API 和持久化变化

OpenAPI 先行修改：

- `CreateComputerRequest.osType` 成为必填的 UI 提示，只允许 `macos`、`linux`；Handler 不再硬编码
  macOS。该值在 provisioning 阶段允许被真实兑换 target 覆盖，claim 后恢复为不可变实际属性；
- installation options 返回同一版本下 `macos/arm64` 和 `linux/amd64`；
- artifact target enum 为 `darwin-arm64`、`linux-amd64`；
- setup-code redemption 必须携带 header `X-Vela-Computer-Target`，enum 为
  `darwin-arm64`、`linux-amd64`；
- enrollment claim 的 `osType` enum 为 `macos`、`linux`，architecture enum 为
  `arm64`、`amd64`。应用层只接受两个合法配对，不接受交叉组合；
- 新增 `computer_install_target_unsupported`（HTTP 422）和
  `setup_code_target_conflict`（HTTP 409）静态错误码。缺失/未知 target 使用前者；已绑定另一
  target 使用后者。`setup_code_invalid` 继续只表示短码无效、过期或已认领。

第一阶段 shell 在本机已经过滤未知平台；它对 422 显示不支持平台，对 409 显示安装码已由另一
平台绑定，对 401/403/404/410 继续显示安装码无效，且从不执行错误响应正文。

### 两阶段 enrollment 状态机

当前 repository 确实在 `BeginEnrollment` 提前写入单 target release；本设计明确替换该行为：

1. `BeginEnrollmentCommand` 接收 `ReleaseSetSnapshot`，不再接收单个 `ReleaseBinding`。
2. 追加 Computer 可空字段 `enrollment_release_set_json`。它使用
   `internal/persistedjson` 注册的 `computer.enrollment.release-set/v1` codec 保存当时两个 target
   的完整不可变 snapshot；已发布 migration 不修改，新增 SQLite/TDSQL migration、Ent field、
   物理规格和模型契约同步项。
3. `BeginEnrollment` 清空现有 target/architecture/manifest/signature/installer/program 绑定字段，
   写入 release-set snapshot。token 仍只由 code、server、computer、generation 派生，不包含 target，
   因而 target 绑定前后不更换 token。
4. 新 repository 命令 `BindEnrollmentTarget` 携带 server ID、computer ID、generation、token hash、
   requestedAt 和规范化 target。它在 Computer shard 的单事务中验证 provisioning、未认领、generation、
   token、expiry 和 snapshot，然后执行 CAS：
   - release 字段全空且 snapshot 存在：从 snapshot 选择目标，写入现有 release 字段、清除 snapshot、
     把 `os_type` 改为实际 OS、revision 加一并返回绑定；
   - release 字段完整、snapshot 已清除且 target 相同：从 bound release 原样返回，不增加 revision；
   - release 字段完整但 target 不同：返回 `ErrSetupCodeTargetConflict`；
   - release 字段部分写入，或 release/snapshot 同时为空：返回内部数据错误，不自动修复。
5. `RedeemSetupCode` 在解析 code route 和重建 token 后直接调用 `BindEnrollmentTarget`；绑定和有效性
   验证是同一个 repository 事务，不再先调用返回单 target 的 `ValidateSetupCode`。
6. target 成功绑定后清除 release-set snapshot，因为完整 bound release 已进入现有列；为便于同
   target 重试，repository 必须能从 bound release 重建 `SetupCodeRelease`。

这是现有 authority 行上的一次 enrollment 状态迁移，不新增业务实体。迁移只追加，数据库没有需要
兼容的存量 enrollment，但新旧 Backend 滚动期间由发布顺序保证：先应用可空列 migration，再发布
只写新状态机的 Backend，最后发布双 target catalog。

### Replacement 绑定

replacement 不再读取全局 `service.config.Release`：

- `AuthorizeReplacementCommand` 只携带旧/新 Computer identity、generation、token hash 和 TAT identity；
- repository 从新 provisioning Computer 的已绑定 release 列读取并验证
  `releaseVersion/target/programSHA256`，在 `ReplacementAuthorization` 中返回这三个值；
- application 使用 repository 返回值签发 grant；
- `verifyReplacementGrant` 只验证签名、route、时效和结构，最终 release 一致性由 claim transaction
  与新 Computer 的 bound release 比较；
- 未完成 target 绑定的新 enrollment 不能获得 replacement grant；
- 同平台替换继续支持。跨平台不作为原地升级路径，必须创建并安装另一台 Computer。

## 代码所有权和跨目录契约

- `backend/`：Release Set loader/build/publish、OpenAPI、target CAS、持久化、artifact 签名 URL 和
  Canary 切换；
- `agent/`：通用 target 感知安装命令、Linux TAT CGO bridge、systemd manager、Linux Buildx
  Dockerfile 和二进制自检；
- `web/`：创建 Computer 的 macOS/Linux 选择、支持平台说明和 provisioning 实际平台刷新。

两个 target 安装器调用同一个隐藏 CLI 契约：`vela-computer install --platform-url ... --token-file ...
--manifest-file ... --signature-file ... --signing-public-key ... --release-version ... --target ...`。
Backend 只依赖该 CLI 的签名验证、claim 字段和完成/错误语义，不依赖 launchd/systemd 内部实现。

## 错误语义

用户可操作错误必须明确且不暴露 token、COS URL 或底层命令输出：

- 不支持的 OS/架构：列出当前支持的两个 target；
- Linux 非 root：提示使用 root 重新运行，且尚未兑换 setup code；
- systemd 不可用：提示该 Linux 环境暂不支持，且尚未兑换 setup code；
- target 已被另一个首次兑换绑定：提示生成新的 setup code；
- 本机已有其他 Server 的完整安装：明确提示需要先在原 Server 解除/迁移，不能继续显示笼统
  “Computer 首次安装状态冲突”；
- hash、size、signature 任一失败：停止安装，不启动服务，不把 journal 标记 complete。

## 测试和验收

实现严格按 RED → GREEN → REFACTOR 分片推进：

1. bootstrap shell target 检测、Linux 前置条件、短码不泄露；
2. Release Set 严格解析、对象路径绑定、未知 target 和重复 target 拒绝；
3. enrollment 首次 target CAS、同 target 重试、跨 target 并发冲突；
4. OpenAPI 契约和生成客户端；
5. Agent Platform 推导和 claim 参数；
6. Linux systemd manager 的 unit、幂等、reload、失败恢复；
7. Linux CGO 构建门禁和发布脚本双 target 门禁；
8. macOS 既有安装、替换和 launchd 回归。

仓库门禁包括 Backend 全量 test/vet/race、generated/migration/OpenAPI/TDSQL/secret checks，Agent
Go 与 Rust 全量测试，以及 Web client-core 生成、测试、类型检查和生产构建。

真实发布验收必须同时证明：

- Release Set 在 COS 与 ConfigMap 中不可变且两个 target 均可独立验签；
- Canary 3/3 Ready、零重启并挂载目标 Release Set；
- 干净 TencentOS VM 执行公开命令后，程序 hash/版本正确；
- `vela-computer.service` 为 enabled + active，MainPID 对应目标二进制；
- TAT identity 存在，Computer 在平台显示 online；
- 同一命令重试不会产生第二份 identity 或损坏状态；
- macOS 现有安装/升级链路仍通过。

## 发布与回滚

双 target 是一个发布单元：缺少任一 target、任一签名失败或任一平台门禁失败都不得切换 live
Release Set。发布脚本先发布不可覆盖 COS 对象，再创建唯一 ConfigMap，最后切换 Canary。

切换后的 Backend 健康检查或 catalog 验收失败时恢复原 ConfigMap。已经完成 target 绑定的 enrollment
继续引用其固化对象，不依赖“latest”指针；因此回滚后台目录不会把正在安装的机器切换到另一二进制。
