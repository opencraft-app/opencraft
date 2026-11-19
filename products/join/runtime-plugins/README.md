# 实例插件：平台加载、VFS 存储、独立执行

VFS **只提供插件清单、JS 和资源字节**，不是业务工作区，也不是授权来源。
执行服务提供运行环境。当前它们可以由同一个 Hands 容器提供，也可以分别部署；
存在哪里不决定在哪执行，二者不需要共享本地目录。

```text
管理员选择索引（平台私有、摘要固定）
                  ↓
平台插件加载器 ← VFS 读取清单/JS/资源
   校验、私有版本快照、注册 Gateway 入口
                  ↓ 私有业务 IPC，鉴权与代际约束
独立插件执行器 → 原业务 worker / 数据目录
```

**Hands 的标准启动入口不加载插件、不安装插件、不管理插件生命周期。**
原 browser/terminal/files/exec-server owner 保持原样；不能把 Codex 专用 exec-server
socket 放宽成任意 Python/Node 启动接口。本批用独立通用插件执行器承载审核执行角色，
没有新增一套无权限约束的通用 shell RPC，也尚未实现 E2B 适配。

## 选择、来源与快照

平台可信目录默认 `<OPENCRAFT_DATA_DIR>/runtime-plugins`，可通过
`OPENCRAFT_RUNTIME_PLUGIN_DIRECTORY` 显式指定。其 `installed.json` 保存管理员批准的
ID、manifest SHA256、enabled 和角色配置；仍受管理员所有权/不可组写检查。
普通用户仅在插件来源目录写文件、修改该来源的同名索引或放入任意目录，不会获得后端执行权。
平台选择索引与私有缓存不得通过普通用户可写的 VFS/工作区导出；若 root Hands 的文件
或终端能力可写整个宿主 `/data`，它可以间接改写这些文件，UID/摘要检查不能防御已有
root 写权限。部署必须限制导出范围/挂载；这不是多租户安全沙箱。

```text
平台选择目录/
  installed.json
VFS 来源目录/
  packages/<id>/<manifest-sha256>/manifest.json
  packages/<id>/<manifest-sha256>/{gateway.mjs,execution.mjs,...}
平台私有缓存/
  <id>/<manifest-sha256>/...   # 严格校验后发布的本地快照，仅供加载
```

- `createVfsPluginSource` 是字节读取适配接口，不携带执行环境或进程权限。
- `createHandsPluginSource` 复用既有 `HostFileSystem` 客户端/文件 RPC，不改文件 owner。
- 标准 Join Gateway 从 Hands 文件服务读取代码，VFS 来源目录默认与选择目录同名；
  两环境路径不同时显式设置 `OPENCRAFT_RUNTIME_PLUGIN_VFS_DIRECTORY`。
- 本地 `loadRuntimePlugins` 兼容原本地包来源；标准 Gateway 显式提供 VFS 来源，
  **来源失败不会悄悄退回本地包或缓存**。
- 从可信索引取得固定摘要后再读取远端清单、完整校验每个文件，拒绝目录穿越、超预算、
  身份/Node/API 不符。只获取清单声明文件；远端相邻文件不能成为 import 依赖。
- 执行 import 的是当前 UID 私有0700目录下的版本快照，而非可变远端路径。
  快照原子发布、重复使用前再次校验；缓存损坏不会覆盖活跃版本，缓存可重建但不自动 GC。
  缓存不是授权索引，也不是可靠业务存储，不承诺掉电持久性。

清单/API1 支持 `gateway`、`execution` 角色。旧 `hands` 角色仅作显式执行器的兼容别名，
不是 Hands 启动钩子；同一包不能同时声明 `hands` 和 `execution`。新版角色配置优先，
升级旧选择时可继续读取旧 `configuration.hands`。审核包0.3输出 `execution.mjs`。

## 显式安装与运行

构建审核包（输出目录为空，固定完整源提交）：

```sh
node products/join/plugins/support-review/build.mjs /absolute/package FULL_SOURCE_COMMIT
```

管理员安装/启用仍是独立操作：

```sh
node products/join/runtime-plugins/cli.mjs install /absolute/package /absolute/selection-store \
  --configuration-file=/private/role-config-references.json --enable
node products/join/runtime-plugins/cli.mjs check /absolute/selection-store
```

