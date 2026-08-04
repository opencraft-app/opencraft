# Go 客户端与 Raft Computer 1.0.13 深度差距审计（冻结证据）

日期：2026-07-30

## 结论

当前 Go 客户端已经不是粗糙原型。对“新建 Computer、受控创建 Agent、运行
Codex 或 Hermes”的既定产品范围，它已具备可实际使用的完整主链路：

- Computer service、每服务器一个 runner、控制 WebSocket、Agent Manager；
- Codex `app-server` 的持久会话、resume、turn、steer、事件归一化；
- Hermes ACP 与 Hermes TUI Gateway 的独立 Profile、并发和生命周期；
- Agent-facing `raft` CLI、Capability Gateway、Workspace、Skills、reminder；
- 对象存储迁移实现和较完整的安全/差分测试。

但它还不能无条件称为“Raft Computer 1.0.13 完整 drop-in 替代品”：

1. 原版有 12 个 Runtime ID 和对应语义，Go 目前只有 3 个内置 Driver。
2. Hermes 暂借 `opencode`、`pi` wire ID；这只能用于专门配置的 Canary，不能安全
   接管已有 OpenCode/Pi Agent。
3. Computer CLI 和 supervisor 的完整运维语义仍明显少于原版。
4. 有几处已经确认的安全/生命周期差距需要在正式发布前收口。

更准确的产品定位是：

> 一个已经可用的、架构上优于原版的 Codex/Hermes managed Computer
> 实现；它兼容已观察的 1.0.13 控制协议，但尚未覆盖原版完整产品矩阵。

## 审计方法和限制

- 原版证据来自 `restored/` 的机械恢复 bundle 和 Computer 编译片段；它不是原始
  TypeScript 源码，也不参与 Go 工程编译。
- 对照的是外部协议、状态机和进程行为，不比较实现文本或文件布局。
- 本轮是只读审计；没有修改运行中的本地服务、远端 VM、Agent 或云端对象。
- Go 生产代码为 102 个文件、约 41,412 行；测试为 108 个文件、约 55,264 行。
- 恢复的 daemon bundle 为 3 个文件、约 84,212 行；Computer 编译片段为 91 个
  文件、约 14,091 行。bundle 包含依赖和生成内容，行数不可直接作为开发量换算。

## 分层评价

| 维度 | 当前判断 | 说明 |
| --- | --- | --- |
| 已观察控制协议 | 强 | 原版和 Go 主控制入口覆盖同一组 25 类入站事件；ready、ack、workspace、migration、restart、reminder 等主体齐全 |
| Codex Runtime | 强 | 是当前最接近 drop-in 的部分；持久 app-server、resume、steer、事件和 fencing 均有大量差分测试 |
| Agent-facing CLI/API | 强 | Cobra 命令树和 Agent API 契约覆盖已观察命令族；Capability Gateway 边界较完整 |
| Hermes ACP/Gateway | 可用但属于新增能力 | 已通过真实 Canary；原版没有 Hermes，不能用“原版等价”衡量 |
| Workspace/Skills | 中强 | Workspace 比原版更安全；Hermes Skill scanner 已硬化，Codex/通用 scanner 尚未统一 |
| 对象存储迁移 | 代码层强，云端验收未闭环 | archive、hash、lease、重试和原子替换接近原版；缺两台独立 Canary 的真实迁移 |
| Agent Manager | 中强 | 并发、队列、fencing、恢复完善；少数 stale/节流细节不如原版 |
| Computer service/CLI | 中 | 基础服务可用，但缺完整 supervisor 意图、原版运维参数和准确的 `runners` 语义 |
| Runtime 覆盖面 | 部分 | Go 3 个内置 Driver；原版 12 个 Runtime ID |
| 安全隔离 | 中 | 文件边界较强，但仍继承同一 OS 用户和 host env；launch token 复用需要修复 |
| 日志和诊断 | 中 | 有脱敏和按需 transcript；缺本地轮转，`logs` 会整文件读取 |
| 平台覆盖 | 部分，符合首版范围 | macOS ARM64 为主；原版还有更宽的 Windows/legacy/supervisor 兼容面 |

