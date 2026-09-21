---
id: external-knowledge-boundaries
type: project
scope: 仓库事实与外部云或产品 authority 之间的边界。
triggers: ["external knowledge", "cloud API", "billing", "CAM", "FaceID"]
owner: mingyuxiao
authority: external
source_of_truth:
  - .agents/context/external-sources.yaml
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: external
derived: false
---

# 外部知识边界

仓库 context 记录 LightVela 如何消费外部 contract，不复制权威的外部规则。

| 主题 | 仓库边界 |
|---|---|
| 腾讯云计费 | 产品消费、本地订单状态和展示行为 |
| 腾讯云 API | 客户端集成、请求/响应映射和测试 |
| CAM | 所需 key 名和最小权限意图，不是策略 authority |
| FaceID | 本地 attempt/session 处理和回调消费 |

外部事实必须引用 `.agents/context/external-sources.yaml` 中登记的 authority。若 authority 不可用，应将任务事实标为未验证，而非复制 AI 生成的近似内容。