安装过程保留一份本地完整制品用于严格离线 check；这不改变标准 Gateway 的 VFS 读源。
VFS 存储端可用同一工具发布不可变包，但平台**不信任或读取其 enabled 索引**。
本批没有远程扫描即自动授权、自动安装、代码热更新或普通 craft 升格后端权限。

配置引用文件0600，不把 token/SMTP/身份写入包或命令行。配置示例：

```json
{"gateway":{"configFile":"/private/gateway-review.json"},"execution":{"configFile":"/private/executor-review.json"}}
```

独立执行器由平台部署者显式启动，与核心 Hands 无父子生命周期绑定：

```sh
node products/join/runtime-plugins/executor-cli.mjs /absolute/executor-selection-store
```

它默认读自己的已批准本地包；选择 VFS 来源时配置全部三项（路径仅示意）：

```sh
OPENCRAFT_RUNTIME_PLUGIN_VFS_DIRECTORY=/absolute/vfs-plugin-store
OPENCRAFT_RUNTIME_PLUGIN_VFS_ENDPOINT=/private/files.sock
OPENCRAFT_RUNTIME_PLUGIN_VFS_TOKEN_FILE=/private/files.token
OPENCRAFT_RUNTIME_PLUGIN_CACHE_DIRECTORY=/private/executor-plugin-cache
```

两边选择同一个 manifest 摘要，但角色私有配置各自归执行 UID0600，不共享一份 root
私有 token 文件。`execution` 的运行位置由独立执行器的部署决定，VFS 来源不会创建它。

产品 Gateway bundle 提供显式工具模式（不启动 Gateway/Hands 核心 owner）：

```sh
node /opt/opencraft/runtime/container-gateway.mjs --runtime-plugin-admin check /absolute/store
node /opt/opencraft/runtime/container-gateway.mjs --runtime-plugin-executor /absolute/store
```

`products/join/build-gateway.mjs` 另输出 `runtime-plugin-admin.mjs`、
`runtime-plugin-executor.mjs` 便于独立交付；不再使用 native-hands.mjs 的安装模式。
独立部署必须核对最终镜像 Node/Python/CA、角色私有配置、必要卷及固定摘要，不能把
JS bundle 检查冒充镜像验收。不要向插件暴露核心 owner token、Docker socket 或全部宿主卷。

## 故障、安全与生命周期

- 加载失败只跳过故障插件；索引/来源不可用时跳过对应插件，不阻断主服务、不改选择。
  诊断只有已验证 ID、角色、固定错误码。启动阶段共享5秒异步等待预算。
- Gateway 使用现有 Principal/实例准入，再执行业务权限检查。请求体不能创建 Actor。
  精确路由不得占用核心/产品身份端点。角色代际不一致拒绝执行，无本地 Python 回退。
- 独立执行器不启动 browser/terminal/files/exec-server，不关闭其他服务。
  审核新版执行入口关闭时停止接新请求、等待已接受任务结束（worker 自有90秒上限），
  执行角色 cleanup 等待上限110秒，部署 stop grace 应至少120秒；不自动重发不确定邮件。
  原低层 owner 的默认强制关闭行为保留给旧调用者，只有新版执行入口启用排空。
- 不得同时启用旧内嵌审核 owner 与新独立执行器写同一业务根，不能靠不同 socket
  或已有文件锁假定双版本邮件发送安全。业务数据、锁、账本不随插件代码安装迁移。
- 可信 Node 后端包有运行角色的完整 OS 权限，**不是安全沙箱**。SHA256 是完整性而非
  作者信任。进程内 try/catch 不能隔离同步死循环、process.exit、未捕获异常或任意副作用。
  VFS 可写权限不等于管理员批准后端代码；来源审核不可省，普通前端 craft 仍是另一信任层。
- 安装互斥锁/硬杀遗留插件 socket 不自动抢占，必须确认旧 owner 退出；不动核心 owner 锁。

## 本批边界

仅剥离服务端审核适配。Vela 前端/品牌、旧 React 同构建依赖和13个 MCP Apps 并未在本批
转换；也未新增通用远程沙盒执行协议、E2B adapter 或全量插件市场。
本批不部署 `.40`、不重启服务、不更改 root Hands/浏览器降权、CLI/凭据接线、不触发真实
审核/SMTP。首次接入仍需定向更新 Gateway；不能忽略 `.40` 实际挂载覆盖的旧 Gateway bundle。