## 必须优先处理的差距

### P0：Runtime wire ID 借槽会破坏真正的 drop-in

Go 注册关系目前是：

- `hermes-acp → opencode`
- `hermes-gateway → pi`

对应代码：

- `internal/hermes/registration.go:8`
- `internal/hermesgateway/registration.go:75`

原版 `opencode` 会启动真实 OpenCode，`pi` 会启动真实 Pi SDK/CLI；原版的
`driverFactories` 在恢复 bundle 的约 `19129–19147` 行明确将两者注册为独立
Driver。

影响：

- 新建并明确配置的 Hermes Canary 可以工作；
- 已有云端 Agent 若配置为 `opencode` 或 `pi`，连接到 Go Computer 后会被静默
  启动为另一个引擎；
- 因此这不是语义兼容别名，而是临时 wire slot。

建议：

1. 云端增加正式的 `hermes-acp`、`hermes-gateway` Runtime ID；
2. 去掉两个临时别名；
3. 如果必须接管已有 `pi/opencode` Agent，要实现真实 Driver 或显式拒绝，不能
   静默替换。

这对专用 Canary 是已知限制；若产品宣称“可接管现有 Computer/Agent”，则是
发布阻断项。

### P1：Capability token 跨 launch 稳定复用，削弱 launch fencing

原版每次 launch 都生成新的 32 字节 `sap_` token，并按
`(agentId, launchId)` 注销，见恢复 bundle 约 `4264–4290` 行。

Go 当前会为同一 Agent 查找并复用已有 token：

- `internal/gateway/gateway.go:140–178`
- `internal/gateway/gateway_test.go:177–223` 还把“stable token”冻结为预期；
- `internal/runner/controller.go:808–834` 会在 token 相同时保留旧 token 文件。

generation 只防旧 `Handle.Revoke()` 删除新 registration，并未进入 HTTP
鉴权。未完全退出的旧 Runtime、遗留子进程或泄露的旧 token，可以访问新 launch
的能力映射。

建议：每个 launch 生成新 token；需要跨 rebind 延续的 visibility/freshness 状态
改为独立的 Agent-scoped 对象转移，不能通过复用 bearer token 实现。

### P1：`machine:runtimes:rescan` 没有真正重新探测

原版收到 rescan 后重新执行 runtime detector，再发送新的 ready，见恢复 bundle
约 `28095–28101` 和 `28251–28287` 行。

Go 在 runner 启动时只生成一次 immutable snapshot：

- `internal/runner/run.go:126–141`

rescan handler 只是重发使用旧 `c.runtimes` 的 ready：

- `internal/runner/core.go:795–807`
- `internal/runner/core.go:450–482`

结果是运行中安装、修复或移除 Runtime 后，网页点击重扫仍得到旧能力，必须重启
runner。

建议：Catalog 保持注册不可变，但 probe snapshot 可原子刷新；Agent Manager 对
已启动 session 保持旧 resolved registration，新 launch 使用新 snapshot。

### P1：`runners stop` 与原版语义不同，而且停止不持久

原版：

```text
raft-computer runners stop <agentId> [serverSlug]
```

它向指定 server 上的 Agent runner 发出 stop，见
`restored/modules/packages/computer/src/runners.ts.compiled.js:44–59`。

Go：

```text
raft-computer-go runners stop SERVER_ID
```

它停止整个 server child runner，见 `internal/computer/app.go:304–337`。更重要的
是，Supervisor 只删除当前 child：

- `internal/service/supervisor.go:123–134`

service 每 5 秒重新从 attachment state reconcile：

- `internal/service/host.go:77–80`
- `internal/service/host.go:107–128`

