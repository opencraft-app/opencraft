---
id: upstream-subtrees
type: project
scope: 保留 NewAPI、LLMGateway、VelaLink 的上游归属，以及 OpenCraft 一次性迁移的 subtree 历史与所有权边界。
triggers:
  - upstream subtree
  - velalink pin
  - new-api sync
owner: mingyuxiao
authority: primary
source_of_truth:
  - new-api/MONO2_SUBTREE.md
  - velagw/MONO2_SUBTREE.md
  - velalink/MONO2_SUBTREE.md
  - opencraft/MONO2_MIGRATION.md
status: active
reviewed_at: 2026-09-22
review_due: 2026-11-23
revision: 2.2.0
precedence: project
derived: false
---

# 上游 Subtree

## 边界

`new-api/`、`velagw/` 和 `velalink/` 保留持续上游谱系。其 `MONO2_SUBTREE.md` 定义权威 remote、prefix、同步方向和本地 overlay 策略。`opencraft/` 的上游只保留一次性导入谱系；导入后 mono2 是唯一写入真源，不建立双向同步。公开 GitHub 仓库 `opencraft-app/opencraft` 只接受经过审计的 `subtree split` 单向镜像，不反向 pull，也不授权双写。变更导入、镜像或历史前读取对应文件。

- 不得以文件拷贝替代 subtree 更新、squash 掉必要谱系，或从目录内容推断上游 ref。
- OpenCraft 镜像只导出干净、已提交、敏感信息扫描通过且 tree hash 与源目录一致的历史；公开邮箱重写仅发生在临时导出历史，不修改 mono2 或其他贡献者元数据。
- 保持仅 mono2 的部署、集成或兼容变更与上游代码可区分。修复属于上游时，记录上游变更和 mono2 消费它所需 pin/update。
- 供 `frontend/` 使用的 VelaLink 导出，只有在 consumer 依赖或 pin 更新且前端 build/type 门禁证明解析到预期产物后才完成。
- 绝不从含无关变更的脏 worktree 同步。上游历史操作会混合 scope 时使用隔离 worktree。

## 证据

记录前后上游 commit、subtree 命令、本地 overlay diff、变更 consumer pin 和聚焦验证命令。网络或权限失败必须报告为未完成同步，不能报告为本地更新成功。
