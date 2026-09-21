---
id: adjacency-product-skill-root-command
type: project
scope: Product Skill 权威来源、根入口约束和下游同步命令之间的共同变更邻接。
triggers:
  - product skill
  - skill 同步
  - subtree command
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - AGENTS.md
  - .agents/skills/product-skills/SKILL.md
  - docs/context/runbooks/product-skill-subtree-sync.md
status: active
reviewed_at: 2026-08-27
review_due: 2026-11-25
revision: 1.0.0
precedence: project
derived: true
related_packs:
  - product-skill-sync
---

# Product Skill、根入口与命令邻接

## 当前实现锚点

- 根 `AGENTS.md` 是仓库级 P0 边界和 Context 路由入口；Product Skill 的编写真源在 `.agents/skills/product-skills/`。
- `docs/context/runbooks/product-skill-subtree-sync.md` 规定 mono2 是上游来源以及下游 subtree 同步前后的验证边界。
- Skill 内容、根入口触发词和同步命令属于不同层：改动任一层时，必须检查另两层是否仍指向同一个权威源。

## 适用触发

Product Skill、skill 同步、subtree、根 AGENTS、命令入口、Skill 验证或下游分发。

## 必查邻居

1. 在 `AGENTS.md` 和 `.agents/skills/product-skills/SKILL.md` 精确搜索受影响的 Skill 名称或触发词。
2. 检查具体 Skill 的 `SKILL.md`、引用资源和评测 fixture（若存在）。
3. 检查同步 Runbook 中的上游路径、验证命令和授权门禁；不得在未授权时执行分支、commit、push 或 subtree 写操作。
4. 若命令契约变更，检查其调用方/文档入口，而不是只修改 Skill 正文。

## 验证命令

```bash
rg --max-count 50 "<Skill 名称或触发词>" AGENTS.md .agents/skills/product-skills docs/context/runbooks
```

命中后读取一个具体 Skill/资源邻居和一个根入口或 Runbook 邻居；同步操作仍需用户单独授权。

## 失效条件

若 Product Skill 上游目录、根入口契约、下游同步方式或命令入口迁移，本卡需按新权威来源重写后才能继续使用。