因此 attachment 仍在时，手工停止的 server runner 会被自动拉起。命令名看起来
成功，实际没有形成持久 desired state。

建议：

- 恢复原版的 Agent-scoped `runners stop <agentId> [server]`；
- 若还需要 server runner 级控制，另设 `servers stop/start/restart`；
- supervisor state 增加显式 desired state 或 suspend intent，reconcile 必须尊重
  它。

### P1：日志会无限增长，`logs` 又整文件读入内存

Go service 的 stdout/stderr 都 append 到单一 `traces/service.log`：

- `cmd/raft-computer-go/main.go:182–201`

`logs` 使用 `os.ReadFile` 一次读取全部内容：

- `internal/computer/app.go:294–301`

原版有按大小、时间和文件数轮转的结构化 trace sink，见恢复 bundle 约
`26353–26405` 行。

建议：

- 本地 JSONL/文本日志轮转；
- `logs --lines N` 从尾部流式读取；
- 可按 service/server/Agent/launch 过滤；
- 上传保持显式 opt-in，不必照搬原版自动上传。

### P1：Runtime Profile 隔离不等于 credential 隔离

Go 会把全部 host environment 复制给 Runtime，再叠加云端配置：

- `internal/runner/controller.go:1159–1185`

Hermes Gateway 当前只因临时 Pi wire contract 删除
`DEEPSEEK_API_KEY`：

- `internal/hermesgateway/firewall.go:10–24`

host 上的 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等仍可能进入所有 Agent。
不同 Hermes Profile 可以避免正常配置串台，但无法阻止同 OS 用户或环境凭证
横向读取。

建议：把 `CredentialEnvironmentPolicy` 加入 Runtime Registration。默认只继承
非敏感系统环境；每个 Driver 明确声明所需 credential/env allowlist。

### P1：两版共同存在无上限代理缓冲

Capability Gateway 的部分请求体和需要观察的 JSON 响应会完整读入内存；原版也有
相同问题。这不是为了兼容就应保留的行为。

建议：

- side-effect JSON 路由设置明确的 1–8 MiB 上限；
- 观察型响应使用 `LimitReader`；
- 普通上传/下载保持流式；
- 为上游增加完整 header/body/idle timeout。

### P1/P2：Codex/通用 Skills scanner 尚未采用 Hermes 的安全边界

Go Workspace 文件读取会逐段拒绝 symlink：

- `internal/workspace/service.go:109–171`
- `internal/workspace/service.go:174–204`

这是对原版的明确改进。原版只做 lexical path containment，随后 `stat/readFile`
跟随链接，workspace 内 symlink 可读取外部文件，见恢复 bundle 约
`23541–23567` 行。

但是 Go 的通用/Codex Skill scanner 仍：

- 不限制单文件大小和总条目；
- 对普通 `.md` 使用 `os.ReadFile`，可能跟随 symlink；
- 见 `internal/workspace/service.go:918–949`。

原版 Skill scanner 同样跟随 symlink 且无大小上限，见恢复 bundle 约
`23745–23775` 行。

建议：将 Hermes 已实现的可信根、`os.Root`、深度、条目、重复名和 symlink
限制抽成通用 scanner，所有 Driver 通过 Registration 提供 roots/layout。

## 次级差距

### Agent Manager 的细节

Go 已实现并发上限 5、500ms 启动间隔、launch fencing、128 pending 上限、错误
fingerprint fence、credential cooldown、stalled recovery 和持久 inbox。

仍有三个差别：

1. 原版只在不同 Agent 的启动之间做 500ms 节流；Go 的全局 worker 会在第一项后
   对每个 queued start 都等待，包括同一 Agent 的重启。
2. 原版对 compaction 5 分钟、review 10 分钟分别发布 stale 状态；Go 虽跟踪
   gated phase，但主要依靠更通用的 runtime progress stall。
3. 原版保留有界 stderr tail；Hermes Gateway 当前没有等价的进程错误尾部诊断。

