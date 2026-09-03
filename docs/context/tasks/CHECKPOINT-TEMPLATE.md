---
id: task-checkpoint-template
type: task
scope: Structured compaction and recovery state for an active task.
triggers: ["checkpoint", "compaction", "context recovery"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - docs/context/tasks/CHECKPOINT-TEMPLATE.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: task
derived: false
---

# Task Checkpoint 模板

```markdown
## stage
当前阶段与下一道门禁。

## verified
- 有证据支持的事实。

## unverified
- 未决问题与所需的精确检查。

## discard
- 过期扫描输出、已被替代的选项与不再相关的文件。

## restore
- 安全续接所需的文件与事实。

## next_action
- 一个具体行动。
```
