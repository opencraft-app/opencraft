# TMR 输出契约

TMR（Context Readiness & Remediation Report）是 Repository Assessment、建设规划和最终复核的交付格式。JSON 用于机器处理，Markdown 用于评审，单文件 HTML 用于分享；三者和 Assessment/回执均默认写入仓库外本地目录或仓库已忽略路径。

## 报告阶段

| 阶段 | 数值分 | 必须表达 |
|---|---|---|
| 陌生仓 discovery | `null` | “待 Agent 语义评审”；候选资产、Git 可用性和 Assessment 模板；不展示 0 分 |
| 定性 Assessment | `null` | 画像、observation 状态、证据/局限、P0/P1/P2 和建设规划；有 `unknown` 就标出空白 |
| 可点分 Assessment | number | 脚本推导的双百分制、维度分、门禁和证据等级理由 |
| 建设后复核 | number/null | 每轮变化、新证据、剩余缺口和完成边界；仍遵守可点分门禁 |

## 必须包含

1. 仓库绝对路径、`schema_version: 3`、Assessment 范围、HEAD、`worktree_fingerprint` 和发现时点。
2. 仓库画像 `empty/underbuilt/overbuilt/managed`、rationale 和触发 signals。
3. 目标仓库的语义映射：指令、服务分母、Owner、正式知识、Agent 消费接口、路由、工作流、生命周期、评测隔离和 Validator。
4. 两套量表每维固定 4 个 required observations：`status`、`subject`、`rationale`、evidence、limitations 和对应 Finding。
5. 每个维度：为什么评、为什么占该权重、能证明、不能证明。
6. 文件证据的 path+行区间/标题/结构化键、Git 证据的 path+commit；Validator/测试回执的 claim、绝对路径、SHA-256、与 observation 内容证据相交的输入 hashes、输出 hashes 和已命中 expect selector；证据超出范围不外推。
7. P0/P1/P2 Finding，包含 observation ID、具体路径、影响和可复现检查。
8. 证据等级 A/B/C/Unknown 及脚本推导理由。
9. 有序 Action/三轮建设建议、验收条件和授权边界。
10. 未完成能力、定性/点分状态和当前门禁。

## JSON 核心形状

严格字段和 observation ID 以当前 `--write-template` 为准。报告层至少保留以下语义：

```json
{
  "schema_version": 3,
  "repository": {
    "head": "<full-commit-or-null>",
    "assessment_scope": "<reviewed-scope>",
    "worktree_fingerprint": "<sha256>"
  },
  "assessment_status": "needs_agent_review|partial|complete|invalid",
  "score": null,
  "dimensions": {},
  "documentation": {"score": null, "dimensions": {}},
  "repository_profile": {"class": null, "rationale": "", "signals": {}},
  "git_evidence": {},
  "evidence_grade": "Unknown",
  "dimension_assessments": {
    "context_control_plane": {
      "entry_routing": {
        "rationale": "",
        "observations": {
          "context.entry_routing.entry_exists": {
            "status": "unknown",
            "subject": "",
            "rationale": "",
            "evidence": [],
            "limitations": []
          }
        }
      }
    },
    "repository_documentation": {}
  },
  "findings": [],
  "actions": []
}
```

`score=null` 是证据边界，不表示 0 分。只有 required observations 全部解析且契约通过后，脚本才依 [rubric.md](rubric.md) 填入派生 level 和分数。每维的 Assessment rationale 说明综合判断；不允许输入自报 level。

## 门禁表述

```text
Context 控制面 ≥ 85 且 Context P0 = 0
AND
Repository Documentation ≥ 85 且 Documentation P0 = 0
```

- `not_assessed`：仍在 discovery/定性 Assessment，或存在 `unknown`。
- `blocked`：存在 P0；不受分数影响。
- `needs_improvement`：已可点分，无 P0，但任一量表低于 85。
- `passed`：两套分数均达 85 且两侧 P0=0。

即使 `passed`，也只能声称“当前 Assessment 范围和证据时点的上下文工程 V1 静态契约通过”。除非有对应独立证据，不声称所有正文永久正确、Agent 每次实际消费，或模型准确率/Token/费用改善。

## 回执与 Git 展示

TMR 中可显示命令、exit code、时间、范围和 digest，但 exit code 必须来自 `--record-check --claim --expect` 生成且重新校验的本地回执，不从 Assessment 手写值采信。回执必须绑定 repo、HEAD、`worktree_fingerprint`、claim、命令、受检输入 hashes、输出 hashes 和已命中的非敏感稳定输出 selector。同一 command+input hashes+output hashes+exit status+worktree snapshot 执行事实指纹不得跨 claim 复用；selector 不参与去重，避免仅改断言文本绕过。

Git 展示至少含 path 和当前 `git log -1 -- <path>` 对应的完整 commit。`git blame` 仅定位行的历史出处；Owner 仍以 CODEOWNERS、Catalog、团队制度或负责人确认为准。

## 三轮检查记录

- Check 1：Skill/Schema/报告渲染、陌生布局和四类仓型行为。
- Check 2：Observation 算术、P0/P1、Git path+commit、claim 回执、动态分母、链接和评测隔离。
- Check 3：本地 HTML/Markdown/JSON/Assessment 读回、敏感信息、证据标签、结论边界和未完成能力。
