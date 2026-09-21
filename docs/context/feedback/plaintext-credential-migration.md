---
id: feedback-plaintext-credential-migration
type: feedback
scope: 防止长本地指令迁入正式 context pack 时保留明文凭据。
triggers: ["plaintext credential", "context migration security", "secret scanning"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - AGENTS.md
  - docs/context/project/services/velagw.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-09-04
revision: 2.0.0
precedence: project
derived: true
---

# 反馈：明文凭据迁移

- Task 和日期：context-engineering V2 重构，2026-08-25。
- 预期行为：迁移保留持久的运维边界，但删除密码、token、私钥、已解密值以及输出它们的命令。
- 实际行为：已有服务指令含明文 operator 凭据；第一次文档迁移将其保留在正式 Project Context 文件。
- 证据：对 `docs/context/project/services/` 扩展凭据模式扫描，在迁移的 VelaGW 详情中发现字面凭据赋值。
- 原因：`content`；迁移把旧的受跟踪文档当成可信文案，未对每个抽取段落实 Team 级 secret 边界。
- 修复：移除所有字面值和 decode/print 命令，仅保留 Secret resource/key 引用及非 secret 验证证据，并把凭据扫描纳入最终 context 门禁。
- 验证：运行时 context 文件不再含长十六进制凭据、私钥 marker 或字面密码赋值。
- 外部动作：这些值在本次重构前已存在于仓库历史，凭据 owner 必须另行评估轮换；本任务不变更集群或凭据存储。
