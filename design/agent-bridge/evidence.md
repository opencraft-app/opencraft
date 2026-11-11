# 源码核验与 R1/R2 修正

本记录只保留正文依赖的事实；R1/R2 的其余版本号、安装状态、合并祖先关系和真实账号成功记录不作为方案依据。2026-11-11 只读检查，未运行 agent 模型。本机 checkout 是复核入口，不是公开核心的构建依赖。实现批次须重新固定实际 artifact、原生版本和许可证；作者检查不等于已完成法律权利审核。

## 基线与复核方法

| 源 | 本轮 checkout | 检查内容 |
| --- | --- | --- |
| OpenCraft | `313a79e17e` | origin/main；正文只依赖此版本已有源码和契约 |
| BB | `73fe7b4ad9a0c7f7c3f16b8e369fc61cccaea7d2` | docs 三篇与原生 bridge；另用 git show 检查用户 ACP patch |
| bb-plugins | `557973a` | acp-compat CodeBuddy、DSH proxy |
| dsh-plugins | `6fc5a71` | acp-steering 插件 |
| cursor-acp | `d1cbf7d` | SDK run.steer 与本地历史记录 |
| antigravity-acp | `3b4b7bd` | hook、IPC、队列与 SQLite 行匹配 |
| amp-acp | `d54d0de` | CLI steer 与 echo；不是 R1 所述已安装快照 |

BB 根为 BB checkout，其他仓库均为相邻的 Codex / amp-acp / cursor-acp / antigravity-acp checkout。用 `git rev-parse HEAD` 固定读取基线；`git show -s --format` 核对下列作者提交，随后读取命名源码函数。不从 R1 行号直接推出运行成功。

## 正文依赖的 OpenCraft 事实

| 事实 | 核验位置（仓库相对路径） | 结论与范围 |
| --- | --- | --- |
| Thread/Server 与 Host/Client 分离、原生日志真源 | `docs/execution-ownership.md` 的拓扑和 owner 表 | 当前正式契约；不宣称完整多租户/Hub 级联已实现 |
| Codex 常驻、账号池、native listener | `docs/codex-core.md` 所有权与协议；`apps/local-agent-host/src` Codex 连接路径 | 正式部署契约；native unix socket 是 WS Upgrade，控制面是 Unix HTTP；桌面默认仍内嵌 stdio |
| 独立 ACP Host | `docs/acp-host.md`；其列出的 `execution/acp-host.mjs` 运行入口 | 已有独立 owner 设计/装配；不证明用户机器该 unit 已启动 |
| 编排 Broker 跨引擎 | `packages/access-control/src/thread-orchestration-broker.ts:77` cli，`:111` perform | context/list/spawn/tell/show/wait；driver 白名单含 codex/pi/dsh/acp/claude-code；这是代码分派范围，不是所有引擎验收结论 |
| 每次从 execution 派生委托 | 同文件 `executionSource`、`authorize`、`invoke` | sender 不能由 CLI 参数指定；每次重新调用 delegation/资源授权 |
| 幂等和通知 | 同文件 `withOperation`、`receipt`、`reconcile`；现有 orchestration ledger | 调用以 operation ledger 回执、waitTicket 和通知批次衔接；不能据此声称任意 native mutation 恰好一次 |
| 共享 8 写预算 | `packages/access-control/src/collaboration.ts:327` 及 Broker perform 的预算分支 | 代码明确 `count>=8` 拒绝；不是新的任意 CLI 命令可自动获得写权限 |
| 当前 CLI 靠工具创建 launcher | `packages/session-capabilities/src/thread-cli-provider.ts:8` tools/call | execution 才有 thread_cli；call 中创建 0700 目录、0600 connection.json、0700 launcher |
| capability 与 transport 耦合 | `packages/session-capabilities/src/mcp.ts` token/authenticate、prepareExecution、`:226` HTTP router | 当前同类持有签名/绑定及 `/thread-cli` 路由；CLI 路由拒绝缺 execution 的 session；去 MCP 需拆发行服务 |
| 私有 CLI 校验 | `packages/session-capabilities/src/thread-cli.ts`；`apps/opencraft-cli/src/main.ts:194` | 检查文件 owner/mode/大小/非 symlink，限定 loopback endpoint；spawn/tell 强制 key；env 已可发现 connection 路径 |
| 现有定时不是项目 automation | `packages/host-schedules/src/index.ts:19`、schedule/read/dispatch | schedules 以 thread_id 为键，运行提交 prompt；不能把这个表名改成 automation 就得到 project agent/script 实体 |

