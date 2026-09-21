---
id: tapd-gongfeng-delivery-flow
type: flow
scope: 解析 TAPD 标识，并以明确的失败与授权门禁交付分支和合并请求。
triggers:
  - tapd delivery
  - merge request
  - gongfeng
owner: mingyuxiao
authority: primary
source_of_truth:
  - .agents/skills/gongfeng/SKILL.md
  - docs/context/flows/change-delivery.md
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: false
---

# TAPD 与 Gongfeng 交付

## 标识 contract

LightVela TAPD workspace 是 `10132091`。API 对象 ID 为完整 19 位 ID；UI 链接可能展示 8 或 9 位短 ID。API 调用前按 workspace contract 解析短 ID，并在 Task Pack 保留用户原始链接。不得猜测对象类型，或静默改用另一 workspace 重试。

## 交付门禁

1. 需求读取是只读操作。`stories_get` 或 `bugs_get` 失败时，依赖该需求的工作应阻塞，直至修正 ID 或凭据。
2. 创建分支、commit、push 和创建 MR 都是写操作，需用户明确授权。
3. 创建分支或 `create_merge_request` 失败是阻塞性失败。可选 label 或 TAPD 分支关联失败记为 warning，且不得重写 Git 历史。
4. 需要 Gongfeng 访问时，读取 `.agents/skills/gongfeng/SKILL.md` 并采用其中支持的命令路径。绝不在命令、输出或文档中暴露 access token。
5. 只有目标分支、commit、MR URL 和必需检查均可观测时，交付才完成。本地 commit 不是 MR；MR 不是发布。

Commit 和 MR 文本必须遵守当前团队级指令。不得添加 generated-by 水印或未经请求的 reviewer/notification。
