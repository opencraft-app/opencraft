---
id: product-skill-subtree-sync-runbook
type: runbook
scope: 在 mono2 编写 LightVela Product Skills，并将 owner 审阅的 subtree 同步至 product-ai。
triggers:
  - product skills
  - product-ai
  - subtree sync
owner: mingyuxiao
authority: primary
source_of_truth:
  - .agents/skills/product-skills/SKILL.md
  - .agents/skills/product-skills
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: false
---

# Product Skills Subtree 同步

## 归属

- mono2 `master` 的 `.agents/skills/product-skills` 是唯一编写来源。
- `TencentLightCloud/product-ai` 的 `skills/lightvela` 是下游分发副本。绝不先在那里编辑，也绝不回拉覆盖 mono2。
- 本地工作时从当前 mono2 分支读取 Skill。网络或权限失败只阻塞下游刷新，不会使本地来源失效。

## 同步

1. 在 mono2 完成并验证 Skill，包括每个引用文件和 eval fixture。
2. 从当前 mono2 `master` 运行 `git subtree split --prefix=.agents/skills/product-skills`，并保留 split commit。
3. 从干净的 product-ai 分支或隔离 worktree 将 split 历史合并至 `skills/lightvela`。
4. 在下游同步 commit 中记录 `git-subtree-dir`、`git-subtree-split`、`Original-upstream-repo` 和 `Original-upstream-path`。
5. 逐字节比对两个 subtree 根，验证每个 `SKILL.md` frontmatter，并在 fixture 存在时运行 `python3 -m json.tool .agents/skills/product-skills/prd-creator/evals/evals.json`。

不得手工复制目录，也不得将无关脏变更混入任一仓库。Commit、push 和创建 MR 仍是需要用户明确授权的操作。