已读 `AGENTS.md`、`docs/platform-architecture.md`、`docs/execution-ownership.md`、`docs/acp-host.md`、`docs/codex-core.md`、`design/thread-orchestration-architecture.md`。架构文档内「15 秒重试透明」「<5ms 读取」等描述未做运行复测，正文不依赖该时限和性能保证；重试必须服从结果未知不重放。

## 正文依赖的 BB 与 agent 事实

| 来源位置 | 核验结果 | 作者/采用方式 |
| --- | --- | --- |
| BB `docs/provider-bridge-protocol.md`、`provider-plugin-api.md`、`system-overview.md` | 语义 delta / assembler；declaration 上限 + handshake 收窄；语法范围协商；host artifact；客户端/host contract 分离；文档明确 steerMode 无运行消费 | 借鉴架构独立实现，不移植上游代码 |
| BB `plugins/provider-codex/src/bridge/bridge.ts:2106` 附近 | 转发 turn/steer，带 expectedTurnId，回 RPC 后 input.accepted | 上游；git log 该文件最新作者 Michael Yong，不当作用户 patch |
| Codex checkout `codex-rs/protocol/src/turn_input.rs:178` | Started/Steered 明确不等待 hooks、内存上下文、rollout 或 sampling | 原生 contract 证据，不能以 accepted 证明消费；未把本轮 codex checkout 版本当已安装版本 |
| BB Claude `src/bridge/sdk-session.ts:314` pushInput、bridge handleTurnSteer | Promise 在 iterable 取出输入时可 resolve，不是模型证据 | 上游；该 sdk-session 最新提交 `3db407dfec` Michael Yong；独立实现 |
| BB Pi `src/bridge/rpc-session.ts:432`、bridge `:1131` | streamingBehavior steer；bridge 在 steer 返回后发 input.accepted；消费队列单独跟踪 | 上游；最新 rpc-session 修改 `d011a88bc1` Yoann TERUEL，不能把整个文件归给用户 |
| BB `git show ade7a515df` | 用户提交确实跨 grammar/assembler/client 加 input.delivery 与 ACP 投递分支 | 作者 hxy91819；允许移植该用户 patch 的已核对部分；当前 BB HEAD ACP 文件未命中 input.delivery/resolveAcpSteering，不能混同分支与当前源码 |
| bb-plugins `acp-compat/src/adapters/codebuddy.ts:9`，`proxy.ts:189`、`:233`、`:340` | session/steer 精确 probe、steered + owner、user_message_chunk 插入 ID；缺证据显式失败 | `2561bb6` hxy91819（acp-compat adapter），`19a15c4` masonxhuang（旧独立 provider）均已核 author；可移植用户 patch，仍按逐 hunk 范围与许可证检查，不将整个 proxy 自动归用户 |
| bb-plugins `acp-compat/src/dsh-proxy.ts:135`、`:225`、`:252`；dsh-plugins `acp-steering/index.js:23`、`:60` | ready/claimed、messageId、side channel、未消费 settle 删除；插件调用 agent.steer，不是实现 DSH 核心算法 | `53cc1b4` 与 `d3693b8` 均 hxy91819；DSH 核心属于上游，应调用其 API；正文不依赖核心作者别名的准确性 |
| cursor-acp `src/cursor-acp-agent.ts:858` | run.steer；complete_delivered 后调用 recordUserMessage；其它 outcome queuePrompt | `afe6dbd` masonxhuang；只移植用户 patch；底层 SDK/runner 仍有上游作者 |
| antigravity-acp `plugin/steer-hook.ts:65`、`src/acp/steering.ts:60`、adapter steer | injectSteps；按 first claimed entry、idx floor 和原始文本匹配 user 行；不是稳定 per-input 原生 ID | `3b4b7bd` hxy91819；用户 patch 可移植；轨迹数据读取不是可以复制上游数据库实现的授权 |
| amp-acp `src/amp-transport.ts:448`，cli-prompt 格式化 | 写 steer=true，pendingPromptEchoes 同文本拒绝；本 checkout supportsSteering 还受 preserveCancelledProcess 配置约束 | `12998b4` hxy91819；`7776677` 主作者 Jintao Zhang，即使 co-author 含用户也不视为用户独有，分 hunk 独立实现 |
| BB `plugins/automations/src/service.ts:144` | automation-spawned threads 禁止创建 automation | 仅借鉴防递归语义，不把 BB 的其它所有 scheduler 行为当已核实事实 |

