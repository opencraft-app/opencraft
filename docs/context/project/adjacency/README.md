---
id: implementation-adjacency-index
type: project
scope: 代码定位任务中用于发现共同变更邻居的轻量索引，必须在路由和精确搜索之后按需使用。
triggers:
  - implementation adjacency
  - 共同变更
  - 定位邻居
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - docs/context/project/adjacency
  - .agents/context/context-routing.yaml
status: active
reviewed_at: 2026-08-27
review_due: 2026-11-25
revision: 1.0.0
precedence: project
derived: true
---

# 实现邻接卡索引

本目录不替代源码定位，也不是默认注入内容。处理历史改动、修复或文件定位时，先完成路由、读取所有 `must_read`，并在路由约束的目录执行有界精确搜索；随后只选择一张与当前边界相符的卡，检查卡内列出的一个非 Context 邻居。

| 卡片 | 适用边界 |
|---|---|
| [Argo、CI 与 Secret](argocd-ci-secrets.md) | 镜像交付、GitOps manifest、密钥引用与发布验证 |
| [CloudLadderGateway](cloudladdergateway.md) | 计费代理的 Proto、配置、运行时和测试 |
| [前端运行时与 i18n](frontend-runtime-openspec-i18n.md) | 页面行为、运行时配置、OpenSpec、翻译生成物与测试 |
| [Product Skill、根入口与命令](product-skill-root-command.md) | Product Skill 权威来源、根约束和同步命令 |

卡片是“下一处应核验什么”的通用提示。它们不包含评测数据、模型答案、Gold、分数或实验结果；发生目录迁移、入口替换或验证命令失效时，应按各卡的失效条件更新。
