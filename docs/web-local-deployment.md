# 从源码打包并替换服务器上的 Web

用于已有 OpenCraft managed Web 服务的服务器：在本机从源码构建、替换网站，保持原 DSH/Codex 执行服务运行。以后在本项目说“打包替换本地 Web”，Agent 按本页执行；本机地址、服务配置、版本和历史证据先查 Git 忽略的 `.local/README.md`。这条路径直接使用本地包，不上传 npm。

当前模式由稳定入口启动版本化网站 worker，`deployment.json` 的 `current.releaseRoot` 决定实际网站。替换时应更新这个指针及固定启动包；`apps/workbench-web/dist` 是构建输出，不是当前服务的运行目录。首次安装及 npm 更新另见 [Web 部署](web-deployment.md)。

## 受管部署的统一源码升级入口

已升级到当前受管启动器的部署优先使用同一入口，开发者和具有部署权限的 Agent 均可调用：

```sh
OPENCRAFT_WEB_STATE=/var/lib/opencraft-web \
OPENCRAFT_WEB_UPDATE_URL=http://127.0.0.1:10000 \
npm run update:server:local -- --version 0.1.10
```

版本只是示例，必须选择比当前版本新的精确版本。该命令在当前 checkout 构建到新的 `.local/server-releases/` 目录，保留旧版本；记录来源 commit/dirty，依据服务器声明决定是否打包 execution payload。可用 `OPENCRAFT_WEB_PACKAGE_OUTPUT` 指定独立输出位置。需要复用已验证归档时，传 `--archive /absolute/release.tgz --build-id exact-build-id`，并保留 `--version`。

命令从指定网站状态目录读取既有 admin-key，经回环 HTTP 授权后，把本机归档路径、精确身份和 SHA512 交给 `/install-local`。设置了公开 Origin 的部署同时传入原 `OPENCRAFT_PUBLIC_ORIGIN`；归档必须对网站部署用户可读。命令不上传 npm。它与 npm 更新共用下载后的验证、切换、健康检查、持久化、失败回退和中断恢复；不能并发改写部署状态。更新仍由稳定入口完成，shell/页面断开不触发任务重发。

配置受管 execution unit 时，仅切换网站、gateway、daemon 与 capability adapter；独立 core/CLI、账户数据和 DSH 引擎保持运行。网关连接会断开并由页面重连；任务连续性限于独立 core 中的 Codex。没有接入受管执行端的部署只更新网站。命令输出已安装版本、buildId、执行健康状态与归档位置，失败返回非零；超时不自动重发安装。

