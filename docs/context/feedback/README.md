---
id: context-feedback-index
type: feedback
scope: context 失败与改进证据的接入 contract。
triggers: ["context failure", "feedback", "improvement"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/context/feedback/README.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: true
---

# Context 反馈

每种失败模式创建一个文件。必填字段：

- task 和日期
- 精确 query 或路径
- 预期 route 或事实
- 实际 route 或输出
- 证据路径
- 原因：rule、route、content、tool、model 或 evaluation
- 修复目标
- 验证结果

未写明修复目标的反馈只是观察，不是已接受的 context 改进。
