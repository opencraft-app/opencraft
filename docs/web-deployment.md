# Web 安装与一键更新

公共 npm 包 `@opencraft-app/opencraft` 包含网站、Web 服务和更新器。Node.js 22 或更新版本和 npm 是运行前提。默认包只包含网站；执行服务独立部署，通过 WebSocket 地址接入。带执行端 payload 的服务器包可在明确配置受管执行服务后同时升级网站、执行网关、daemon 和 DSH capability adapter；DSH 引擎、Codex core 与 CLI 仍独立维护。

直接从源码打包并替换已有服务器网站，见[本地替换指引](web-local-deployment.md)；该流程使用本地包，不需要先发布 npm。

## 可选 Web 资源

Web npm 默认单包自包含，包括PDF模块、worker、字体、CMaps、WASM与许可证；PDF在浏览器动态导入。中文使用系统字体，Inter和代码字体保留Latin/Latin Extended子集；Skills图片只压缩打包副本。Electron与嵌入式runtime继续内置。

仅显式设置 `OPENCRAFT_SPLIT_WEB_RESOURCES=1` 的兼容模式会将PDF放入独立资源包，主包精确绑定其版本/buildId/SHA512。该模式首次打开PDF时，Web worker使用服务器 `OPENCRAFT_NPM_REGISTRY` 与 `OPENCRAFT_NPM_USERCONFIG` 取得对应归档，校验并缓存后通过同源地址提供；用户 PDF 不上传到 registry。资源下载失败只影响可选预览，页面可重试，聊天、终端和工作区继续可用。凭据只在服务端使用。

缓存默认位于 Web state 的 `resource-cache/`，可以用 `OPENCRAFT_RESOURCE_CACHE_DIRECTORY` 显式指定。各版本目录与资源目录保持独立；缓存跨 worker 更新和重启保留。旧页面可能仍请求历史 chunk，当前保守保留资源包与版本索引，不随普通更新删除。不得在旧页面仍使用时手动清空缓存。

提前下载或在无外网部署时预装（release 指向实际受管版本）：

```sh
node /opt/opencraft-web/bootstrap/node_modules/@opencraft-app/opencraft/runtime/prefetch.mjs \
  --release /var/lib/opencraft-web/releases/RELEASE_ID/package \
  --state /var/lib/opencraft-web
# 预装时另加 --archive /absolute/opencraft-web-assets.tgz；仍核对主包绑定的 integrity。
```

配置自定义缓存目录时，预装命令也消费 `OPENCRAFT_RESOURCE_CACHE_DIRECTORY`。仅启动新 worker 即可接通资源路由，稳定入口协议保持 1；使用旧固定入口时应确保它的服务环境已设置正确的 registry 和 npm 配置路径。

私有 registry 的包名要求由部署侧确认；构建可显式设置 `OPENCRAFT_NPM_PACKAGE_NAME`、`OPENCRAFT_NPM_RESOURCE_PACKAGE_NAME` 和 `OPENCRAFT_NPM_REGISTRY`，归档、runtime、更新源和资源下载使用同一发行身份。首次换名须升级固定 bootstrap；新版保留原公共命名安装的载入和回退。公共默认值保持不变。默认只发布一个自包含主包，再推进该部署目标的频道；独立网站与Headless服务器使用不同构建和频道，更新器在切换前拒绝不匹配的execution profile。显式拆包时才先发布资源包。公开源暂不提供本次资源包，现有公开 workflow 显式设置 `OPENCRAFT_SPLIT_WEB_RESOURCES=0` 保持完整包；未来显式启用公开拆包时，须将两份固定归档一起交付，不能单独发布引用未发布资源的主包。完整设计见 [Web 可选资源交付](web-resource-delivery.md)。

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

更新页显示实际执行网关版本和「更新网站和执行服务」。一次安装先下载并校验精确归档、启动候选网站，再切换 execution-current。执行 payload 的归一化摘要变化时重启执行 unit；只有网站身份变化而后端相同时，先复用现有进程，健康失败才重启。健康版本从稳定执行指针对应的 manifest 读取；新版 gateway 通过 daemon IPC/core 健康检查、版本/buildId 一致且 core/CLI PID 未变后，才提交网站版本。失败恢复原执行版本与网站；若回退也失败，页面显示失败原因和执行端实际版本/就绪状态，不冒称成功。重启启动器时按已提交版本修复中断的切换。执行指针以及持久化 pins 文件引用的包不能被历史清理删除。重启或回退结果不确定时，保留所有可能运行的执行版本，直到健康检查确认替换成功。页面版本取实际 gateway 健康响应，不用指针目标冒充正在运行的版本；无法确认时显示未知。

