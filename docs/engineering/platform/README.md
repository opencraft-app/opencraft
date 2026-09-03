# 平台与上游治理

## 基础设施与交付

- `infra_pulumi/`：云资源、环境 inventory 和 deploy 输出的唯一一方 infra 控制面。
- `.ci/`：服务流水线、镜像/runtime artifact 构建与 GitOps 晋级命令。
- `argocd/`：deploy-facing 期望状态和 Argo Application。
- `codesign/`：代码签名、EdgeOne 等受控外部平台的操作知识。

平台事实分三类：仓库期望、外部控制面实时状态、运行态业务证据。文档必须标明是哪一类，不能用 Pulumi preview 或 GitOps diff 冒充已 apply/已上线。

## Upstream/Subtree

`new-api`、`velagw`、`velalink` 以及 CloudAgent 下的部分研究/上游目录保留来源和 pin。维护原则：

1. 上游正文由上游拥有，mono2 不做全量中文化或重写。
2. 本仓库记录版本、导入方式、本地 patch、消费方和同步验证。
3. 本地集成 commit 与 subtree 同步 commit 可分离。
4. 更新上游行为时同时验证 mono2 consumer；构建成功不代表已发布。

## 产品文档平台

客户文档由 `frontend/src/content/docs/` 提供区域源，生成层由前端内容管线维护。产品文档 Skill 约束 cn/global/en/id 与 zh-cn/zh-sg/en-us/zh-hant/id-id 映射；工程文档只描述边界，不复制客户正文。
