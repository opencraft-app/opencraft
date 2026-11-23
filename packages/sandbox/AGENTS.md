# Sandbox contract owner

Read the repository [execution sandbox contract](../../docs/architecture/execution/execution-sandbox.md) before changing this package or adding a consumer.

- Own the backend-neutral contract, admission budget and environment lifecycle. The API is `createSandboxPool()` / `createSandbox()`, hosted by an existing execution owner.
- Request 4 vCPUs / 8 GiB by default. Validate the provider's effective resources before exposing an environment; reject mismatches. Provider capacity is an admission budget, including for remote providers.
- An environment that states no `enforcement` claims enforced resources and complete containment. A provider that guarantees less must state it, and a pool admits it only when its policy explicitly accepts that dimension; never relax the default or present an accepted weaker environment as isolated.
- Keep process IDs opaque, cwd in the selected environment, and terminal support capability-based. Do not import Node, systemd, cgroup, PTY or vendor SDK types into this contract.
- Model an environment independently of a command or Thread. Command exit does not release its reserved environment budget; multiple commands may share an environment.
- Return capacity only after confirmed environment destruction. Queue cancellation must start no creation; late creation must be reclaimed. Unknown creation and failed cleanup retain capacity and their reconciliation identity, without blind retries.
- `./broker` owns the shared broker program and host-side framing/process state; `./providers` owns the provider registry and optional persistent-workspace capability; `./endpoint` owns `openSandboxEndpoint`, its relay program and the allow-listed endpoint names an image's `workspace-agent` may publish (callers name an endpoint; they never choose an in-environment path for agent-owned sockets). None may import Node or vendor types; vendor adapters supply only a launch port and provider definition.
- `./uri` parses `workspace://<id>/endpoints/<name>` and `<provider>://<target>` only at boundaries into typed values (no credentials, ports, queries); `./workspace` owns the provider-neutral WorkspaceRuntime (receipt `attach` or `create`, agent `control` probe/describe, name → environment resolution). `attach` never creates or replaces; when the provider cannot prove the same instance it rejects `SANDBOX_UNAVAILABLE`. Provider-specific parsing stays in the provider definition (`acceptsTarget`).
- `attached` processes fail alone (never retire the environment); every other process keeps fail-closed semantics. A backend advertising endpoints must pass `tests/execution/sandbox-endpoint-conformance.test.ts` by adding a harness, not provider-specific assertions.
- A new provider, including E2B, must implement resource enforcement (or state that it does not), filesystem/cwd mapping and lifecycle before consumers advertise support. Preserve engine permissions and Actor/lease authority.
- Match verification to the change: contract tests cover admission, cancellation, unknown creation, failed cleanup, effective-resource mismatch and terminal capabilities; runtime claims require a real provider check. See the existing tests under `tests/execution/`.

## 执行入口与部署约束

- 新增或修改引擎的命令、子进程、PTY、后台 worker 与取消路径时，先读 [CreateSandbox 契约](../../docs/architecture/execution/execution-sandbox.md)；共享原语归 `packages/sandbox`，Node/provider 适配归 `packages/sandbox-node`，分别遵循其局部 `AGENTS.md`。
- 执行入口消费 `createSandboxPool()` / `createSandbox()`；部署装配显式选择后端。Linux 本机只是可选后端，不能按操作系统隐式选择或把 Node PID、ChildProcess、PTY、systemd/cgroup 暴露为跨后端 contract。后续远程后端必须实现真实资源、工作目录与生命周期映射；不能仅登记名称便宣称 E2B 已接通。
- 默认每环境请求 4 vCPU / 8 GiB。CPU/内存有效约束须由 provider 验证；Linux 默认每环境4096 tasks（含线程）、每进程65536 FD，FD 不是环境总量。每引擎的环境生命周期以正式契约为准，不假定一个 Thread 等于一个沙盒。
- Codex 官方 exec-server、DSH subprocess/PTY（含 ACP DSH）和 Pi shell worker 的实际执行路径复用该原语。不得新增绕过已选沙盒的裸执行路径；选中后端缺失、配置无效或创建失败时拒绝执行，不能静默回退本机。未配置的既有 Host 不得宣称已隔离。
- Host/执行 owner 持有池、准入预算与清理。取消、所有者退出和关闭必须清理整组后代，确认销毁后才归还预算；未知创建结果与清理失败不得当作未创建或自动重放。保留引擎原有权限、Actor/lease 与 Git 来源校验。
- 多控制器共享的本机总上限、SSH/Core 优先级与宿主余量属于部署策略；不能把单进程池当全机预算，也不能靠提升优先级替代限制任务总量。验收读取实际内核 cgroup/rlimit，并验证派生继承、PTY、取消与旧会话续接；测试通过不能替代已部署组件的生效证据。
