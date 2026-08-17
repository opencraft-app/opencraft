# VelaChat 仓库协作与前端入门

本文件适用于整个仓库。Backend 的领域模型、OpenAPI、数据库与迁移规则继续以
`backend/AGENTS.md` 为准；两份约束必须同时满足。

## 先读：工作方式与禁止事项

- 先检查 Git root、当前分支和 `git status --short`。不得覆盖、回退或顺带提交别人的未完成改动。
- 不得提交 kubeconfig、SSH 私钥、Registry 凭据、腾讯云密钥、IM UserSig、邀请 token 或一次性安装材料。
- 禁止使用 Graphify，也不要在仓库内生成或提交 `graphify-out`。理解代码必须从真实入口、类型、测试和
  运行证据出发。
- Mac 不依赖 Docker daemon。需要 OCI/Linux 构建时使用经授权的 Linux builder；Mac 负责 Bun/Expo、
  TypeScript、Go/Rust 原生目标和验证编排。
- 不使用默认 kube context，不执行 `kubectl config use-context`。所有集群操作都必须显式指定目标，或在
  SSH 主机上使用该主机自己的 `k3s kubectl`。
- 旧共享前端环境已退役。禁止再向旧集群、旧 LoadBalancer 或旧静态站点发布，也不要在代码审查、文档
  和对用户的回复中引用其地址。

## Git、Worktree 与并行协作

- 主工作区存在未提交改动时，独立功能、发布准备和审查默认使用新的 Git worktree；不要等到实现结束才隔离。
- Worktree 必须从已确认的 commit/branch 创建。合入前重新 fetch，并把功能分支重放到最新已提交基线。
- `git status` 干净只证明当前 worktree 干净，不证明另一个 worktree、远端 `master` 或运行中的预览使用相同源码。
- 调试运行中页面、TUI 或 daemon 前，先把 PID/命令行映射到真实 worktree 和 commit；禁止默认归因到主目录。
- 只提交自己拥有的文件。与其他 Agent 发生文件重叠时，先等对方提交或使用独立 worktree 重放，不能 checkout、
  reset 或重写对方内容。
- 发布提交必须 fast-forward 到 `origin/master`；禁止 force-push 发布分支。推送成功后仍需重新读取远端 HEAD。

## 产品与运行时心智模型

产品对象语义：Server 管“谁一起工作”，Project 管“做什么”，Computer 管“在哪里运行”，Codex TUI
只是打开 Project 的方式。内部实现可以出现 workspace、root URI、TAT Session 等术语，但不要把它们变成
与上述对象竞争的用户产品实体。

前端不是三个独立项目：

```text
web/packages/client-core
  └─ 领域类型、OpenAPI client、MessagingPort、Composer/Conversation 契约

web/apps/client（唯一 Human UI 源码）
  ├─ Expo Router / React Native 页面
  ├─ Web：Expo 静态导出为 dist
  └─ TUI：同一 presentation/状态模型，经专用 renderer 打包为 JS bundle

agent/vela-computer
  └─ Go Computer 进程嵌入 TUI bundle，并提供本机 Runtime、TAT、IM Gateway 与终端能力
```

Web 发布不会更新已经安装的 TUI；TUI 只有进入新的 `vela-computer` 二进制并完成 Computer 升级后才会生效。

## 前端数据流

Human 客户端有两条互不冒用的 I/O 边界：

```text
Expo route / screen
  -> application store / submission coordinator
     -> PlatformPort -> PlatformApi -> Vela Backend HTTP/OpenAPI
     -> MessagingPort -> TencentMessagingPort -> Tencent Cloud Chat SDK
```

- Platform API 管 Server、Member、Agent、Computer、Task、Reminder、权限、Operation 与资源映射。
- MessagingPort 管实时消息、漫游历史、已读、Reaction、撤回、Thread 引用和媒体消息。
- Screen 不直接调用 fetch、腾讯 SDK 或持久存储；调用必须先进入 application/runtime port。
- `web/packages/client-core/contracts/platform-v1.openapi.yaml` 是客户端平台契约源；修改时同步生成文件、lock、
  client-core 测试和 Web/TUI 消费方。

主要入口：

- Expo Router：`web/apps/client/src/app/`
- 应用状态与协调：`web/apps/client/src/application/`
- 运行时注入：`web/apps/client/src/runtime/`
- 腾讯 IM 适配：`web/apps/client/src/im/`
- 共享客户端契约：`web/packages/client-core/src/`

## 变更路由表

先判断变更属于哪条权威链，再开始编辑：

