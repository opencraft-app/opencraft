---
id: minisandbox-stage-reuse-closure-2026-10-02
type: task
scope: 补齐 workerd stage 复用的外部 Rust 客户端生产依赖验真，避免旧 SQLite bridge 被错误复用。
triggers: ["workerd stage复用", "嵌入客户端依赖验真", "stage外部路径依赖"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/reuse-stage-from-runtime.sh
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

仅在 workerd stage 与其嵌入 Rust bridge 的生产源码输入全部相同时复用旧静态二进制。

## non_goals

- 不改变请求、持久格式、Runtime ABI、云规模、3秒 SLO 或零稳态重试。
- 原 strict10k 仍缩容，不并发发布、materialize 或构建云镜像。
- 不为纯 Engine 修改重编 V8，不把本地输入校验说成真实万级通过。

## requirement_ids / requirement_refs / requirement_excerpt

- Stateless Workers/DO 设计的不可变 Version、SQLite bridge 与 source-bound 发布边界。
- workerd 锁定 fork 的 depot-ffi-rs/Cargo.toml 引用独立源码树的客户端和协议，不只依赖 fork bundle。
- 旧 stage reuse 只比较六个固定根，客户端变更可错误进入旧镜像读取。

## interface_refs / data_structure_refs

- reuse-stage-from-runtime.sh、verify-stage-reuse-inputs.py、Cargo metadata packages/dependencies。
- 两份已验真的源码、同一锁定 fork、普通/构建本地依赖闭包及 stageInputsDigest。
- 容器读取前拒绝；缺失 metadata、越界依赖或目录链接不构成可复用证明。

## history_context

- current_design_refs：正式 Stateless Workers/DO 设计、runtime README。
- relevant_evolution：云 builder 无新式 V8 缓存，但保有 Rust cache；需要使用验真的增量复用路径。
- superseded_refs：仅 fork commit 相同不足以证明内嵌 bridge 源码相同。

## acceptance

- 真实 offline Cargo 图证明客户端、协议、普通依赖及构建依赖变更都拒绝。
- 纯 Engine 与开发依赖变更允许；执行位、workspace 契约、缺失根和越界/目录链接拒绝。
- 项目自身AGENTS文件链接同时绑定树内目标内容与执行位，不能仅hash链接文字。
- 完整脚本对子进程容器边界的拒绝发生在旧镜像读取、stage 输出及收据之前。
- 实际工程 metadata 可解析，聚焦 Python、Bash、文档及 impact 门禁通过。

## affected_paths

- runtime 复用脚本、新校验器和永久测试。
- runtime README、正式设计、此 Task 与 catalog。

## required_context

- 路由返回 upstream-subtrees、agent-gateway-runtime、control-plane-ops、service-sandbox、release-gitops。
- cells AGENTS、fleet README、根工程规范和发布邻接。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@5d181cff | 根契约 | 单任务 revision、源码和发布分离 |
| docs/context/project/upstream-subtrees.md@5d181cff | 路由 | mono2唯一写源 |
| docs/context/domains/agent-gateway-runtime.md@5d181cff | 路由 | 不把局部证据代替真实请求路径 |
| docs/context/project/services/ctl.md@5d181cff | 路由 | CTL与本任务无变更交集 |
| docs/context/project/services/sandbox.md@5d181cff | 路由 | 实例池与本任务无变更交集 |
| docs/context/domains/release-gitops.md@5d181cff | 路由 | Git不等于发布 |
| docs/context/project/adjacency/argocd-ci-secrets.md@5d181cff | 发布邻接 | 验真已有构建与部署邻居 |
| minisandbox/CLAUDE.md@5d181cff | 工程规范 | 新任务前jj new，真实子进程 |
| minisandbox/infra/cells/AGENTS.md@5d181cff | 云契约 | 原周期结束前不发布 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@5d181cff | 资格边界 | 保留严格容量失败事实 |
| minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_prepare_stage.py@5d181cff | 测试邻居 | 保留缓存与fresh stage合同 |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/api.yaml@5d181cff | 部署邻居 | 不改API或HPA |

## evidence

- 先创建独立jj revision；锁定 fork 从仓库内 bundle 离线读取，无网络或 C++ 编译。
- 旧脚本真实 Cargo/完整 shell 边界反例失败：changed compiled client reached container reuse。
- 新七项初版回归通过，覆盖四种编译源码变更和容器读取前拒绝；不mock库模块。
- 实际工程发现AGENTS指向CLAUDE的合法文件链接，改为同时hash树内目标内容与执行位，补充两个真实文件边界测试；不跳过文件或忽略校验。
- 最终source/stage/cache/closure共22项通过4.367秒；实际workspace自比对及与现行Runtime源commit的完整stage/生产依赖比对均通过。
- 真实Runtime stage收据表明旧二进制经多层复用；当前源码等价不替代实际compiled-origin审计，发布前继续追溯，不默认批准旧链。
- 原脚本单项反例0.083秒失败，明确见证客户端变更仍进入容器命令，不把预期失败当作测试通过。
- 容器命令使用独立子进程见证，不执行真实 buildah 或访问 registry。
- 外部日志 `/data/tmp/minisandbox-stage-reuse-rust-closure-{before,final}-20261002.log`。

## risks

- 未配置已验证 offline Cargo sources 时拒绝，不自动联网补 graph。
- Cargo直接根绑定已审阅fork tree；未知新fork两份相同也拒绝，必须fresh stage并审阅新bridge根，不能遗漏未来新增直接依赖。
- 树内文件链接同时hash目标；越界/目录链接拒绝，避免只比较link文字遗漏目标内容。

## validation

- 本地完整22项 source/stage/cache/closure回归与两份真实工程源码校验通过；均未编译C++。
- Bash syntax、Python编译、diff及七路径impact通过；文档errors/warnings为空，Context仅原有基线问题，无新增。
- Context audit 33项通过；根Context测试仍有四项既有失败，未绕过或改写基线。

## decisions

- Cargo提供图解析，不手写TOML解析，不新增Python包或要求tomllib。
- 同时覆盖本地普通和构建依赖，不把Depot服务端开发依赖放入静态bridge指纹。
- 校验源依赖而非相信image revision标签；stage输出receipt保持原schema。

## scan_scope

- runtime脚本、锁定fork bridge Cargo/构建recipe、客户端和协议manifest。

## scan_output

- 当前候选未改三项客户端生产package，六项固定stage输入与现行Runtime源也相同。
- 动态闭包门禁防止未来客户端修改错复用，不声称当前11次transport retry由该缺口引起。

## handoff

- 局部修复准备正常master push；原缩容仍占操作锁，未执行云构建、materialize或发布。
- 全目标仍缺修复发布、fresh strict10k、Router性能和百万dormant实跑；不标记完成。