这些不阻断 Codex/Hermes 主链路，但会影响复杂故障的恢复速度和可观察性。

### Computer 产品壳

Go 已有 login/logout/attach/setup/start/stop/restart/status/doctor/logs/runners，
但与原版完整 CLI 仍不同：

- 缺 per-server start/restart、foreground；
- attach/setup 缺少原版的若干 non-interactive/fresh/machine 参数；
- doctor 主要检查 state root、socket、login、attachment，缺 repair 和完整迁移/
  supervisor 诊断；
- logs 缺 server/runner/line selector；
- 不实现本地 upgrade/channel/rollback、自替换、legacy supervisor takeover。

最后一组是最初明确排除的非目标，不应被误报为本轮回归；但它们仍意味着“完整
原版产品”不等价。

### Runtime 抽象还需一次异构 Driver 验收

Go 的架构已明显优于原版：

- compile-time Registration；
- `RuntimeDriver` / `RuntimeSession`；
- direct/gated/queue policy；
- 可选 `NativeSteerer`、`NativeTurnInterrupter`、liveness、RuntimeHome；
- shared standing prompt。

当前三个内置 Driver 都是 persistent + direct + completion-event。类型上虽然能
表达 Claude 一类 persistent + gated + queue，但还没有真实第二种 policy
验证全部编排路径。

Registration 还缺少几个可选扩展面：

- `SkillRoots` / `SkillScanner`
- `TranscriptResolver`
- `CredentialEnvironmentPolicy`

现在 Workspace Skills、transcript、display name 等少量位置仍有 Runtime-specific
switch。新增下一种 Driver 时，应先把这些边界补齐，而不是继续往 runner/CLI
增加分支。

### Hermes Profile 与迁移

对象存储迁移只迁移 Raft workspace。Hermes 独立 Profile 位于
`~/.hermes/profiles/...`，其配置、memory、session 和 Profile Skills 不随
workspace 到达新 Computer。

因此：

- workspace migration 可兼容；
- Hermes Runtime continuity 还不是完整迁移。

需要明确选择：

1. Profile 可再生，只迁移声明过的非敏感 manifest；
2. Profile 作为独立加密对象迁移；
3. 明确不迁移，并在目标端重新初始化。

不能把整个 Profile 无筛选塞入现有 workspace tar，其中可能包含 provider
credential。

### 测试与真实验收

本轮验证结果：

- `go test ./... -count=1` 最终全通过；
- `go vet ./...` 通过；
- runner、Agent Manager、Gateway、Codex、Hermes ACP、Hermes Gateway 的重点
  race 测试通过；
- macOS linker 的 `LC_DYSYMTAB` warning 仍是非致命工具链提示。

发现一个测试稳定性问题：完整套件第一次运行时，
`TestRunLoadsAttachmentAndCompletesControlHandshake` 的 3 秒 ready 等待超时；
单测连续 10 次和 20 次均通过，随后完整套件也通过。目标测试会在并行负载下做
真实 Runtime probe，最慢一次已接近 3 秒。

这不是已确认的生产故障，但测试应注入固定 registration/probe，避免把主机负载
当协议失败。

仍缺的关键真实验收：

- 两台独立 Canary 状态目录之间的云端 object-store migration；
- 长时间断网期间包含副作用命令的幂等验收；
- 不依赖临时 `pi/opencode` 借槽的正式 Hermes Runtime ID。

## Go 版优于原版、应当保留的地方