| 需求 | 起点 | 必须同步 | 主要门禁 |
| --- | --- | --- | --- |
| Platform HTTP/API | Backend OpenAPI | Backend 生成代码、client-core contract/generated/lock、PlatformApi、Store/Screen | OpenAPI compatibility、generated check、core/app tests |
| 腾讯消息行为 | `MessagingPort` 语义 | Human IM adapter、Agent `gojaim`/Gateway、projection 与错误码 | IM adapter tests、真实历史/发送 smoke |
| 页面视觉/交互 | Tokens 或 shared primitive | Pattern、Component、Screen、Style Lab | token/style/ownership locks、pointer/touch browser evidence |
| TUI 行为 | shared presentation 或 `src/tui/` | TUI renderer、native modules、内嵌 bundle 三件套 | `check:tui`、`test:tui`、确定性 build test |
| Agent Runtime | `agent/internal/runtimeapi` | Runtime driver、assignment/capability、Computer controller、TUI 可见能力 | Go/race tests、真实 Runtime probe |
| Computer 发布 | Agent + TUI 已提交源码 | macOS/Linux target、manifest/signature、COS catalog、安装/升级 | 双 target 验签、digest、rollback、live heartbeat |

如果一个需求跨两行以上，必须在设计或计划中写清长期事实、可替换行为和发布顺序，不能靠一次“大提交”隐式耦合。

## 身份与凭据边界

| 身份 | 用途 | 可持久化内容 | 禁止事项 |
| --- | --- | --- | --- |
| Human | 登录、管理 Server/Project、聊天 UI | 安全存储中的 refresh token；必要的非敏感本地偏好 | 不持久化 access token 明文，不冒用 Computer/Runtime API |
| Computer | Assignment、Heartbeat、TAT 与本机 Agent 编排 | 受限权限的 Computer credential、安装 journal、非敏感状态 | 不作为 Human 或 Agent Runtime；凭据不进入 Web/TUI bundle |
| Agent Runtime | 执行 Agent turn、调用受限 `vela` capability | Profile/Runtime 自有状态与轮换凭据元数据 | 不读取 Human refresh token、Computer credential 或其他 Agent identity |
| 腾讯 IM identity | SDK 登录、消息/群组/Topic 数据面 | SDK 所需短期会话状态；平台只存稳定 mapping/引用 | UserSig 不进日志、源码、fixture 或普通产品 DTO |

Human access token、refresh token、Computer credential、Runtime credential 和 IM UserSig 不能互换。日志只允许输出
身份类型、资源 ID、版本、存在性、长度、hash/digest 等安全元数据；禁止输出 token、签名、presigned URL query。

## 腾讯云 IM 的职责边界

腾讯云 IM 是聊天数据面和聊天历史的唯一权威来源：

- 承载 Channel/Topic、Server 内私信对应的会话、实时事件和漫游消息；
- 负责消息发送、撤回、Reaction、已读、搜索、图片/文件等媒体传输；
- Human Web/Expo 通过 `TencentChatGateway -> ChannelChatService -> TencentMessagingPort` 使用 SDK；
- Agent Computer 通过 `agent/internal/vela/gojaim` 运行嵌入式腾讯 IM 数据面，并由
  `agent/internal/vela/agentgateway` 暴露受限本地能力；
- Backend 负责签发会话材料、资源映射、成员/Topic 操作编排、Callback 和一致性补偿，但不建立第二套聊天库。

禁止把聊天正文复制为平台权威数据。平台只保存稳定业务对象、腾讯资源映射、Operation 和必要的消息引用。
Thread/Task 等跨域关联使用腾讯消息 reference，不以本地消息副本替代腾讯历史。

入站附件使用短生命周期、内存态 `attc_` capability。Provider URL 和 token 不进入 Runtime prompt、日志或
持久化状态；附件字节仍由腾讯媒体地址按需读取。出站 staged attachment 是另一条显式路径，不得混用。

定位 IM 问题时按层检查：

1. Backend 权威资源与 IM mapping 是否 ready；
2. Human/Agent 的 UserSig 与 SDK lifecycle 是否 ready；
3. Conversation address 是否指向正确 Group/Topic/DirectConversation；
4. 腾讯历史/事件是否真实存在；
5. 最后才检查 UI projection。不要用平台数据库“补一份消息”规避问题。

## 异步 Operation 与补偿语义

- HTTP `202 Accepted`、创建了 Operation 或进入 polling 都不等于业务完成。只有稳定 terminal state 和对应资源
  投影都成立，UI 才能显示成功。
- UI 通过共享 Operation 状态组件展示 pending、retry wait、timed out、rate limited、failed、uncertain 和
  succeeded；Screen 不自行发明第二套 loading/error 文案状态机。
- `pollOperation` 必须保留最后一次可信状态，尊重 `Retry-After`，支持取消，并在暂时错误后继续；超时不能伪造失败
  或成功。