执行更新会断开网关连接；页面重连/resume 原任务，不重发执行命令。Codex 连续性依赖独立 core；DSH 连续性依赖独立 DSH Host；Pi 连续性依赖下述独立执行 Host。三者均已独立部署时，网站热更新、执行网关重启和固定入口重启不停止这些 owner，运行中的原生推理与工具继续执行，重连读取原 Turn 的历史与终态。回退使用同一切换流程，保留这些进程及其数据。仅有独立 DSH Host 并不表示 Pi 已独立：默认 Headless composition 的 Pi owner 仍属于 gateway，须先完成一次迁移。

### 独立 Pi 执行 Host

`opencraft-engine-host.service` 使用固定 payload 的 `execution/engine-host.mjs`，独立于 execution-current；它拥有 Pi 的原生会话、工具子进程和计划执行，并经原 descriptor 连接既有 DSH Host。这样无需为迁移 Pi 更新或重启 DSH 宿主。网站、gateway、DSH Host、Pi 执行 Host、Codex core 分属独立 unit/cgroup；彼此不得配置停止传播关系。服务配置 `OPENCRAFT_ENGINE_HOST_CONFIG` 指向 owned、0600 JSON：

```json
{
  "descriptorPath": "/run/opencraft-engine-host/descriptor.json",
  "dataDirectory": "/var/lib/opencraft",
  "runtimeDirectory": "/srv/opencraft",
  "dshDescriptorPath": "/run/opencraft-dsh-host/descriptor.json",
  "engines": ["dsh", "pi"],
  "defaultEngine": "dsh"
}
```

`dataDirectory` 必须等于 Headless 的原数据根，保持 `machine-id`、`models/` 和 `pi/` 原位置；不得复制一份可写历史。私有 descriptor 验证机器、目录、引擎选择和实时 owner PID。网关环境设置 `OPENCRAFT_ENGINE_HOST_DESCRIPTOR`；固定更新入口另外设置相同 descriptor 和 `OPENCRAFT_ENGINE_HOST_UNIT=opencraft-engine-host.service`。配置独立 owner 后，连接失败直接报告不可用，不回退创建本地 Pi。健康响应的 `engineHost.pid` 与该 unit 的 MainPID 一致，日常更新前后保持；候选与回退包须声明 `independentEngineHost: 1`。启动入口自身需包含这份检查，旧 bootstrap 不会被网站 worker 自动替换。

首次迁移属于一次执行归属交接：先安装包含独立 Host 的版本，再在 Pi 的活动 Turn、原生工具、待恢复输入和未决交互自然清空时停旧 gateway，启动固定 Pi Host，配置 gateway 与固定入口后重启 gateway；全过程保持 DSH Host 和 Core。不得在旧 gateway 仍持有 Pi writer 时启动新 owner。新 composition 以同一 `pi-owner` 锁阻止意外双开，旧版没有该锁，仍必须确认其退出。迁移前保存配置和在线一致备份；验证失败时先停止新 Pi owner，再恢复原 gateway 配置，不能双开或用旧快照覆盖新写入。

此处承诺 owner 保持运行时的更新连续性。Pi/DSH 宿主自身更新、宿主崩溃和 Core/CLI 升级仍是独立维护事项。浏览器平台工具的访问租约仍按断线撤销，未确认的外部副作用不得自动重放；不能用网站重连冒充外部工具本身已执行成功。

验证入口：

```sh
npm run test:server-updates
# Local synthetic DSH/Pi models, native bash, managed Web install/rollback and entry/gateway replacement
npm run smoke:engine-update-continuity
# With a previously built Headless SPA, validate real systemd cgroups and browser recovery
CONTINUITY_SYSTEMD=1 CONTINUITY_BROWSER=1 CONTINUITY_SECONDS=30 \
  CONTINUITY_WEB_ROOT="$PWD/apps/workbench-web/dist" npm run smoke:engine-update-continuity
npm run build:web:release
npm run smoke:server-updates
# 具备 systemd 运维权限时，使用临时独立 unit 验证真实重启边界
npm run smoke:server-updates:systemd
```

