## goal

将独立 `/data/minisandbox` 仓库当前已验证源码以 squash-style Git subtree 导入 mono2 的
`minisandbox/` 前缀，并留下可复现的上游身份与后续同步流程。

## non_goals

- 不发布 minisandbox，不修改 Argo、生产集群或云资源。
- 不改写 minisandbox 上游工作区或历史。
- 不导入运行日志、凭据或构建产物。
- 不把现有 mono2 `sandbox/` 与新导入的 `minisandbox/` 合并。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求（2026-10-02）：先把目前的代码 subtree 到 mono2。

## interface_refs / data_structure_refs

- subtree prefix：`minisandbox/`
- 上游源码 commit：`fc637a82b717e3d5a664154e93341e0bc6a29679`
- 安全快照 commit：`777fae776a30051f1112c6b5b54f17d63e086e31`
- 排除路径：`coscli.log`（误跟踪的运行日志，命中真实凭据格式，不属于源码）。
- 不变量：除明确排除路径外，导入 tree 必须与上游源码 commit 完全一致；mono2-only provenance
  文件单独提交。

## history_context

- `current_design_refs`：`docs/context/project/upstream-subtrees.md`
- `relevant_evolution`：mono2 已对多个独立仓库使用 squash-style subtree 或一次性 subtree 迁移。
- `superseded_refs`：无。

## acceptance

- `git subtree add --prefix=minisandbox ... --squash` 生成带标准 subtree trailer 的提交。
- 上游 commit tree 排除 `coscli.log` 后，与导入的 `minisandbox/` tree 完全一致。
- 待推分支的 reachable history 不包含 `coscli.log`。
- `minisandbox/.mono2-subtree` 和 `minisandbox/MONO2_SUBTREE.md` 固定源码 commit、快照 commit、
  prefix 与同步边界。
- mono2 context/documentation 门禁通过；原 `/data/mono2` 脏工作区保持不变。

## affected_paths

- `minisandbox/`
- `docs/context/project/upstream-subtrees.md`
- `docs/context/tasks/2026-10-02-import-minisandbox-subtree.md`

## required_context

- `upstream-subtrees`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@b5996514e` | mono2 根级安全、Context 与提交约束 | 使用隔离 worktree，不触碰生产或已有脏改动 |
| `docs/context/project/upstream-subtrees.md@b5996514e` | subtree 权威规范 | 采用 squash、保留精确 commit 与验证证据 |
| `docs/context/tasks/TASK-TEMPLATE.md@b5996514e` | Task Pack 结构约束 | 记录目标、证据、风险和交接 |
| `velagw/MONO2_SUBTREE.md@b5996514e` | 已有 subtree 邻近实现 | 复用 trailer、split 与 release boundary 写法 |

## evidence

- 待补：安全快照、subtree import commit、tree comparison、敏感模式扫描和 context validation。

## risks

- 导入体量较大：使用 squash 避免把完整独立历史注入 mono2。
- 旧 tree 误跟踪凭据日志：通过临时 Git index 生成无父提交的安全快照，不读取或修改原文件；
  subtree 只引用安全快照。
- mono2 主 worktree 有无关未提交文件：从最新 `origin/master` 创建隔离 worktree 和独立分支。
- `sandbox/` 与 `minisandbox/` 名称相近：使用独立顶层 prefix，禁止隐式合并。

## validation

- `git diff --check`
- 上游减去明确排除路径后的 tree manifest 比较
- reachable history 路径检查与有界敏感模式扫描
- `python3 .agents/context/scripts/validate_context.py --build-catalog`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions

- 采用 `minisandbox/` 顶层 prefix，与仓库名一致且不改变现有 `sandbox/` 所有权。
- 采用 squash-style subtree，与 mono2 已有上游同步策略一致。
- 旧仓库无 remote；导入后 mono2 为源码真源，不编造上游地址。

## scan_scope

- `docs/context/project/upstream-subtrees.md`
- `velagw/MONO2_SUBTREE.md`
- minisandbox tracked tree（明确排除 `coscli.log`）

## scan_output

- 有界命令输出记录在本任务的 Git commits 与最终交接中；不输出命中的敏感值。

## handoff

- 当前状态：准备从安全快照导入。
- 下一步：提交 Task Pack、执行 subtree add、添加 provenance overlay、验证并交接分支。