首次接入仍需按 [服务器执行更新](web-deployment.md#服务器执行端更新) 迁移固定启动器和 unit。旧启动器没有 `/install-local`，不能用源码热升级命令升级启动器自己；下面手工替换步骤只用于首次迁移/入口维护，常规更新不要另行写 `deployment.json`。

`npm run smoke:server-self-upgrade` 在临时 systemd unit、隔离账户与本地合成模型下运行真实 Codex CLI：其 `exec_command` 调用同一源码构建/升级命令，包内 gateway/daemon 重启后原 turn 完成、shell 执行一次、core/CLI PID 不变，再由页面回退。测试结束清理自己的 unit/profile；不代表目标服务器已经迁移或 Electron 可跨 App 重启保持任务。

发布前可用 `npm run gate:server-updates` 统一回归，也可用 `--scenario self-upgrade` 只选源码自升级。该入口复用上述验收脚本并生成每次独立的报告；环境要求和退出码见 [可选发布前门禁](web-deployment.md#可选发布前回归门禁)。

## 1. 核对当前部署

在当前 checkout 中检查分支、未提交内容、已有进程。下面服务名和端口是该本地部署模式的示例，以 `.local/README.md` 和实时服务为准：

```sh
git branch --show-current
git status --short
git worktree list
systemctl show opencraft-web.service --property=ActiveState,MainPID,ExecStart
curl --fail --silent --show-error http://127.0.0.1:10000/__opencraft_health
curl --fail --silent --show-error http://127.0.0.1:10000/__opencraft_updates
```

确定网站的状态目录、当前/上一版 release、固定 bootstrap、systemd drop-in、原 Node 路径与执行 WebSocket 地址。记录执行侧 PID/启动时间。网站正在检查或安装更新时，先等该任务结束，再准备替换。

## 2. 构建本地包

使用 `.nvmrc` 对应 Node 和当前 checkout 的依赖。选择本地精确包版本，设置 `OPENCRAFT_RELEASE_VERSION`；核对当前版本与公共渠道，避免未来正式版本号低于本机版本。源码未提交时保留 dirty 标记。

网站服务在每次 HTML 响应中注入 Host 列表与内置扩展开关。`OPENCRAFT_APPSERVER_URL` 提供 `local`（受管站点），`OPENCRAFT_CODEX_APPSERVER_URL` 提供 `local-codex`（受管站点），两者使用同源代理路径；浏览器中已有的 Host 关联保持不变。通用包和公共 npm 包均不需要部署用的 `VITE_*` 构建变量。设置执行地址仍是网站服务的运行时配置，不在页面上填写。

`OPENCRAFT_HYPERNODE_USER` 只作为代理请求头发送，不注入网页，不决定 Host 身份。网站的主端点统一使用 `local`，运行时配置关闭 HyperNode 插件以避免重复 Host。内置 Agent 设置页在存在 `local` 或 `local-codex` 时激活，不包含执行引擎。

`VITE_APPSERVER_HOSTS_JSON` 保留为开发/测试的显式覆盖，优先于网站注入配置；`VITE_WEB_BUILTIN_AGENTS=enabled|disabled` 与 `VITE_HYPERNODE_PLUGIN=enabled|disabled` 也可显式覆盖激活选择。没有注入配置的 Vite/static 部署沿用原默认行为（内置 Agent 未启用，HyperNode 启用）。下游产品构建不包含这两个插件；Electron 的 Host 来源不变。

```sh
set -e
: "${OPENCRAFT_RELEASE_VERSION:?设置本地包的精确版本}"
export OPENCRAFT_SOURCE_REVISION="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  export OPENCRAFT_SOURCE_REVISION="$OPENCRAFT_SOURCE_REVISION-dirty"
fi
export OPENCRAFT_WEB_PACKAGE_OUTPUT="$PWD/.local/local-web/$(date +%Y%m%d-%H%M%S)"
npm run typecheck --workspace @opencraft/workbench-web
npm run test:web-release
npm run test:web-updates
npm run test:web-updates:e2e
npm run package:web:server
```

打包输出最后的 JSON 给出 `packageRoot`、`archive`、版本、buildId 和 integrity。记录 tgz 的 SHA256；保留旧包，不复用一个已有版本的目录覆盖文件。最终打包会再构建一次，以最终输出为准。

先用最终自包含包在独立状态目录、空闲端口启动探针，沿用原执行地址（下列地址为示例）：

```sh
probe_state="$(mktemp -d /tmp/opencraft-web-probe-XXXXXX)"
OPENCRAFT_WEB_STATE="$probe_state" OPENCRAFT_WEB_PORT=10001 \
OPENCRAFT_APPSERVER_URL=ws://127.0.0.1:9989/rpc \
OPENCRAFT_CODEX_APPSERVER_URL=ws://127.0.0.1:9988/rpc/codex \
node "$OPENCRAFT_WEB_PACKAGE_OUTPUT/package/runtime/cli.mjs"
```

验证 `/__opencraft_health`、`/version.json` 与包内 buildId，并检查 HTML 中的 `opencraft-deployment-config`。真实浏览器确认两个 Host、模型菜单两组及「模型服务」「Codex 账户」设置；不要发送任务。完成后关闭自有探针并删除临时状态。具体 npm 发布验收见 [发布流程](web-deployment.md#公共-npm-发布流程)，本地替换复用其中相关测试，不执行上传。

## 3. 仅替换网站服务

Agent 根据第 1 步发现的实际路径完成以下步骤，保存本次可回退快照：

1. 备份 `deployment.json` 和网站 service/drop-in，并保存旧包位置。将新包复制到新的固定 bootstrap 和状态目录下新的可写 release 目录；旧网站的 `web/assets` 补入新目录，只复制缺少的文件，保留旧页面可能延迟加载的 chunks。
2. 仅停止网站 unit（示例为 `opencraft-web.service`）。停止后再次核对状态文件与准备时一致；若期间被其他更新改写，保留实际指针并恢复服务，重新核对后再继续。
3. 原子写入新状态：`schemaVersion: 1`，`current` 使用新 release 的 `{ releaseRoot, version, buildId }`，`previous` 使用本次替换前的 current，`job: null`。保留其他私有状态文件及 `admin-key`。
4. 将网站 unit 的 `ExecStart` 改为新 bootstrap 的 `runtime/cli.mjs`，保留原 Node、状态目录、执行端点、npm 配置、认证和监听地址。执行 `systemctl daemon-reload`，启动网站 unit。
5. 有截止时间地重试健康请求，容忍启动期间连接失败。健康必须通过，且 `/version.json`、更新接口 current、HTML meta 的 buildId 都等于最终包；仅 `systemctl start` 返回不代表就绪。

网站入口维护会使浏览器 WebSocket 重连；原执行服务、Daemon 和 DSH/Codex 进程保持运行。保持原执行侧 unit 和 Nginx，不把它们加入网站重启操作。当前部署不支持通过本地 tgz 的 HTTP 上传热安装；不要把编辑磁盘指针但未重新加载进程当成已生效。

## 4. 验证与回退

刷新真实浏览器，确认首页、设置页、执行服务连接及此次修改可用；核对页面实际加载的 buildId，比较执行侧 PID/启动时间。查询健康接口的示例：

```sh
curl --retry 15 --retry-connrefused --retry-delay 1 --max-time 3 \
  --fail --silent --show-error http://127.0.0.1:10000/__opencraft_health
curl --fail --silent --show-error http://127.0.0.1:10000/version.json
```

查询成功后仍需比较期望 buildId。已有“检查更新”页面可运行 `npm run test:web-updates:live`；`OPENCRAFT_WEB_EXPECTED_LATEST` 应设为公共渠道的实际版本，它不一定等于刚安装的本地版本。页面测试的环境参数见 [浏览器回归](web-deployment.md#检查结果与浏览器回归)。

替换后健康或真实页面不通过：仅停网站，恢复**本次**备份的状态指针和 unit/drop-in，daemon-reload 后启动，重试直到旧 buildId 和原执行地址就绪。保留旧资源和状态，不删除可能仍被运行/磁盘指针引用的目录。历史 `.local/` 回退脚本可能限定某个版本，不能盲目用于下一次部署。

将 commit/dirty 状态、最终包版本与 buildId、实际运行路径、健康与浏览器证据、执行进程前后状态、替换步骤及本次回退方法写入 `.local/`，更新其 README。源码、构建包和实际运行网站分别交接。本页的示例服务信息不替代实时探针。

## 5. 同时升级执行侧

daemon、协议或启动参数变化时，需要同时升级执行侧；仅网站资源变化不需要重启执行侧。实际 unit、bundle、启动文件、状态目录与备份路径以 `.local/README.md` 为准。

执行侧仍内嵌 Codex 的旧部署中，重启 unit 会停止网关、Daemon、DSH 和 Codex，活动任务可能中断。采用独立 [Codex core](codex-core.md) 后，执行 unit 重启不停止 core/CLI，Codex 原 turn 可重连恢复；OpenCraft/DSH 活动任务仍可能中断。已接入受管执行端时，使用上面的统一源码升级命令，不再手工覆盖正在运行的 bundle。升级 core/CLI 自身仍属于独立维护操作。

先备份 daemon bundle、启动文件和相关 drop-in，构建并升级执行侧，按部署要求调整启动参数，再重启执行侧。等待健康通过，并用 `runtime/machine/read` 等匹配本次变更的协议探针确认后，才替换网站。记录重启前后的任务状态、进程身份和探针结果；是否允许中断由本次部署授权决定。

执行侧失败时恢复 daemon bundle 和启动文件，删除本次新增的 drop-in（原有配置恢复备份），重载 service manager 并重启执行侧；等待健康通过，核对恢复后的启动命令与协议。若网站已替换且整体验收失败，同时按本次网站快照回退。保留两侧备份和失败证据，不删除用户状态。


## Execution 原生模块预检

包含 execution 的打包在复制完成后，用当前 Node 在隔离目录中加载包内
`execution/native/node-pty/lib/index.js` 并启动短生命周期 PTY。缺少二进制、
ABI 不匹配、共享库或 spawn helper 不可用均中止打包。受管 execution 的
`inspect` 对解包产物再执行同一检查，包括传入现成 archive 的升级；检查在
切换指针和重启服务前完成，不能只信 manifest 的 nodeAbi。

若 checkout 使用 `npm ci --ignore-scripts`，需要显式准备 node-pty 的原生构建。
在该 checkout 的 `node_modules/node-pty` 目录执行 `../.bin/node-gyp rebuild`，
确认成功后重新打包；不借用另一 worktree 的依赖，也不为修一个模块放开全部
依赖安装脚本。使用目标服务 Node 的主版本、ABI、平台与架构构建。预检失败
保留当前运行版本，既不手工覆盖 native 文件，也不绕过受管更新事务。

配置了独立 DSH Host 时，执行健康检查直接观察受保护描述文件所声明的 Host 进程，不依赖引擎客户端是否已懒连接；多引擎首次浏览前也必须报告同一 Host 身份。不可用仍报告失败，安装器仍核对升级前后的 Host/engine PID。

## Independent static documents

The admitted static host serves a directory's `index.html` before its SPA fallback.
A packaged `tools/probe/index.html` can therefore be visited at `/tools/probe`,
`/tools/probe/` or its explicit HTML path, without starting Workbench. Use absolute
asset URLs when the extensionless and trailing-slash forms share a document.
Ordinary document admission, reserved API paths, GET/HEAD and revalidation policy
remain in force; this does not add a public-authentication exception. Product
composition owns its document and build entry, not the generic gateway.


## 保留本地数据的模块资源恢复

受管 Web worker 在入口 HTML 声明 `opencraft-resource-recovery` 能力。
浏览器报告网络型模块导入失败（包括 WebKit 的跨域脚本加载拒绝）或 Vite CSS 预加载失败时，入口最多自动进行一次资源恢复；错误页的重新加载按钮也可显式重试。恢复后的 CSS 持续失败同样保留错误页，不循环导航。
恢复保留原 origin、应用路径和既有 query，仅设置同名恢复 query token，worker 将入口与预加载资源指向
`/assets/recovery-<token>/`。相对模块导入沿用此路径，worker 将其解析为原来的静态文件，
因此整个模块依赖图使用新的浏览器缓存键，无须清理 Cookie、本地数据库、会话或配置。
应用 `<base>` 和 API 地址不变，旧内容哈希路径继续可用；资源文件不复制、不改写。
恢复仍失败时保留错误页，不自动无限刷新；普通代码执行错误和存储错误不触发此自动恢复。
Vite preload 错误必须保留拒绝语义，不能因 `preventDefault` 将导入结果变为 `undefined`。
未声明此能力的静态或开发服务器继续普通重载，不假定支持恢复资源路径。

早期版本查询和错误上报读取所选服务器的 `opencraft-server-context` 作用域，不能把
入口默认服务器的版本当成另一个部署的版本。检测到新版本时也使用资源恢复 URI，
避免普通 reload 继续读取旧 HTML；同一恢复 URI 上持续失败时不再自动导航。
错误报告只记录最近同源脚本/预加载资源的去查询参数 URL、耗时、传输量及可用状态码，
不记录 Cookie、请求头或响应正文；模块加载错误本身不能证明具体网关/CORS 根因。