- “继续查询”是恢复 polling，不是重新提交 mutation。不可安全重放的腾讯 IM 发送、Reaction、撤回等操作失败后
  必须显式报告，不能自动重复。
- JIT 补偿只修复可重建 projection/membership，例如当前账号缺失的 Channel membership；它不能创造不存在的
  权威资源，也不能替代后台一致性扫描。
- Backend 权威资源、腾讯 IM 状态和客户端 projection 发生短暂不一致时，错误提示应短暂、可恢复且不闪烁；不要
  在初始异步读取尚未完成时展示最终错误。

## UI 组件与所有权

组件层级从低到高：

```text
src/ui/tokens.ts
  -> primitives/
     -> patterns/
        -> components/
           -> layouts/
              -> screens/
                 -> features / Expo routes
```

### Tokens

`web/apps/client/src/ui/tokens.ts` 是颜色、材质、排版、密度、阴影、层级、动效与共享几何的唯一主题入口。

- pointer/touch density 与 compact/medium/wide layout 是两个独立维度，禁止用窗口宽度猜输入密度。
- 不在 Screen 写裸颜色、任意阴影、玻璃透明度、控件高度或重复 header spacing。
- 新 recipe 必须跨组件复用；`theme-contract.test.ts` 限制 namespace 和叶子数量，不能为了通过 lint 无限加 token。

### Primitives

`src/ui/primitives/` 拥有可交互控件和材质：`SystemButton`、`SystemField`、`SystemSelect`、`SystemDialog`、
`SystemPopover`、`SystemMaterialSurface`、`SystemFloatingHeader`、`SystemStatusIsland` 等。

- Dialog、Popover、菜单、表单 footer 和 Header 不得自行画按钮。
- 主内容 Header 必须使用 `SystemFloatingHeader`；Chat、Task、Agent、Computer、Member、Settings 均由该边界
  统一。Sidebar、collection、thread、terminal 和 card 内部 header 保持 docked。
- Action 的 focus、hover、pressed、disabled、keyboard 与 aria 状态由 primitive 负责。

### Patterns

`src/ui/patterns/` 提供页面语法。管理类页面统一使用：

- `SystemPage`
- `SystemSection`
- `SystemRow`
- `SystemForm`

Screen 不能回退到手工拼 `ManagementStage`、本地 Header、任意 Row 或私有表单 footer。

### Components、Layouts、Screens

- `src/ui/components/`：MessageComposer、MessageList、OperationStatus、ManagementWorkspace、TerminalPanel 等复合块；
- `src/ui/layouts/`：PlatformFrame、WorkspaceShell、导航/内容 ownership 与 responsive 结构；
- `src/ui/screens/`：面向产品场景组装既有 pattern/component，不拥有新的视觉系统；
- `src/features/`：路由适配、场景测试和 application 到 UI 的连接，不复制 Screen chrome。

关键防回退门禁：

- `src/ui/token-usage.test.ts`
- `src/ui/style-lint.test.ts`
- `src/ui/theme-contract.test.ts`
- `src/ui/management-ownership.lock.test.ts`
- `src/ui/components/management-workspace-usage.test.ts`
- `src/ui/framework-boundary.test.ts`

## Expo 与 Web 的玩法

安装依赖只在 `web/` workspace 根执行：

```bash
cd web
bun install --frozen-lockfile
```

开发态 Expo Web：

```bash
bun run --cwd web/apps/client web
```

正式 Web 不是 Node SSR 服务，而是 Expo 静态导出：

```bash
bun run --cwd web build:core
bun run --cwd web/packages/client-core typecheck
bun run --cwd web/apps/client typecheck
bun run --cwd web/apps/client build:web
```

产物位于 `web/apps/client/dist/`，由非 root Nginx 静态托管；未知页面必须 fallback 到 `index.html`，
`/_expo/static/` 与 `/assets/` 必须长期缓存，HTML 必须 `no-cache`。Nginx 只把 `/v1/**`、`/install`、
健康端点等明确路径反代到 Backend。

`src/app/stylelab.tsx` 是真实组件视觉实验室。涉及材质、密度、Header、响应式或控件状态时，必须验证：

- light / dark；
- pointer / touch；
- compact / medium / wide；
- idle / hover / focus / pressed / disabled；
- 真实页面截图或浏览器 DOM box，而不只是 Jest 样式对象。

## Human TUI 的玩法

TUI 入口是 `web/apps/client/src/tui/entry.tsx`，使用同一 client-core/presentation 语义，但由 TUI renderer 和
native module 适配终端，不运行浏览器 DOM、腾讯 Web SDK 或普通 fetch。

生成内嵌产物：

