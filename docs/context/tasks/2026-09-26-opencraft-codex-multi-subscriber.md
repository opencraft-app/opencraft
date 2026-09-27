## goal
让同一 Codex Thread 的多个逻辑 Client 独立订阅：一个 Client 取消或断线，不得撤销其他 Client 的事件流或 Host 后台执行所需的物理订阅。

## non_goals
- 不修改 Codex 二进制或 AppServer 标准 wire schema。
- 不建立 bb 式持久事件时间线、不把单用户 headless 服务升级为多租户鉴权服务。
- 不提交、发布或替换当前运行服务。

## requirement_ids / requirement_refs / requirement_excerpt
- 本会话用户请求："那搞起来。要注重建模的正确性"；针对先前确认的多订阅者与物理 Codex stdio 订阅边界。

## interface_refs / data_structure_refs
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`：逻辑 Client 路由、`thread/resume`、`thread/unsubscribe`、后台队列与 server request owner。
- `opencraft/packages/app-host-server/src/index.ts`：每个 WebSocket lease 的可信 logical Client identity。
- `opencraft/packages/appserver-session/src/notification-buffer.ts`：恢复期间的通知缓冲。
- `opencraft/tests/fixtures/fake-codex-stdio-appserver.mjs`：单物理连接的协议替身。
- 不变量：阅读订阅、原生订阅和交互答复权分开；最后一个页面消失不停止已接纳 Turn。

## history_context
- current_design_refs: `opencraft/docs/execution-ownership.md`, `opencraft/docs/platform-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution: 当前 Daemon 已将多个 Client 复用到一条 Codex `--stdio`，但仍原样转发 Client 的 `thread/unsubscribe`；本地 Codex 源码按物理 connection ID 解除订阅。
- superseded_refs: none。

## acceptance
- A/B 订阅同一 Thread，B 取消或断线后 A 继续接收原生通知。
- B 在 `thread/resume` 回执前不遗漏已经到达 Host 的通知；失败或断线的迟到回执不能恢复 B 的订阅或审批 owner。
- 后台 Turn/队列和待处理交互在页面离开后继续由 Host 保持，不因错误的原生 unsubscribe 中断。
- 聚焦测试、Host/AppServer 测试、类型检查与边界检查通过；真实二进制未运行时明确留作未验证。

## affected_paths
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`
- `opencraft/tests/codex-engine-adapter.test.ts`
- `opencraft/tests/fixtures/fake-codex-stdio-appserver.mjs`
- `opencraft/docs/platform-architecture.md`
- `opencraft/docs/execution-ownership.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`, `control-plane-ops`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 仓库与服务边界 | 限定修改和发布权限 |
| `docs/context/domains/agent-gateway-runtime.md`、`docs/context/domains/site-environment-routing.md` | 路由结果 | 区分 Host 修复与站点行为 |
| `docs/context/project/upstream-subtrees.md`、`docs/context/project/services/opencraft.md`、`docs/context/project/services/ctl.md` | 路由结果 | 确认唯一真源和服务范围 |
| `opencraft/docs/execution-ownership.md`、`opencraft/docs/platform-architecture.md` | 正式设计 | 明确多订阅、后台执行和交互 owner |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`、`references/verification.md` | 维护方法 | 选择不变量与验证层级 |

## evidence
- 初始工作树为 dirty；Codex adapter、测试、fixture 和文档已有其他未提交修改，必须保留。
- 真实边界是多个 logical Client 共用一条 Codex stdio；`thread/unsubscribe` 对物理连接生效，因此不能原样转发某个 Client 的取消意图。
- 替身 AppServer 现在按单物理连接维护订阅，并在延迟回复后发出明确测试完成信号；先用两条失败回归固定了 A/B 单人取消与 B 加入期间事件丢失，再修 Host adapter。
- Host 区分逻辑读者、物理原生订阅和交互答复 owner；pending `thread/resume` 是临时读者。断线/取消撤销临时读者并抑制迟到回执投递；单调 Client 代次保护同 ID 重连，断线后删除旧代次以避免长期增长。
- Native 订阅只在无逻辑读者、无活动 Turn、无未结队列/交互/Host 请求且原生 Thread 空闲时释放；持久 Thread 默认 30 分钟 grace，临时 Thread 立即释放。Native release 与新的 turn 工作按 Thread 串行化，`thread/resume` 等待进行中的 release。
- 测试覆盖 A/B 同看与单人退出、恢复回执前事件、取消/断线的迟到回执、同 ID 重连、断线后晚到 start、最后页面退出时的后台 Turn/队列、待处理交互和最终 native 回收。

## risks
- Native unsubscribe 与新 `thread/resume` 交错会产生失联事件；用 Host 订阅所有权和代次约束。
- 过早释放物理订阅会使后台队列无法获知 Turn 终态；先保护 Host 内部需求，再做回收。
- 当前只以协议替身验证物理订阅语义；真实 Codex 二进制及手机两端同时打开仍需独立运行态验收。此机制不是持久事件时间线，不保证 Host 进程重启期间的事件回放。

## validation
- 以打包 Node 显式运行 `tsx --test tests/codex-engine-adapter.test.ts`：22/22 通过。
- 以同一 Node 运行 `test:appserver` 的全部 25 个测试入口：238/238 通过；`tests/app-host.test.ts tests/opencraft-daemon.test.ts` 单独 12/12 通过。
- Daemon workspace `tsc --noEmit` 通过；`scripts/generate-typography.mjs --check` 与 `scripts/check-platform-boundaries.mjs` 通过；涉及文件 `git diff --check` 通过。
- 完整 `npm run typecheck --workspaces` 未运行：当前终端 PATH 无 npm；改动的 TypeScript workspace 已独立类型检查。`validate_change_impact.py --staged` 未运行：本轮未暂存用户工作树。

## decisions
- 实现位置为 Codex Host adapter；不让每个 Renderer 承担物理 AppServer 订阅的所有权。
- 不引入 bb 式持久事件日志；加入期间依靠现有 resume buffer 接住 Host 直播，权威历史仍来自 AppServer 快照。
- 不提交、推送、构建发布或替换正在运行的服务；用户当前请求仅授权实现与验证。

## scan_scope
- `opencraft/apps/opencraft-daemon`, `opencraft/tests`, `opencraft/docs`。

## scan_output
- 有界 `rg` 定位与相关差异已在本会话记录，未生成独立扫描产物。

## handoff
- 源码、模型文档与替身验证已完成。后续若要切换正在运行的 preview，需用户单独授权构建/替换，并用真实 Codex + 两个浏览器观察者验收。
