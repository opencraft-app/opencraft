## goal

收敛 DSH 创建、工具挂载、执行准入与客户端撤销的所有权边界。

## non_goals

- 不增加投机预热或改变持久会话身份，不发布或覆盖安装应用。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求按照合理所有权彻底整改；本轮覆盖 review 指出的生命周期缺口。

## interface_refs / data_structure_refs

- ThreadLifecycle：目录提交、订阅、Thread 操作队列。
- DshCapabilityBroker：连接 owner 声明与撤销。
- DshExecutionAuthority：执行权及提交前连接有效性。
- DSH plugin：Agent setup 内首次挂载；native session 资源串行释放。

## history_context

- current_design_refs：`opencraft/docs/chat-ui-architecture.md`、`opencraft/design/invariants.md`。
- relevant_evolution：原并发 register 修复仅解决同名挂载，未覆盖撤销和执行交错。
- superseded_refs：任意异常截断后可安全透传的假设不成立。

## acceptance

- 工具准备不阻塞停止、审批回复和队列删除。
- 已撤销 owner 的迟到注册和目录提交失败关闭。
- capability 替换与执行准入共享 Thread 队列。
- 新 Agent setup 首次挂载失败不发布 native Session。
- 历史读取与执行准备保持独立，冷声明接受不等于引擎挂载 ready。

## affected_paths

- `opencraft/apps/local-agent-host/src/`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/tests/`、`opencraft/scripts/smoke-dsh-capability-plugin.ts`

## required_context

- 根/OpenCraft AGENTS、维护 Skill、trace，以及上轮审查已读取的路由 context。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md` | 执行边界 | Host 权威 |
| `docs/context/domains/site-environment-routing.md` | 路由必读 | 不改生产 |
| `docs/context/project/upstream-subtrees.md` | 路由必读 | ref 只读 |
| `docs/context/project/services/opencraft.md` | 服务入口 | 验证边界 |
| `opencraft/apps/local-agent-host/src/thread-lifecycle.ts` | 目录与释放 | 共享队列 |
| `opencraft/apps/local-agent-host/src/main.ts` | RPC 装配 | 提交和撤销 |

## decisions

- 正式所有权设计汇总到 `opencraft/docs/execution-ownership.md`，区分实现机制、目标不变量与未闭合的跨进程交付边界。

- 复用现有 ThreadLifecycle 队列，不复制一套 warm/Agent 身份服务。
- Capability 首次挂载进入 native setup；Host callback owner 仍由 broker 持有。
- 断线同步撤销，异步清理不撤销后继 owner。
- bridge 仅暴露允许的错误码；原始异常不进入 UI。

## validation

- 生命周期/撤销/控制命令聚焦测试、真实 DSH loader、Local Host/Workbench typecheck、平台边界及构建。

## evidence

- 真实 loader：无效 capability 创建返回失败且 session.list 无该身份；有效创建和重复挂载成功。
- 聚焦生命周期、broker、执行权与 Workbench 测试 45/45；随后新增同物理连接 logical client 重建用例，Local Host 11/11。
- DSH bridge 完整套件 232/232、Chat 套件通过；Local Host/Workbench Runtime typecheck、平台边界与 Electron 构建通过。
- 独立只读复核发现的 logical client incarnation 复用与全局 new-thread 排队已修复：owner 每次重建独立 ID，Host 预分配 native session ID，超时释放请求可定位原创建。
- 全量 gate 未通过：第一步 check:i18n 报 Conflicting defaultMessage for common.retry（并行国际化改动）；不宣称全仓验收通过。
- 变更影响检查通过，git diff --check 通过。

## risks

- HTTP 超时后的创建回执丢失仍需单独定义幂等操作身份；本轮不以删除持久日志冒充跨进程事务回滚。

## scan_scope

- 上述 Host、runtime、测试边界。

## scan_output

- 已按上轮源码 review 逐项定位。

## handoff

- review 指出的控制门禁、撤销复活、注册/执行 TOCTOU、release 队列范围与异常正文透传已整改。
- 新建首次工具挂载进入 native setup；目录提交位于准备之后。运行资源补偿保留持久日志，不宣称跨进程原子事务。
- 未提交、未发布、未生成新 DMG；未在对方机器实测。全量 gate 受并行 i18n 冲突阻塞。