| 项目 | Go 版优势 |
| --- | --- |
| Runtime 架构 | Registration + 小接口 + optional capabilities，比原版巨型 AgentProcessManager 更适合新增 Driver |
| Workspace 安全 | 拒绝 symlink component，避免原版的 workspace 外部文件读取 |
| Hermes Skill 扫描 | 有可信根、深度、条目、重复名和 symlink 限制 |
| 状态写入 | 临时文件、fsync、atomic rename、目录同步和严格权限较系统化 |
| Capability Gateway | loopback、redirect refusal、身份头覆盖、capability fence、hop-by-hop stripping 边界清晰 |
| 有界内部队列 | pending、event、frame 等多处有显式容量，不依赖无限内存 |
| Clean-room | 规格、fixture、credential scan、相似性 guard 与恢复代码编译隔离明确 |
| 隐私默认值 | 诊断上传以按需/显式为主，比自动上传全部 trace 更容易做隐私治理 |
| 可测试性 | 测试代码量超过生产代码，fake Runtime、差分和 race 覆盖远高于普通重写项目 |

## 原版不好的地方，不建议照搬

### 1. Workspace symlink 逃逸

原版的 lexical path 检查不能阻止链接指向 workspace 外。Go 当前做法更安全。

### 2. Skills 扫描无边界且跟随链接

两版的旧 scanner 都存在这个问题；应统一到 Hermes 新 scanner，而不是追求原版
逐字行为。

### 3. 代理请求/响应完整无上限缓冲

会造成内存 DoS 风险，应增加协议上限和流式处理。

### 4. 没有 OS 级 Runtime 沙箱

原版与 Go 都继承当前用户权限。workspace/Profile 隔离只是应用级隔离，不是
安全边界。正式多租户主机需要进程级 sandbox/container/独立用户。

### 5. Runtime-specific 逻辑集中在巨型 Manager

原版虽然有 `driverFactories`，provider/env/session/transcript/compaction 等大量
分支仍堆在同一 bundle。Runtime 多，但每增加一个成熟 Driver 的回归面很大。
Go 的 Registration 方向更正确。

### 6. 自动 trace 上传扩大隐私面

原版本地轮转值得借鉴；周期自动上传不应直接照搬。更好的默认是本地轮转、字段级
脱敏、用户明确同意后上传。

### 7. 断线只补 activity，不是通用事务 outbox

原版和 Go 都只对 activity 做 latest-only replay；其他状态、ack 和副作用结果
依赖服务端重投或幂等语义。不能把“WebSocket 自动重连”等同于“所有副作用 exactly
once”。

### 8. 兼容层和废弃 Runtime 的长期负担

legacy supervisor、自升级、自替换、deprecated Runtime 和多平台 shell 兼容让
原版的运维收敛更成熟，也显著增加维护成本。Go 应只补产品真正需要的部分，不必
为了“100% 行数复刻”复制全部历史包袱。

### 9. `curl | sh` 安装链路

易用但扩大供应链和误执行风险。正式 Go 发行应提供签名、checksum、版本固定、
原子替换和明确 rollback。

## 推荐实施顺序

1. **正式 Runtime ID**：移除 `opencode/pi` 借槽，建立 Hermes 一等 wire ID。
2. **launch token**：每 launch 新 token，visibility 状态与 token 解耦。
3. **durable runner intent**：修复 `runners stop` 语义和 5 秒自动复活。
4. **动态 Runtime rescan**：原子刷新 probe snapshot。
5. **统一 Runtime metadata**：把 Skills、transcript、credential env policy 放入
   Registration。
6. **安全和运维硬化**：代理 body limit、timeout、通用 safe Skill scanner、本地
   log rotation/tail。
7. **真实云端验收**：两 Canary migration、长断网、副作用幂等和 restart
   convergence。
8. **再加异构 Driver**：优先选择能验证 gated + queue 的 Driver；在它通过前，
   不把“新增任何 Agent 都只需写 Driver”当成已经完全证明的结论。

完成前四项后，当前项目才适合对外表述为：

> 对已支持 Runtime 的 Raft Computer 协议兼容实现。

完成正式 Runtime ID、真实云端 migration 和至少一个异构 policy Driver 后，才
适合进一步表述为：

> 可维护、可扩展的通用 Raft Computer 替代实现。