```bash
bun run --cwd web/apps/client build:tui
```

输出必须一起提交：

- `agent/internal/vela/humantui/assets/human-client.bundle.js`
- `agent/internal/vela/humantui/assets/human-client.bundle.manifest.json`
- `agent/internal/vela/humantui/assets/human-client.bundle.sha256`

Go 端通过 `agent/internal/vela/humantui/bundle.go` 的 `go:embed` 固定这些字节。任何影响 TUI 可达依赖图的
源码变更都必须重新生成，随后运行：

```bash
bun run --cwd web/apps/client check:tui
bun run --cwd web/apps/client test:tui
bun run --cwd web/apps/client test:tui-build
```

`check:tui` 失败表示提交的 bundle 与源码不一致；不能只改 hash 或 manifest，也不能把 stale bundle 描述为
“Web 已通过所以没问题”。

## 生成物与提交归属

| 产物 | 权威源 | 是否提交 | 校验方式 |
| --- | --- | --- | --- |
| client-core OpenAPI types/lock | `contracts/platform-v1.openapi.yaml` | 提交 generated types、lock 与对应测试 | core build/typecheck、hash lock test |
| Backend OpenAPI/Ent 生成代码 | Backend machine contract/schema | 按 Backend 规则提交 | `check-generated.sh`、compatibility/migration gates |
| Human TUI bundle/manifest/hash | Web/TUI TypeScript 源码 | 三件套一起提交 | `build:tui` 后 `check:tui` 与确定性测试 |
| Expo Web `dist/` | `web/apps/client` 源码与 Expo 配置 | 不提交 | 每次发布重新 `build:web`，验证 SPA fallback |
| `node_modules`、构建 cache | lockfile | 不提交 | `bun install --frozen-lockfile` 可重建 |
| OCI image/COS Release Set | 已推送 commit + 发布配置 | 不提交二进制到 Git；保存仓库外 evidence | registry/COS digest、签名、manifest 验真 |
| kubeconfig、Secret、SSH key、presigned URL | 运维凭据系统 | 严禁提交 | 凭据扫描与人工检查 |

禁止手改 generated 文件掩盖源契约错误。若生成物变化超出预期，先找出其输入链；不要只接受“大量自动 diff”。

## 提交前前端门禁

推荐唯一顺序：

```bash
cd web
bun run typecheck
bun run test
bun run security:scan
bun run --cwd apps/client check:tui
bun run --cwd apps/client test:tui
bun run --cwd apps/client test:tui-build
bun run --cwd apps/client build:web
bun run --cwd apps/client verify:web-fallback
```

`typecheck` 必须先 build client-core；直接从 stale workspace 输出运行 app `tsc` 会产生假错误。测试、类型、
TUI、Web export、浏览器视觉验收是不同证据，不能互相代替。

## 发布事实与运行手册

发布结论必须按以下事实层级逐层证明：

```text
origin/master commit
-> 生成物及其 hash/manifest
-> Web/TUI/Computer 构建产物
-> TCR/COS 不可变 digest 或签名
-> k3s Deployment spec
-> Running Pod imageID / Computer 实际版本
-> HTTP、浏览器、TUI 与 Runtime 的真实行为
```

任一层通过都不能替代下一层。尤其禁止把测试通过描述成已发布、把镜像 push 描述成已部署、把 Deployment
spec 更新描述成 Pod 已运行，或把健康端点 200 描述成完整业务验收。

当前唯一活跃 Web 目标、SSH/k3s 信息、构建、digest 切换、回滚和验收命令位于：

- `docs/runbooks/k3s-release.md`

环境地址、版本和当前 digest 属于易变运行事实，只在 runbook/发布证据中维护，不复制到长期架构章节。发布前
必须重新读取 runbook、远端 `master` 和 live k3s 状态，不能依赖历史聊天结论。

## Computer 与 TUI 发布边界

Computer release 必须同时产生 `darwin-arm64` 和 `linux-amd64`，生成 target-local manifest/signature，使用
离线 Release key 独立验签，并 create-only 发布 COS。Channel key 与 Release key 是两个信任域，私钥都不能
进入源码、容器或 Computer。

TUI 是 Computer 二进制的必选内嵌产物，所以 Computer release 必须先通过全部 TUI 可复现门禁。Web image
digest、Computer release version 和 TUI bundle hash 是三个不同版本事实，交付时分别报告。

现有 Computer Canary 脚本仍带有退役共享集群的副本和 catalog 切换假设，不得再作为 live 发布入口。
下一次 Computer 版本发布前，必须先实现并审查独立 k3s 的 release/catalog 切换脚本，并保持 create-only、
双 target、自动 rollback、真实 digest 和健康验收语义。
