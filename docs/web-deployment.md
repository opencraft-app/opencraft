# Web 安装与一键更新

公共 npm 包 `@opencraft-app/opencraft` 包含网站、Web 服务和更新器。Node.js 22 或更新版本和 npm 是运行前提。默认包只包含网站；执行服务独立部署，通过 WebSocket 地址接入。带执行端 payload 的服务器包可在明确配置受管执行服务后同时升级网站、执行网关、daemon 和 DSH capability adapter；DSH 引擎、Codex core 与 CLI 仍独立维护。

直接从源码打包并替换已有服务器网站，见[本地替换指引](web-local-deployment.md)；该流程使用本地包，不需要先发布 npm。

## 首次安装

在部署用户自己的 npm 配置中设置npm 源和认证；认证凭据只留在服务器，不写入网页或仓库：

```ini
@opencraft-app:registry=https://registry.npmjs.org/
```

首次试运行（将版本与执行地址替换为实际值）：

```sh
OPENCRAFT_APPSERVER_URL=ws://127.0.0.1:9989/rpc \
OPENCRAFT_WEB_STATE="$PWD/opencraft-web-state" \
npx --registry=https://registry.npmjs.org/ \
  "@opencraft-app/opencraft@${OPENCRAFT_RELEASE_VERSION:?设置精确安装版本}"
```

长期运行时固定安装启动包，避免每次服务启动重新解析 `latest`：

```sh
npm install --prefix /opt/opencraft-web/bootstrap --ignore-scripts \
  --registry=https://registry.npmjs.org/ \
  "@opencraft-app/opencraft@${OPENCRAFT_RELEASE_VERSION:?设置精确安装版本}"
```

使用包内 `opencraft-web.service` 作为 systemd 模板，核对 Node 路径与运行用户；配置 `/etc/opencraft-web.env`：

```ini
OPENCRAFT_WEB_HOST=127.0.0.1
OPENCRAFT_WEB_PORT=10000
OPENCRAFT_WEB_STATE=/var/lib/opencraft-web
OPENCRAFT_APPSERVER_URL=ws://127.0.0.1:9989/rpc
OPENCRAFT_PUBLIC_ORIGIN=https://opencraft.example.com
OPENCRAFT_NPM_REGISTRY=https://registry.npmjs.org/
# 可选：指定部署用户的 npm 配置文件
# OPENCRAFT_NPM_USERCONFIG=/home/deploy/.npmrc
# 可选：Codex 使用独立地址
# OPENCRAFT_CODEX_APPSERVER_URL=ws://127.0.0.1:9988/rpc/codex
```

反向代理将 HTTP 和 WebSocket 一起转发到网站端口，不过滤 `/__opencraft_updates`；保留已有的域名访问认证。执行服务放在另一 systemd unit/cgroup，网站 unit 不得使用会停止执行服务的 `PartOf`、`BindsTo` 或升级脚本。

## 服务器执行端更新

`npm run package:web:server:execution` 生成包含 `execution/` 的服务器包，版本仍使用 `OPENCRAFT_RELEASE_VERSION`。包记录执行协议、构建平台、架构和 Node ABI，附带 gateway、daemon、DSH capability adapter 与 node-pty；不包含 Codex core、CLI、DSH 引擎、模型配置或账户数据。跨平台/Node ABI 的包不能安装到受管执行端。普通 `package:web:server` 保留网站独立升级语义。

首次接入需要一次部署迁移，网页旧更新器不会自动升级自己。先按 [Codex core](codex-core.md) 将服务器改为独立 core；在无活动 OpenCraft/DSH 任务的维护时段安装新的固定启动包和 `opencraft-execution.service` 模板。保留执行状态、机器身份、token、模型和 core 数据，停止旧执行侧后再启用新执行 unit，避免两个 daemon 同时写入。迁移不自动升级 core 或 CLI。

执行 unit 消费 `/etc/opencraft-execution.env`，路径按实际部署填写：

