---
id: opencraft-entry-preview-2026-09-16
type: task
scope: 在 mono2 根和 OpenCraft 局部入口说明开发与隔离桌面预览。
triggers: ["OpenCraft entry", "OpenCraft preview", "OpenCraft AGENTS"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - AGENTS.md
  - README.md
  - opencraft/AGENTS.md
  - opencraft/docs/build-matrix.md
status: active
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal

让开发者与 Agent 从 mono2 根入口正确找到 OpenCraft 源码、平台边界及不会覆盖现有窗口的 macOS 预览流程。

## non_goals

- 不改变应用运行时、发布或生产部署。
- 不把完整 OpenCraft 架构复制进根 AGENTS。

## requirement_refs

- requirement_ids: unknown；本次只有对话请求，没有 TAPD/Issue 标识。
- 用户要求根 `AGENTS.md`、`README.md` 写入 OpenCraft 玩法，并补强 `opencraft/AGENTS.md`；同时要求从最新 master 新建分支并启动预览。
- requirement_excerpt: “把 opencraft 玩法，写入 mono2 根的 AGENTS.md 和 README.md，同时补强 opencraft 子目录的 AGENTS.md”。

## interface_refs

- `opencraft/package.json` 的 `dev:web`、`package:electron:mac:arm64:preview`。
- `opencraft/docs/build-matrix.md` 定义产物和平台边界。
- data_structure_refs: 本任务不改变协议或数据结构；只记录工作树、产物和 URL scheme 归属。

## history_context

- current_design_refs: `docs/context/decisions/ADR-0001-context-engineering-v2.md`、`opencraft/docs/build-matrix.md`。
- relevant_evolution: OpenCraft 已迁入 mono2；旧独立仓库的 clone 命令不是当前开发入口。
- superseded_refs: 旧 `wisp/opencraft` clone 命令只作迁移历史，不再是开发入口。

## acceptance

- 根入口能定位 OpenCraft；README 的命令对应实际脚本且不复用用户 profile；局部 AGENTS 描述 owner、参考边界和验收。
- 独立 master 预览产物通过签名验证并在实际 Electron 窗口加载；登录回调须另行确认 URL scheme 的实际应用归属。

## affected_paths

- `AGENTS.md`、`README.md`、`opencraft/AGENTS.md`、`opencraft/README.md`、本 Task Pack 与 Context ADR。

## required_context

- Context router 对本任务无匹配 Pack；使用根入口、OpenCraft 局部入口及构建矩阵作有界事实来源。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 根指令真源 | 保持短入口 |
| `README.md` | 人类入口 | 安放运行命令 |
| `opencraft/AGENTS.md` | 服务局部增量 | 不重复根边界 |
| `opencraft/docs/build-matrix.md` | 预览产物契约 | 验证命令与隔离策略 |
| `docs/context/decisions/ADR-0001-context-engineering-v2.md` | 指令分层决策 | 回写新入口的权威关系 |

## evidence

- 新分支基于 `origin/master@ae2fbe828`；隔离 arm64 `.app` 已打包、`codesign --verify --deep --strict` 通过，Electron CDP 显示 OpenCraft 页面。
- 实机登录观察：LaunchServices 将 `opencraft://` 解析到另一份同 Bundle ID 预览，其主可执行文件缺失、签名无效；本次预览本身的签名通过。说明窗口启动与 OAuth 回调是两条独立验收链。
- 用户同意后另打了独立 Bundle ID 的预览；该包主程序、签名和新 profile 均正常，登录事务已启动。旧式 LaunchServices 设置与 Apple 的路径级默认应用接口均返回成功，但实际 URL 解析仍指向其他损坏预览。只注销两条精确命中的损坏应用登记后，又选中第三条缺少主程序的旧登记；按有界排查约定停止，未做全局注册库重建或批量清理。
- `validate_documentation.py --format json` 为 0 错误/0 警告；`validate_change_impact.py` 指定本轮路径通过。Context catalog 已重建，新 Task Pack 无自身校验错误；全仓 Context 仍有既有错误，未将其宣称为本轮通过。

## risks

- `release/preview` 会被打包脚本重建；README 要求隔离工作树。新 profile 不复制用户登录或模型凭据。
- 多份预览共用 URL scheme 时，系统回调可能落入损坏或过期的其他 `.app`；仅提供只读归属检查，不自动更改全机协议注册。
- 单纯多开锁只能限制并发事务，不能让 macOS 启动已损坏的 URL 处理者；后续修复须先明确稳定回调入口或经批准的精确注册清理策略。

## validation

- Markdown 路径/命令复核，Context/文档校验，Git diff 检查；实际预览窗口与源码 revision 对照。

## decisions

- 根 AGENTS 保持路由；README 放可执行玩法；局部 AGENTS 放 OpenCraft 专属增量；正式技术细节回链现有文档。

## scan_scope

- `AGENTS.md`、根与 OpenCraft README、局部 AGENTS、构建矩阵、当前 package scripts；未扫描参考仓库正文。

## scan_output

- 当前包脚本确认 `dev:web` 与 `package:electron:mac:arm64:preview`；未引入新的运行时扫描产物。

## handoff

- 文档改动已通过聚焦检查，尚未提交或推送。预览保持在独立 profile；系统浏览器 OAuth 回调的实际处理者仍不是本次 `.app`。独立 Bundle ID 与精确注销两条损坏登记均未收敛，未继续扩大系统修改；稳定回调入口需要单独设计/授权。预览不是生产发布。
