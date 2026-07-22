# Gongfeng MR And Product Review Flow

读取时机：PRD 定稿后需要提交 mono2 工蜂 MR，或需要推进产品评审状态时读取本文件。

## 提交 PRD 到工蜂 MR

PRD 已定稿、Demo/原型说明已补齐且 TAPD 父单已创建或复用后，必须把 PRD 提交到 mono2 远端工蜂仓库的 MR。这个步骤是产品前置的完成门禁，不是可选建议；仅写出本地 Markdown、仅创建 TAPD、仅提交 commit 或仅 push 分支都不算完成。

### 准备干净、可审查的分支

- 先读取仓库根 `AGENTS.md` 和 `.agents/skills/gongfeng/SKILL.md`，遵守仓库的分支、提交、敏感信息和工蜂调用约定。
- 确认目标仓库是 `git@git.woa.com:wisp/mono2.git`，目标分支是最新 `origin/master`。默认使用 `codex/prd-<short-title>` 作为来源分支。
- 先检查 `git status`。如果当前工作区存在与本次 PRD 无关的修改，基于最新 `origin/master` 创建独立 worktree，不得 stash、覆盖、提交或夹带用户的其他改动。
- 默认只纳入本次目标 PRD：`product/prd/YYYY-MM-DD-<short-title>.md`。只有当前需求明确要求同时修改产品 Skill 或直接相关文档时，才能把这些文件一并纳入同一 MR。
- 如果 TAPD 父单已经创建，把其完整详情链接保留在 PRD 中，并在 MR 描述或 `tapd_info` 中关联对应 TAPD 短 ID。

### 提交前必须展示并等待确认

`git commit`、`git push` 和创建 MR 都属于不可逆操作。执行前必须一次性向用户展示：

- 来源分支、目标分支。
- 将提交的文件列表和 diff 摘要。
- 完整 commit message。提交信息遵守仓库 Lore Commit Protocol，意图行使用“中文在前 + English supplement after”。
- MR 标题、描述摘要、TAPD 关联信息。

展示后明确等待用户确认。一次确认可以覆盖本次已经完整展示的 commit、push 和 MR 创建动作；用户尚未确认时，只能保留本地文件和分支，不能先行提交或推送。

### 确认后提交并创建 MR

- 在调用工蜂写操作前，先按 Gongfeng Skill 调用 `get_current_user` 验证鉴权。未鉴权时只索要或修复工蜂个人 Token，不得把 Token 写入仓库文件、提交信息、MR 描述、日志或最终回复。
- 只暂存已展示的范围，运行 `git diff --check`，并检查 `git diff --cached --name-only` 没有无关文件。
- 创建 Lore commit，推送来源分支，然后通过 Gongfeng 创建目标为 `master` 的 MR；已有 TAPD 时附带 `tapd_info`，例如 `--story=<TAPD 短 ID>`。
- 创建后按来源分支查询 MR，核对真实 MR 编号、标题、来源/目标分支和可访问链接，再把编号与完整链接主动发给用户。
- push 成功不等于 MR 创建成功。如果创建接口报错，先按来源分支查询是否已经创建，避免重复 MR；确认不存在后再重试或如实报告阻塞原因。

### MR 创建后的增量更新

产品评审或 TAPD 回写导致 PRD 变化时，继续更新同一文件、同一来源分支和同一 MR，不要另建重复 PRD 或重复 MR。每次新增 commit/push 前仍需重新展示本轮变更并获得确认。

## 推进产品评审

当 PRD 和验收标准准备好后：

- 更新父单描述。
- 用户确认后，把父单移动到评审中等价状态。
- 产品评审通过后，再移动到已通过等价状态。

产品完成只表示产品前置阶段完成，不表示功能已经上线。