```ini
OPENCRAFT_EXECUTION_CWD=/srv/opencraft
OPENCRAFT_EXECUTION_STATE=/var/lib/opencraft
OPENCRAFT_CODEX_CORE_ENDPOINT=/run/opencraft-codex-core/control.sock
OPENCRAFT_DSH_EXECUTABLE=/opt/opencraft-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
OPENCRAFT_GATEWAY_PORT=9988
# 可选显示名
# OPENCRAFT_MACHINE_NAME=My server
```

`OPENCRAFT_EXECUTION_STATE/daemon.token` 必须沿用 core 使用的 token 文件，保持私有权限；不要生成第二份认证身份。执行 cwd 不使用包目录，用户项目 cwd 继续由 Thread/Project 决定。DSH 引擎是当前机器的固定安装，不从其他 checkout 借用。

网站 unit 消费的 `/etc/opencraft-web.env` 加入以下配置：

```ini
OPENCRAFT_EXECUTION_LINK=/var/lib/opencraft-web/execution-current
OPENCRAFT_EXECUTION_UNIT=opencraft-execution.service
OPENCRAFT_CODEX_CORE_UNIT=opencraft-codex-core.service
OPENCRAFT_CODEX_CORE_ENDPOINT=/run/opencraft-codex-core/control.sock
OPENCRAFT_DAEMON_TOKEN_FILE=/var/lib/opencraft/daemon.token
OPENCRAFT_EXECUTION_HEALTH_URL=http://127.0.0.1:9988/health
OPENCRAFT_APPSERVER_URL=ws://127.0.0.1:9988/rpc
OPENCRAFT_CODEX_APPSERVER_URL=ws://127.0.0.1:9988/rpc/codex
```

link 必须与执行 unit 的 `ExecStart` 一致，父目录已存在且网站部署用户可写；执行用户必须可遍历部署目录之外的祖先目录。不同服务用户时，部署机器需要 `setfacl` 和 `id`：更新器在每个新 release 上给执行用户授予只读/遍历 ACL，并仅给私有版本容器授予遍历权限，admin-key 和部署状态保持私有。core token 的读取权限只授予对应服务用户，服务器 gateway 只读取既有 token，不修改权限或重生成身份。网站部署用户需要查询 systemd 与重启**指定执行 unit**的权限，非 root 部署由运维配置对应的 systemd/Polkit 授权。核心服务独立 cgroup，不能配置 `PartOf`、`BindsTo` 或 `StopWhenUnneeded=yes`；执行 unit 使用 `KillMode=control-group`，不声明 `PropagatesStopTo`；双方不得以 `Conflicts` 冲突。更新前还核对 core 健康 PID 与所配置 core unit 的 MainPID 一致。仍可用 `Wants`/`After` 保证启动顺序。网站 unit 不负责启停 core。

启用配置后，网站启动器以 `deployment.json` 为版本权威，自动创建/恢复 execution-current 并检查执行端健康。第一次启动指向带 payload 的初始包，再启用执行 unit；启动器在等待执行端健康期间可以重启该 unit。缺少 payload、平台不符、core 不可用或 unit 不独立时，不继续切换。

daemon 在监听 IPC、报告 ready 前打开并迁移 Host 的五个 SQLite 库；失败则拒绝监听并非零退出，DSH 引擎仍懒启动。gateway `/health` 现在附带 `storage` 摘要（库名、打开处置 status、appliedVersion、可选 backupPath、movedAside），来自认证 `daemon/ready.storage`，不含业务记录或凭据。摘要不包含 Electron Main 或独立 codex-core 的 account-pool 库。存储失败由既有健康检查失败/执行版本回退逻辑处理，更新器的 `ok` 判定不变；完整语义见 [存储生命周期](sqlite-lifecycle.md)。

更新页显示实际执行网关版本和「更新网站和执行服务」。一次安装先下载并校验精确归档、启动候选网站，再切换 execution-current、重启执行 unit；新版 gateway 通过 daemon IPC/core 健康检查、版本/buildId 一致且 core/CLI PID 未变后，才提交网站版本。失败恢复原执行版本与网站；若回退也失败，页面显示失败原因和执行端实际版本/就绪状态，不冒称成功。重启启动器时按已提交版本修复中断的切换。执行指针以及持久化 pins 文件引用的包不能被历史清理删除。重启或回退结果不确定时，保留所有可能运行的执行版本，直到健康检查确认替换成功。页面版本取实际 gateway 健康响应，不用指针目标冒充正在运行的版本；无法确认时显示未知。

