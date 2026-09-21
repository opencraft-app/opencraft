---
id: model-base-url
type: task
scope: 修复模型基础地址与操作地址混淆导致的重复路径和 404
triggers:
  - opencraft
  - base-url
  - model-404
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/local-agent-custom-providers.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

# 模型基础地址

## requirement_ids

- model-base-url

## requirement_refs

- 当前用户在确认重复路径根因后要求整改。

## requirement_excerpt

“404 404 page not found 是啥情况？”、“整改吧”。

## goal / non_goals

明确 Base URL 文案和统一校验，修正已确认的“11”地址。保留凭据与模型；不发付费模型请求，不批量截断其他地址，不提交发布。

## context_receipt

- opencraft/AGENTS.md
- opencraft/docs/local-agent-custom-providers.md
- opencraft/design/model-configuration.md
- 实际 SDK 的 baseURL 加 /chat/completions 路径拼接实现

## acceptance / validation

检查操作后缀、尾斜杠、合法部署前缀；后端拒绝时没有凭据或网络写入；UI 无效提示及禁用保存，完整门禁和预览。

## checkpoint

阶段：完成。统一 Base URL 校验及界面说明已接入，操作后缀/尾斜杠拒绝、合法网关前缀保留、保存/探测/发现拒绝前无凭据或模型请求写入测试通过；产品模型 UI smoke 和完整 gate 通过。

真实“11”的基础地址已从 https://tokenhub.tencentmaas.com/v1/chat/completions 修正为 https://tokenhub.tencentmaas.com/v1，严格匹配原 provider ID/地址并使用 revision/CAS。修改前备份保存在 `.opencraft/migration-backups/b9b4d0bf-f05b-4367-b6f6-8b320df74815/models.json`；未修改凭据或其他模型。

最终产物 `opencraft/apps/workbench-electron/release/model-base-url-preview/mac-arm64/OpenCraft Preview.app` 已构建、校验签名并打开；实机字段文案正确、值为基础地址、aria-invalid=false，截图 `/tmp/opencraft-base-url-native.png`。没有请求真实模型服务，因此不声称已验证上游推理成功。文档与 diff 检查通过，未提交、推送或发布。
