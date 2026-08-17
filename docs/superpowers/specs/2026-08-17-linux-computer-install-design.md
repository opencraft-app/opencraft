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

Release Set 索引记录版本及两个 target 的 `osType`、`architecture`、签名 key id 和四类制品绑定。
每个 target 的 manifest 和 signature 都放在自己的 target 目录，避免当前共享
`manifest.json`/`manifest.sig` 的对象键冲突。COS 对象继续 create-only；Kubernetes ConfigMap
继续使用不可变版本名并回读校验内容。

macOS 产物继续在 Mac 原生构建。Linux 产物通过 Docker Buildx 构建 `linux/amd64`：Mac 只发起
发布和验收，构建发生在已经配置好的远端 Linux Docker builder/BuildKit，产出 Rust TAT staticlib
和带 `vela_tat_cgo` build tag 的 Go 二进制。发布不依赖 Mac 本机 Docker daemon。

Buildx 构建必须使用固定基础镜像、干净 Git HEAD、`-trimpath` 和显式版本 ldflags。产出的文件通过
Buildx local output 返回，由发布脚本验证版本、目标格式和 SHA-256 后才进入 Release Set。

## 安装数据流

1. Human 创建 provisioning Computer。UI 可选择 macOS 或 Linux 作为提示。
2. 生成 setup command 时，后台创建 generation、短码和 token，但暂不固化 target 制品。
3. 第一阶段 `/install` POSIX shell 在发送短码前执行本机前置检查：
   - `Darwin + arm64` 映射为 `darwin-arm64`；
   - `Linux + x86_64/amd64` 映射为 `linux-amd64`；
   - Linux 还必须是 root、存在 systemd 且 `systemctl` 可用；
   - 其他组合直接失败，短码不离开本机。
4. shell 继续仅通过 POST body 发送短码，并通过受限请求头发送规范化 target；短码不得进入 URL、
   header、文件名或日志。
5. 后台解析短码路由，在 Computer 所在 shard 上用 generation/CAS 原子完成 target 绑定：
   - 未绑定：保存目标 ReleaseBinding，并把 provisioning Computer 的 `osType` 更新为实际 OS；
   - 已绑定相同 target：返回同一安装脚本；
   - 已绑定其他 target：返回稳定冲突错误，不切换绑定。
6. 第二阶段 target 专属安装器下载 manifest、signature 和 program，逐项校验固定 SHA-256、大小和
   Ed25519 签名，再调用下载二进制的隐藏 `install` 命令。
7. Agent claim 上报由编译目标推导的 `osType`、`architecture` 和 target。后台必须与 enrollment
   的 ReleaseBinding 精确匹配。
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

- installation options 增加 `linux/amd64`；
- enrollment claim 允许两个有效平台组合；
- artifact target 增加 `linux-amd64`；
- setup-code redemption 增加规范化 target header；
- 增加静态错误码，区分 unsupported platform、target 已被另一兑换绑定等情况。

数据库不新增业务实体。现有 enrollment release 字段本来可空：生成安装码时保持未绑定，首次兑换时
在同一个 Computer shard 内填写现有 release 字段并更新 provisioning Computer 的 `os_type`。
若当前 repository 约束要求 BeginEnrollment 立即携带完整 release，则调整为两阶段状态机并同步
模型契约、物理规格和一致性测试。已发布 migration 不修改；只有在真实 schema 需要新字段时才追加
migration。

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