执行更新会断开网关连接；页面重连/resume 原 Codex 任务，不重发执行命令。OpenCraft/DSH 活动任务仍可能中断，更新页直接说明这个范围。回退使用同一切换流程，core 与账户数据保持独立。

验证入口：

```sh
npm run test:server-updates
npm run build:web:release
npm run smoke:server-updates
# 具备 systemd 运维权限时，使用临时独立 unit 验证真实重启边界
npm run smoke:server-updates:systemd
```

`test:server-updates` 覆盖安装/回退、执行启动失败、持久化失败、网站启动失败、进程中断恢复及 systemd 生命周期配置。smoke 使用隔离 HOME、合成账户和本地 Responses 端点，运行真实 Codex CLI、归档内 gateway/daemon、生产 SPA 和真实 npm；浏览器点安装时 shell 已在运行，断线后原 turn 完成，shell 开始/结束各一次、core/CLI/运行中子进程 PID 不变，再从页面回退。默认 smoke 的 systemd 边界由隔离进程重启替代；`:systemd` 入口在 `/run/systemd/system` 创建随机命名的临时 core/执行 unit，通过实际 `systemctl restart` 验证同一链路并在结束时删除自己的 unit。两种入口都不修改线上 unit、不使用真实账户或付费推理；生产服务器仍需核对权限与首次迁移。

## 本地源码与 npm 复用更新事务