`test:server-updates` 通过 `tsx` 加载真实 TypeScript headless composition 依赖，覆盖安装/回退、执行启动失败、持久化失败、网站启动失败、进程中断恢复及 systemd 生命周期配置。独立 DSH 兼容边界测试仍构建完整 execution 归档，仅查询指定 service 成员以限制子进程输出；其三分钟预算覆盖完整打包，不削弱指针、服务身份或拒绝旧包的断言。smoke 使用隔离 HOME、合成账户和本地 Responses 端点，运行真实 Codex CLI、归档内 gateway/daemon、生产 SPA 和真实 npm；浏览器点安装时 shell 已在运行，断线后原 turn 完成，shell 开始/结束各一次、core/CLI/运行中子进程 PID 不变，再从页面回退。默认 smoke 的 systemd 边界由隔离进程重启替代；`:systemd` 入口在 `/run/systemd/system` 创建随机命名的临时 core/执行 unit，通过实际 `systemctl restart` 验证同一链路并在结束时删除自己的 unit。两种入口都不修改线上 unit、不使用真实账户或付费推理；生产服务器仍需核对权限与首次迁移。普通安装场景由隔离夹具保持原生 shell 至进程身份检查后才释放，避免固定 sleep 自然结束造成 PID 误判；合成 Responses 端点按请求声明解码 zstd，并拒绝不含 JSON 的探测请求。

## 本地源码与 npm 复用更新事务