作者身份映射依据用户任务材料中的 hxy91819/masonxhuang 同一人约定，本轮核对了上述 commit 的 author 字段；这不代替对直接移植 patch 的完整权利检查。CodeBuddy 的两处作者提交已补核；直接复制仍限用户 patch 的范围。

## 推翻、收窄与未核实项

1. **推翻 R1 的强证据口径**：CodeBuddy user_message_chunk、AGY SQLite user 行、DSH claimed 是原生 run/inbox/上下文路径证据，不能统一称「模型已看到」。特别是 DSH claimed 只证明领取。正文不采用 R1 consumed=模型已看到的推导。
2. **推翻 Cursor 历史等于供应商确认的推导**：当前源码明确由 adapter 在 complete_delivered 后自行 recordUserMessage。SDK 返回可记录为交付，但本地历史不是独立原生上下文证据。
3. **收窄 R1 的“BB 唯一事实协议”**：用户 ACP 分支 patch 中存在 input.delivery 已核；当前 BB checkout 不含同名逻辑。R1 本机安装包含哪些 merge、Claude/Codex 修复是否在安装包中，本轮未复核，不依赖。
4. **收窄 Amp**：当前源码有 native CLI steer，但 supportsSteering 受 preserveCancelledProcess 配置控制；R1 指向已部署旧快照，本轮未核安装状态。不能写成所有 Amp transport、所有配置都支持。
5. **Copilot 无真 steer不能作全版本否定**：本轮未抓真实 initialize，也未复查本机安装包；R1 的字符串缺失只能为线索。正文默认保守不声明，P3 要实际探测。AGY/DSH 目前外部插件已启用等运行态陈述也未复核。
6. **推翻 R2 的绝对凭据不可见表述**：0600 是 OS 访问约束；agent 若有同 UID shell/file 能力仍可读取。env 仅路径避免直接泄露，但不证明无模型可见秘密；B 必须配 scoped grant、隔离挂载和撤销。
7. **收窄 R2 的 M3 缺口**：不用重新发明 PID→execution 绑定；现有 reservation/token/authenticate 已能表达 execution 身份。缺的是去掉 MCP 依赖后的发行时点、跨引擎工具 env 注入与隔离。把这些放在 Host 主动发行，而非选 C 新建身份体系。
8. **收窄 R2“已实现全覆盖”**：Broker driver 白名单与 smoke 脚本存在不证明本机每 agent 可用，更不证明网关升级绝对无损。正文逐 agent、逐权限模式、真实最小任务验收后才切默认。
9. **拒绝采用 R1 Hermes 改造建议**：报告建议 /steer 或 ACP 扩展与硬约束冲突，方案不采用，也不需要以 Hermes 上游 steer 源码支撑现有桥能力。

未纳入正文依赖的 R1/R2 断言保留未核实状态；本记录不为原报告整体背书。实施时最先补 Copilot 初始化、各移植 patch 的逐 hunk 边界和全 agent CLI 受限执行验证，而不是重复宽泛调研已有真 steer 思路。