`npm run update:server:local -- --version <exact-version>` 在当前 checkout 构建新的归档，然后经回环地址、既有管理密钥调用 `/install-local`。本地源只负责读取/复制归档并验证 SHA512；安装、解包、网站/执行切换、健康检查、回退与恢复均复用 npm 更新的同一事务。使用方式见 [统一源码入口](web-local-deployment.md#受管部署的统一源码升级入口)。后台任务返回唯一 jobId，命令只等待自己的任务，不把其他并发操作当成成功。

`npm run smoke:server-self-upgrade` 使用真实临时 systemd unit 和 Codex CLI，在 Codex 的 shell 工具内构建并执行上述命令，再重连原 turn、验证完成并从页面回退。模型与账户仍为本地合成边界，不访问真实模型服务。

## 网页操作

公共 npm 包是通用构建。网站服务在 HTML 中注入部署配置，首屏创建 Host 前已可用：`OPENCRAFT_APPSERVER_URL` 对应 `local` / OpenCraft Server，`OPENCRAFT_CODEX_APPSERVER_URL` 对应 `local-codex` / Codex，kind 均为 `remote-control`，使用同源 `/appserver`、`/codex-appserver`。配置至少一个上述 Host 时激活内置 Agent 设置页；无需部署用的 `VITE_*` 构建变量，网站更新后仍沿用服务自己的执行配置及稳定 hostId。

`OPENCRAFT_HYPERNODE_USER` 只传给执行端请求头，不决定 Host 身份。网站配置统一使用主端点 `local` 并关闭 HyperNode 插件，避免为同一地址创建第二个 Host。构建期 `VITE_APPSERVER_HOSTS_JSON` 是开发/测试的显式覆盖，优先于运行时列表；`VITE_WEB_BUILTIN_AGENTS` 和 `VITE_HYPERNODE_PLUGIN` 的 `enabled|disabled` 值可覆盖插件激活。无 HTML 配置的 Vite/static 部署保持原默认行为；注入配置损坏时启动报错并可重新加载，不静默回落。LightVela 不包含这两个插件，Electron 不消费网站配置。旧通用包的 `hypernode` 链接与浏览器历史在 Router 入口映射为 `local`，保留 threadId/draftId；旧活动会话和项目选择按缺失补入 `local`，保留旧值、不覆盖已有 `local` 偏好。这仅用于网站提供配置、没有显式 Host 覆盖且没有真实 `hypernode` profile 的 OpenCraft Web。

首次启动会在状态目录生成权限为 `0600` 的 `admin-key`，终端只显示文件位置。“设置 → 网站更新”直接显示“检查更新”，访问者无需部署密钥即可查询公共 npm `latest`。部署管理员读取该文件并授权管理后，可以安装更新、回退上一版。管理登录有效期一小时；需要同源 JSON 请求。

发布者按下文[公共 npm 发布流程](#公共-npm-发布流程)验证并上传精确 tgz。发布不会自动更新用户部署；用户点击“检查更新”读取最新版本，再点击“更新网站”安装已检查的精确版本与 integrity。npm 访问失败会在页面显示，当前网站继续运行。打包命令不执行发布。

## 可选发布前回归门禁

发布网站或服务器包前，可显式选择更新连续性回归；它不自动加入 `npm run gate`，也不上传包或替换正在使用的服务：

```sh
# 两种真实 systemd 场景都回归（默认）
npm run gate:server-updates
# 只验证浏览器安装与回退期间的 Codex 任务连续性
npm run gate:server-updates -- --scenario install
# 只验证 Codex 从源码构建、升级并完成原任务，随后页面回退
npm run gate:server-updates -- --scenario self-upgrade
```

门禁复用 `smoke-server-updates.ts`，先跑更新/失败恢复、core/daemon/token 聚焦测试，再构建当前生产 SPA，最后运行所选场景。要求 Linux、root 运行权限（临时 systemd unit）、当前 checkout 的依赖、可用 Codex CLI 和 Playwright Chromium，以及 `setfacl`/`runuser`；Chrome 可由 `OPENCRAFT_CHROMIUM_EXECUTABLE` 指定。测试模型标识固定 `gpt-6-luna`，Responses/账户为本地合成，不读取真实登录或调用付费模型。

每次产生独立 `.local/server-update-gate/<run>/report.json`、阶段日志及 PID/turn/命令次数证据。`--output <目录>` 只改变报告父目录，仍新建 run 目录，不覆盖旧结果。退出码 `0` 才表示所选回归通过；测试失败、缺少依赖、源文件在运行中变化、证据缺失或中断均返回非零并记录失败原因，不用旧 proof 充当本次结果。中断时通知验收脚本清理自己的 unit/profile，随后保留报告。

报告记录源码 commit、dirty 文件状态、源码指纹、Node/Codex 版本和所选场景。只选一种场景的结果不能称为完整门禁；未执行该可选门禁的发布记录标为「未运行」，而非「通过」。源码变化后需要重新回归。证据覆盖当前源码构建与隔离部署，仍需按下文核对最终发布 tgz 的身份、完整性与可分发性，不能把源码门禁替代最终归档验收。

## 公共 npm 发布流程

公共包使用 `@opencraft-app/opencraft`，源为 `https://registry.npmjs.org/`。首版 0.1.10 支持 Linux x64 / Node.js 24；包含网站、更新器、执行 gateway/daemon，不包含独立 Codex core、CLI 或 DSH 引擎，不是全新服务器一键安装器。

正式发布 workflow 为 `.github/workflows/release.yml`，只允许从 main 手动派发已有稳定 tag（如 `v0.1.10`）。包模板版本必须与 tag 相同；tag 必须位于 main 历史中。预检安装锁定依赖、执行相关测试和浏览器回归，然后构建一个 execution tgz、核对公开包内容并生成 SHA256 manifest。发布 job 只下载并发布这份归档，不重建；npm 版本已存在时只接受字节完全一致的归档。最后核对 npm 下载/安装及 GitHub Release 的归档、manifest 和 release notes。已上传后若最终校验失败，使用 `gh run rerun <run-id> --failed` 复用原归档，核对远端字节后继续，不重建或重复上传。

预检按 `package-lock.json` 缓存 npm 下载内容，仍执行 `npm ci`；按操作系统、架构与锁定的 Playwright 版本缓存浏览器，每次仍安装所需系统依赖。依赖安装、类型检查、翻译检查、各组测试、浏览器安装、打包、上传和发布后验证分别记录 Actions step 时间。浏览器回归使用 2 个 worker，各自拥有独立 registry、状态目录和动态端口。依赖审计由 security workflow 执行，不重复放在 release 的依赖安装中。

npm 上传返回成功后，公开 metadata 可能延迟出现。整包 metadata 可能受 CDN 缓存影响；发布烟测显式使用 `--metadata-source version-api` 查询公共精确版本接口 `/包名/版本`，验证返回的包名和版本，并记录缓存状态、等待及安装耗时。该模式不发送 npm 凭据；需要认证或没有此接口的 registry 继续使用默认 npm CLI 查询。精确接口的 HTTP 404 最多重试 30 次、间隔 10 秒，然后仍在独立临时目录运行 `npm install 包名@版本 --prefer-online`。安装 CLI 自身仍可能读取受缓存影响的整包 metadata；仅对明确的 `ETARGET` 且错误指向本次精确版本进行同样的有界重试，认证、网络、其他包缺失、错误版本和其他安装错误立即失败。用新 workflow 复核旧 tag 时，若 tag 内的 kit 尚未提供此参数，则使用原 npm CLI 查询。已存在版本的烟测不能证明新版本上传后的同步耗时，需在下一次真实发布中观察。

Trusted Publisher 的配置：GitHub Actions；组织 `opencraft-app`；仓库 `opencraft`；workflow filename `release.yml`；Environment `npm-release`。该 Environment 只允许 main。workflow 使用 OIDC，不存放长期 npm token。当前 GitHub 仓库为 private，发布显式关闭 provenance；不改变仓库可见性或宣称提供公共来源证明。首次真实发布需先以 npm 账号有效凭据上传本机验证过的归档，包存在后才能在 npm Settings 添加 Trusted Publisher；配置后按 npm 当前有效期要求及时通过 Actions 成功发布。

```sh
gh workflow run release.yml --repo opencraft-app/opencraft --ref main -f tag=v0.1.10
```

首次发布前选择未占用版本，在当前 checkout 使用 Node 24 构建。按任务范围完成 `npm run gate:server-updates`、typecheck、i18n、Web 更新 Playwright、独立审查。用 `OPENCRAFT_RELEASE_VERSION`、`OPENCRAFT_SOURCE_REVISION`、`OPENCRAFT_WEB_PACKAGE_OUTPUT` 记录版本、来源和独立输出，运行 `npm run package:web:server:execution`；再用 `node scripts/inspect-public-release.mjs /absolute/package.tgz` 验证归档。首次 CLI 发布显式指定 `--access public --tag latest --ignore-scripts --registry=https://registry.npmjs.org/`，发布精确 tgz。发布后必须查询精确版本/latest、下载校验并验证包内 buildId。上传响应不确定时先核对远端，不能直接重复发布或覆盖版本。

### 已有部署切换

旧启动器需要一次维护替换，网站热更新不会升级稳定入口自己。安装新的公共 npm 固定启动包、更新 unit 的启动路径和 registry。新包只识别公共包名，不读取旧包的 release 状态；使用新的状态目录启动，并保留原状态目录供人工恢复。沿用服务器已有执行配置、core token、机器身份、模型和账户数据。完成新部署健康验证后再切换代理；首次公共包启动不是旧部署的原位热升级。公开包查询/下载不需要发布凭据。

发布和安装是独立操作。发布不自动升级或重启已有部署；检查更新使用 latest，更新器安装已检查的精确版本和 integrity。自托管配置保持在服务器，不写入包或仓库。

## 连续性与回退

更新器保持入口进程运行，新版网站在独立进程通过健康检查后切换新请求。已有 WebSocket 留在原网站进程，关闭后该进程退出；更新任务清理不再被当前版本、上一版、运行中进程或磁盘状态引用的历史版本目录；旧页面需要的历史静态 chunks 保留。页面不会被强制刷新，可在工作完成后点击“刷新页面”。更新任务不依赖浏览器连接，页面关闭后仍继续。

初始网站会复制到可写状态目录；固定启动包可保持只读。安装失败保留原版；切换记录原子写入状态目录。服务重启读取上次已安装版本，未完成任务标记失败，不重发聊天或更新。回退同样先启动、检查上一版再切换。如持续磁盘错误导致状态恢复失败，页面明确提示，可能被状态引用的版本目录会保留；修复存储后重试更新或按 deployment.json 中 previous 恢复。保留状态目录和固定启动包可恢复部署；切勿删除正在运行的版本目录。

默认更新范围是包内网站 worker 与 Web 代理；显式受管服务器模式还包含上文执行端 payload。稳定入口/更新器本身不在此次热更新范围；新包必须使用 worker protocol 1，不兼容版本拒绝安装。入口维护升级需要单独安排服务重启；执行进程仍独立，但入口连接会重连。执行端的 Codex 连续性依赖独立 core，不能扩展成 DSH 引擎或 core/CLI 自身升级不中断的承诺。

SQLite 升级前备份由库 owner 用 `VACUUM INTO` 生成，Host 备份位于 `OPENCRAFT_EXECUTION_STATE/data/<库文件名>.pre-v<N>-<时间戳>.sqlite`，成功处置后默认保留 3 份。无账本旧库结构不一致时，先备份，再将原库及仍存在的同名 WAL/SHM 移到 `.legacy-<时间戳>`，移开文件保留、不自动清理。更新器不直接操作数据目录；回退只回退代码，不恢复数据，不承诺 N-1 旧二进制兼容。旧代码若不接受当前账本，回退也可能未就绪，不能用备份存在冒充自动回退成功。

人工恢复 Host 库时：先停止执行 unit（例如 `systemctl stop opencraft-execution.service`）并确认 daemon 已退出；保留当前库与 sidecar，核对备份身份、拟启动代码及备份之后会丢失的写入；用选定备份覆盖目标库文件并删除目标同名 `-wal` / `-shm`，保持私有权限；再启动执行 unit，核对 `/health.storage` 和业务数据。不要删除其他库的 sidecar 或 `.legacy-*`。account-pool 的恢复必须另停独立 codex-core，不因停止执行 unit 就认为其 owner 已停止；详见 [备份与恢复](sqlite-lifecycle.md#备份与恢复)。

## 检查结果与浏览器回归

公共 npm 源在包不存在时返回 `E404`。更新器将这些结果显示为“暂无发布版本”，不会误报为凭据故障，也不会允许安装。认证失败、网络故障、npm 缺失和其他源错误分别显示原因；服务器的原始 npm 输出及凭据不会发送到页面。检查失败时显示“检查失败”，不会继续显示“尚未检查”。

安装测试依赖和浏览器后运行完整生产网站的 Playwright 回归：

```sh
npm ci
npx playwright install chromium
npm run test:web-updates:e2e
```

也可设置 `OPENCRAFT_CHROMIUM_EXECUTABLE` 使用已安装的 Chrome。该命令先构建生产网站，再测试匿名检查、npm 源包不存在、认证/网络/源错误及重试、检查时密钥草稿和布局保持、管理员安装/回退、已有执行 WebSocket 连续性、失败保留原版，以及新页面实际加载的构建。测试使用独立状态目录、本地 npm 源和执行端点，运行真实 npm CLI 与包内 worker，不发布包、不启动模型推理。HTML 报告与失败 trace 放在 Git 忽略的 `.local/playwright/web-updates/`。WebSocket 回显证明代理连接保持，不能替代真实 DSH/Codex 执行连续性验证。

真实部署另有只读检查，必须显式指定预期发布结果：

```sh
OPENCRAFT_WEB_TEST_URL=https://opencraft.example.com \
OPENCRAFT_WEB_EXPECTED_LATEST="${OPENCRAFT_WEB_EXPECTED_LATEST:?设置精确版本或none}" \
npm run test:web-updates:live
```

它在真实页面点击检查，等待 npm 查询完成，断言发布结果、无查询错误以及页面/服务构建一致；不安装或回退。测试环境使用自签名证书时允许忽略证书错误，仅限此测试浏览器。预览网关登录可通过 `OPENCRAFT_PREVIEW_USERNAME`、`OPENCRAFT_PREVIEW_PASSWORD_FILE` 提供；登录测试不记录 trace、视频或失败截图，避免保存真实凭据。内部域名可通过 `OPENCRAFT_HOST_RESOLVER_RULES` 设置测试 Chrome 的域名映射。