`npm run update:server:local -- --version <exact-version>` 在当前 checkout 构建新的归档，然后经回环地址、既有管理密钥调用 `/install-local`。本地源只负责读取/复制归档并验证 SHA512；安装、解包、网站/执行切换、健康检查、回退与恢复均复用 npm 更新的同一事务。使用方式见 [统一源码入口](web-local-deployment.md#受管部署的统一源码升级入口)。后台任务返回唯一 jobId，命令只等待自己的任务，不把其他并发操作当成成功。

`npm run smoke:server-self-upgrade` 使用真实临时 systemd unit 和 Codex CLI，在 Codex 的 shell 工具内构建并执行上述命令，再重连原 turn、验证完成并从页面回退。模型与账户仍为本地合成边界，不访问真实模型服务。

## 网页操作

公共 npm 包是通用构建。网站服务在 HTML 中注入部署配置，首屏创建 Host 前已可用：`OPENCRAFT_APPSERVER_URL` 对应 `local` / 受管站点，`OPENCRAFT_CODEX_APPSERVER_URL` 对应 `local-codex` / 受管站点，kind 均为 `remote-control`，使用同源 `/appserver`、`/codex-appserver`。配置至少一个上述 Host 时激活内置 Agent 设置页；无需部署用的 `VITE_*` 构建变量，网站更新后仍沿用服务自己的执行配置及稳定 hostId。

`OPENCRAFT_HYPERNODE_USER` 只传给执行端请求头，不决定 Host 身份。网站配置统一使用主端点 `local` 并关闭 HyperNode 插件，避免为同一地址创建第二个 Host。构建期 `VITE_APPSERVER_HOSTS_JSON` 是开发/测试的显式覆盖，优先于运行时列表；`VITE_WEB_BUILTIN_AGENTS` 和 `VITE_HYPERNODE_PLUGIN` 的 `enabled|disabled` 值可覆盖插件激活。无 HTML 配置的 Vite/static 部署保持原默认行为；注入配置损坏时启动报错并可重新加载，不静默回落。下游产品不包含这两个插件，Electron 不消费网站配置。旧通用包的 `hypernode` 链接与浏览器历史在 Router 入口映射为 `local`，保留 threadId/draftId；旧活动会话和项目选择按缺失补入 `local`，保留旧值、不覆盖已有 `local` 偏好。这仅用于网站提供配置、没有显式 Host 覆盖且没有真实 `hypernode` profile 的 OpenCraft Web。

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

正式发布workflow为 `.github/workflows/release.yml`。在main合入提升 `packaging/web-server/package.json` 稳定版本并提交精确 `## vX.Y.Z` changelog后自动请求发布；版本未变不发布，降级、预发布号与缺失发布记录拒绝。来源清单的 `--release` 检查通过后才创建指向该main事件提交的新tag；已有同名tag只能精确指向原提交，禁止覆盖。仍可从main手动派发已有稳定tag以恢复既有发布。来源清单检查与产品隔离均已具备；首次 npm 发布按既定决定暂缓，因此实现已就绪但不等于已经在 GitHub 或 npm 真实发布。

包模板版本必须与tag相同；tag必须位于main历史中。预检再次核对tag内来源清单、安装锁定依赖、执行相关测试和浏览器回归，然后构建一个execution tgz、核对公开包内容并生成SHA256 manifest。发布job只下载并发布这份归档，不重建；npm版本已存在时只接受字节完全一致的归档。最后核对npm下载/安装及GitHub Release归档、manifest和release notes。全发布workflow串行，`npm-release` Environment仍只允许main。已上传后若最终校验失败，用 `gh run rerun <run-id> --failed` 复用原归档，核对远端字节后继续，不重建或重复上传。操作技能见 [opencraft-release](../.agents/skills/opencraft-release/SKILL.md)，迁移边界见[上游迁移](upstream-transition.md)。

正式发布预检还执行 `npm run gate:performance`，在打包前比较版本化基线并保留30天原始样本、JSON/Markdown报告及失败截图；回退或证据不完整阻断后续发布。该完整套件不接日常服务器更新/普通PR流水线，开发可独立执行；场景、阈值及校准流程见 [performance regression gate](startup-performance.md#formal-release-performance-regression-gate)。

预检按 `package-lock.json` 缓存 npm 下载内容，仍执行 `npm ci`；按操作系统、架构与锁定的 Playwright 版本缓存浏览器，每次仍安装所需系统依赖。依赖安装、类型检查、翻译检查、各组测试、浏览器安装、打包、上传和发布后验证分别记录 Actions step 时间。浏览器回归使用 2 个 worker，各自拥有独立 registry、状态目录和动态端口。依赖审计由 security workflow 执行，不重复放在 release 的依赖安装中。

npm 上传返回成功后，公开 metadata 可能延迟出现。整包 metadata 可能受 CDN 缓存影响；发布烟测显式使用 `--metadata-source version-api` 查询公共精确版本接口 `/包名/版本`，验证返回的包名和版本，并记录缓存状态、等待及安装耗时。该模式不发送 npm 凭据；需要认证或没有此接口的 registry 继续使用默认 npm CLI 查询。精确接口的 HTTP 404 最多重试 30 次、间隔 10 秒，然后仍在独立临时目录运行 `npm install 包名@版本 --prefer-online`。安装 CLI 自身仍可能读取受缓存影响的整包 metadata；仅对明确的 `ETARGET` 且错误指向本次精确版本进行同样的有界重试，认证、网络、其他包缺失、错误版本和其他安装错误立即失败。用新 workflow 复核旧 tag 时，若 tag 内的 kit 尚未提供此参数，则使用原 npm CLI 查询。已存在版本的烟测不能证明新版本上传后的同步耗时，需在下一次真实发布中观察。

Trusted Publisher 的配置：GitHub Actions；组织 `opencraft-app`；仓库 `opencraft`；workflow filename `release.yml`；Environment `npm-release`。该 Environment 只允许 main。workflow 使用 OIDC，不存放长期 npm token。仓库已公开（`opencraft-app/opencraft`），发布 workflow 不额外声明 npm provenance；第三方版权与许可声明保留在仓库及归档内，不在 npm 侧另行宣称权利核实。首次真实发布需先以 npm 账号有效凭据上传本机验证过的归档，包存在后才能在 npm Settings 添加 Trusted Publisher；配置后按 npm 当前有效期要求及时通过 Actions 成功发布。

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

稳定入口的安装和回退共用 execution profile 解释：带完整 v1 执行元数据（protocolVersion、platform、arch、nodeAbi）且包含非空 gateway、daemon、DSH capability payload 的旧包，未声明 profile 且没有 Headless 网站或独立 DSH Host 标识时按历史 daemon 契约识别。没有 execution 元数据的纯网站包仍是独立网站；显式未知或无效 profile 不按 daemon 回退。网站独立更新只核验发行 profile，不额外要求执行平台/ABI 与网站主机一致；显式启用受管执行后，原有平台/ABI、原生 payload、活动任务、数据和切换检查继续由执行部署负责。真正不同 profile 的迁移仍须单独安排。本兼容逻辑属于固定启动器，网站热更新不会替换已安装的旧启动器；已有入口须经后续修复版的入口维护才能生效。

默认更新范围是包内网站 worker 与 Web 代理；显式受管服务器模式还包含上文执行端 payload。稳定入口/更新器本身不在此次热更新范围；新包必须使用 worker protocol 1，不兼容版本拒绝安装。入口维护升级需要单独安排服务重启；执行进程仍独立，但入口连接会重连。配置独立 owner 时，Codex、DSH 与 Pi 的执行连续性分别依赖 Codex core、DSH Host 与 Pi 执行 Host；固定入口重启不关闭这些 owner。Codex 显式拆分后账号 Core 可独立排空代理请求并重启，APP Server/CLI PID 保持，见 [三步升级与边界](codex-core.md#执行侧平滑升级三步方案)。未拆分 Core 仍会连带停止 native。执行宿主自身升级仍须自然排空。Codex 显式多代模式由独立 routing owner 原子切换新 Thread 默认代，旧会话固定原 HOME，旧 CLI 无任务/工具/Host 工作后自然退休；账号 Core 继续共享，见同页第 3 步。默认 combined/单 APP 部署仍兼容，不因 Web CI 自动改变拓扑。

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

## 旧 Headless 单体的首次迁移前提

Headless 包可以在同一个进程/cgroup 内承载静态网站、本地 DSH、内嵌 Codex、
SSH management、员工身份和语音入口；它不是上文受管 gateway 的等价启动方式。
通用受管网站注入的 `local` / `local-codex` 也不能自动代替旧 Headless 的稳定 Host
及其 `/apphost`、`/ssh-apphost` 和功能私有 HTTP 路由。首次迁移前逐项核对身份、
项目 cwd、服务端能力、原有路由与各数据 owner；只验证 `/health` 不能证明这些功能保留。

内嵌 Codex 的首次独立 core 迁移必须等待真实活动 turn、工具与队列自然清空，或由
操作者安排维护窗口。持久 `unknown` 表示提交结果尚未确认，不能据此判断任务已死、
删除记录或自动重放；恢复由原 owner 按历史中的 client message 身份核对。
独立 core 的原生连续性不包含下游的队列、verified sender、企业身份、Tasks 和其他
Host overlay；需要保留这些能力时，先完成相应 adapter 接入，不能借部署改变默认执行选择。

目标库包含当前 owner 不识别的旧表时，先找原建表与读写来源，再设计有界的 owner
兼容及业务功能验证。保留附加表或创建备份并不能证明原功能仍可用，不应放宽未知
结构拒绝，也不能移开后用空库替代。发现目标 preview 来自未提交或后续补丁时，将
它与指定构建来源分别记录；未经确认不能把该 preview 当作已接收源码构建输入。

完整保留下游 overlay 的受管 Headless 边界、历史数据保留和 writer 回归见
[受管 Headless 与独立 core](managed-headless.md)。纯 core bridge 不能替代该模式。
# Optional ordinary relay

The managed package includes independent inactive relay/admin executables and an
optional relay ingress/private loopback listener. Configuration, trust boundaries,
member bootstrap and preservation of updater/execution ownership are described in
[ordinary relay deployment](relay-deployment.md). Enabling the stable launcher's
new ingress settings requires restarting that launcher from the fixed aggregate
artifact; a static-worker upgrade alone does not replace it.

### Execution health observation

Managed Headless health observes independent Core and DSH concurrently, each with
a five-second dependency budget. A failed dependency returns HTTP 503 while
retaining the gateway release identity and safe dependency states. The updater
uses a 6.5-second observation budget, shares concurrent reads without caching old
success, and rechecks the execution pointer after the response. Readiness requires
healthy dependencies, the expected profile and exact release identity.

The optional execution.observation records sampledAt, durationMs and a safe reason:
ready, pointer-unavailable, health-invalid, dependency-unavailable, health-http-error,
release-mismatch, health-timeout or health-unreachable. This distinguishes an
unobserved identity from a running release whose dependencies are unavailable.
Errors never include private endpoints, tokens or raw exception text. A fixed
bootstrap must be upgraded through the local entry-maintenance contract for new
updater observation logic to become active; updating Web assets alone is insufficient.

### Managed Linux browser continuity

The root-managed Linux remote browser uses a separate DynamicUser owner, private
Unix transport and immutable runtime retained under its data directory. Gateway
upgrade/restart reconnects viewing clients while the same native tabs retain DOM,
forms and scroll. Handoff revokes old input and suspends unviewed encoding. This
is independent of the existing execution/core upgrade transaction; deployment
must not stop the owner with the Gateway or delete its retained runtime. Direct
unmanaged adapters, host reboot and actual native owner failure still recover
from checkpoints. The first migration from the previous pipe-owned browser needs
one replacement; subsequent compatible Gateway deployments preserve it. Owner
protocol mismatch fails closed instead of silently killing active tabs.

### Headless admission and fixed entrypoints

The managed supervisor forwards all Headless API paths directly to their owner. Document admission uses a bodyless GET and removes incoming body framing and hop-by-hop headers. A relay assertion is single use: probing admission and then forwarding the same authenticated API request is invalid. Verify the running supervisor artifact separately from its managed Web release; changing the latter does not upgrade the former. Deployment checks must exercise the protected internal entry and backend, not only direct backend requests.

A verified worker readiness message also carries its bounded Headless route table. The supervisor uses that active release's table for HTTP and upgrades, so subsequent API additions follow managed upgrades without leaving an older bootstrap routing them through document admission. Legacy workers omit the table and keep the supervisor's bundled routes. Invalid advertised tables fail candidate readiness; static and updater handling remain with Web.

### Running execution files during Web updates

An unchanged Headless gateway can outlive multiple Web release pointers. Its
health reports `runtimeReleaseRoot` from the immutable startup location, while
version and build identity follow the current pointer. Release cleanup retains
that runtime root and the selected release; only a successful gateway restart
retires its old file lifetime. Missing or unrecognized runtime identity retains
all uncertain pins. Browser executables and lazily read runtime files must remain
available while their owning gateway is alive.


### Browser-only payload changes

The execution digest includes runtime/browser scripts, assets and nested Electron
files as well as execution/. Browser-only patches therefore replace the Gateway
through the managed transaction, while identical payloads still allow Web-only
updates without a restart. Native files are streamed into the digest during updates
and owner attachment; they are not buffered as whole binaries or hashed per frame.
The persistent owner uses the same complete browser identity. Live tabs keep their
immutable owner and mark it stale; once all pages close an empty stale owner can
be replaced, including when only the Electron binary or native resources changed.


Headless startup reconciliation and update status validate the actual
`runtimeReleaseRoot` as well as the selected version/build identity. Different
roots are compatible only when their complete normalized execution and browser
payload hashes match. An interrupted rollback whose pointer changed but process
restart failed therefore remains not ready until a correct runtime is started.
Missing runtime identity is not proof of recovery. Immutable root comparisons
are shared in memory; filesystem failures are retried, and uncertain runtime
pins remain retained. Daemon health without a Headless pointer-derived identity
keeps its legacy compatibility contract.


The npm release source bounds metadata output separately from package inventories.
`npm pack --json` includes every shipped file, so a complete Headless package can
exceed the metadata response budget. Its bounded command output allowance does
not change archive size, SHA integrity, extraction or execution-profile checks.

## Signed full-release bridge

A distribution may opt into the full-release bridge through its packaging
composition. The fixed bootstrap embeds its own trust roots; keys contained in
an incoming package never establish trust. Public distribution defaults remain
independent of downstream signing policy.

The formal contracts are `packaging/full-release/manifest-v1.schema.json` and
`preflight-v1.schema.json`. `scripts/full-release/contract.mjs` adds semantic
checks: duplicate JSON keys, safe integer bounds, exact source identities,
UTF-8 sorted file tuples, canonical POSIX paths and modes, disjoint component
roots, dependency identities and hard resource ceilings. Signatures authenticate
original UTF-8 manifest bytes using Ed25519. Only `release/full-release.json` and
`release/full-release.sig` are excluded from the signed payload inventory.
Before each pack, the producer normalizes its owned public staging tree to `0644` for ordinary files and `0755`
for directories and executables before each pack, including files generated by
the signer under a restrictive umask. It never follows staging symlinks or changes
the signing key outside that tree, and rejects hard links before changing their
modes. The archive verifier still rejects other modes. Synthetic retained-payload and
malformed-archive tests explicitly establish their intended file and executable
modes after creation so a restrictive test-runner umask cannot mask the rejection
being exercised; mode tampering remains a rejected retained-payload change.
Archive rejection stops input immediately and aborts the parser after the current
decompression callback returns, preserving the original policy failure without
reentrant decompressor destruction.
The signer first observes npm's actual archive, then signs its complete inventory,
durably binds the release identity to that manifest digest before signing,
repackages once, and independently scans the final tgz to verify the two release
files, every payload byte/mode and the declared limits. Private signing keys are
never placed in the staging tree. The single signing owner also persists the final
archive SHA512 outside the package. A changed build must use a new identity;
publication retries reuse the original retained archive. Preliminary packs never
overwrite it.

`package.json.opencraftFullRelease` is a small signed preflight envelope retrievable
with npm metadata before downloading a large archive. It binds product/channel,
exact npm version, source, release sequence, expiry, revocation watermark,
platform/ABI, required bootstrap/helper protocols and budgets. It intentionally
does not contain its own archive or manifest digest, which would create a cycle:
package.json is itself part of the signed payload. After download, the manifest
signature and identical preflight fields establish the final binding. A changed
channel cannot replace an already selected exact version/integrity.

The authenticated sequence and manifest digest persist in `full-release-state.json`
under the existing deployment writer lock. Same-byte retries are accepted; lower
sequences, same-sequence different content, expired/revoked releases, stale
revocation watermarks and unsupported bootstrap/platform combinations fail before
activation. First installation and fixed-bootstrap maintenance authenticate the
installed signed payload and initialize the same watermark before starting workers.
The committed `current` pointer carries its authenticated manifest digest and
release identity. That authorization survives replacement or failure of later jobs.
Authenticated staging may advance the high-water mark without activating a payload;
the last committed current remains restartable, and unsigned/lower replay is still
rejected for new installations. Pointer commits are durable before accepting jobs.
Administrator rollback verifies the retained manifest/signature and every
original payload file, persists an explicit target-digest intent and keeps the high-water
mark; it checks the target against current authenticated revocations, rather than
requiring an old target manifest to contain newer revocation data. Rollback never
restores an old database snapshot or lowers either watermark. Explicit and implicit
archive directories install as 0755 and every extracted entry belongs to the
deployment user/group, independently of archive uid/gid or process umask.

Bridge archives remain within 512 MiB compressed, 2 GiB expanded and 20,000 outer
entries. An old bootstrap must first receive the official bridge maintenance;
replacing only a Web worker does not upgrade the fixed bootstrap. The current
bridge establishes trusted distribution and bounded verification. It does not
implement a persistent multi-owner coordinator, owner admission fences or claim
that every running backend component has switched versions. Those capabilities
require separate owner/transaction contracts.

A complete signed release (`updater.bridge: false`) also carries `full/core/`
(the account Core, APP server and generation router bundles), `full/codex/`
(the exact locked CLI with its platform vendor) and `full/dsh/` (the separately
locked engine). Pi, MCP, ACP Hosts, broker and native payloads remain in their
existing runtime locations. These are immutable payloads; independent owners
still need an authorized compatible activation plan.

The builder resolves dependencies within each locked installation, preserves
conflicting nested versions and optional native dependencies, materializes
package-local links and rejects escaping links/cycles. Code files install as
0644/0755 without sharing source inodes. `release/locks/` and signed provenance
record the workspace/runtime locks, registry integrities and bundled Core
licenses. Each component has a complete file inventory and a bounded layer;
the final staged npm dry-run must match the actual signed archive. The scanner
also bounds expanded tar headers, padding and trailing data.

For a complete payload dry-run without issuing or installing a release, use
`OPENCRAFT_PACKAGE_FULL_RELEASE=1 OPENCRAFT_PACKAGE_DRY_RUN=1` with the normal
Headless packaging entry and a separate output directory. It hashes the final
npm-selected files and reports component inventories, sizes, entries and SRI.
The transport's promotion policy controls when complete payloads enter a channel.

Installed plugins are local persistent state, including trusted local plugins and
ordinary custom plugins. The updater-owned persistent plugin directory survives
code upgrades and rollback with its installed contents, enabled state and
configuration. Release installation and rollback must not replace or delete that
state. Immutable signed payload files keep their authenticated identity; local
plugins load from their persistent state directory. This is a shared ownership
contract for all deployments.

## Operator-installed Web plugins

Managed deployments keep operator-installed trusted Web plugins in
`<stateDirectory>/user-plugins/`, outside both `releases/` and `staging/`.
Application install, rollback, worker recovery and service restart only change the
application release; they do not replace this directory. Browser module-URL
installations keep their existing client installation/artifact stores and public
API restrictions.

`plugins.json` has `schemaVersion: 1` and a `plugins` array. Each descriptor has
an extension `manifest`, `entry: "<extension-id>/plugin.mjs"`, the module's hex
`sha256`, and an explicit `replaces` array of bundled extension IDs. Files under
`public/<extension-id>/` are served at `/__opencraft_plugins/<extension-id>/`
through the normal deployment admission. Modules must be self-contained ESM
exporting a default trusted extension definition. Only the deployment operator
can install these modules: browser URL installations cannot acquire internal
capabilities by claiming this descriptor or trust level. The normal extension
manager owns activation, enable/disable state and plugin storage; replacing a
bundled default does not delete its stored installation or data.

An optional `branding` object carries initial HTML `name`, `faviconUrl`,
`markUrl` and `appleTouchIconUrl`; asset URLs must stay within the plugin's own
public prefix. The extension itself registers its branding through the existing
trusted contribution channel so the application header and document lifecycle
share the same owner. Install plugin files first, atomically replace the index
last, then reactivate the Web worker. Serialize installation with the operator's
normal deployment lock. Do not edit signed release files or use systemd mounts
over version directories.

Plugin-enabled deployments require `opencraftWeb.userPlugins: 1` in each
application release. Activation of an older incompatible release fails explicitly
and preserves the installed plugins and current release. Upgrade the fixed
launcher before enabling plugins so rollback uses the same compatibility gate;
legacy launchers do not implement this contract. Rollback among compatible
releases preserves plugins. Removing a plugin is a separate operator action;
application rollback never uninstalls it.

Signed npm consumers bind the archive URL to the checked exact version and SRI.
They use the existing deployment user's npm configuration for an HTTPS stream,
reject redirects, count compressed bytes against the signed limit while reading,
and verify SRI before scanning tar contents. They never pass untrusted signed
archives through `npm pack` and its eager buffering/content inventory. The same
stream port accepts an exact receipt size for publication verification. Historical
unsigned sources keep their existing npm compatibility path. Fixed launchers must
receive this implementation before their first complete-package npm download;
maintaining only the application worker does not replace the launcher's updater.

The npm transport also accepts a streamed request body for registry operations.
Request URLs remain bound to the configured registry; authentication comes from
the npm toolchain, redirects remain disabled, and caller headers cannot replace
the configured credentials. Producers can encode large publication attachments
in bounded chunks instead of allocating one archive-sized Base64 string.

## 受管维护与回退完成钩子

部署可以设置 `OPENCRAFT_RECOVERY_MAINTENANCE_MARKER` 为私有维护标记的绝对路径。
更新器在开始安装前同步检查标记，标记存在时拒绝新安装/完整升级；读取状态与已有业务连接
仍可使用。维护控制器先独占创建标记，再读取状态确认没有进行中的更新。
已认证回退可以携带 `x-opencraft-recovery-id`，其值必须等于标记内容；该能力仅用于持有
本次维护标识的部署控制器，不能绕过管理员认证、已有更新事务或兼容性检查。

`OPENCRAFT_ROLLBACK_RECOVERY_COMMAND` 是非空参数字符串数组的JSON，用于配置部署拥有的
回退完成检查，例如重建独立路由进程并发起新连接握手。更新器先应用兼容执行版本，执行
钩子成功后才提交Web指针；钩子失败沿既有事务恢复当前执行版本，不宣称回退成功。
命令直接执行、没有shell，120秒超时，输出不进入公开API。钩子运行在现有更新事务内，
不得重新取得外层部署锁或向同一更新器发起新事务。状态中的 `recovery.maintenanceMarker`
与 `recovery.rollbackHook` 只声明配置是否存在，不代表本次恢复或外部服务已验证。

完整签名包的sealer直接读取当前npm自带的Arborist/npm-packlist清单并计算文件摘要，写入
签名后只压缩一次。inspection/dry-run和交付使用同一最终归档，仍执行签名、文件列表、
权限与预算的完整验证；不能将暂存文件清单当作归档已通过的证据。
