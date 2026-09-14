---
id: product-model-storage
type: task
scope: 将模型配置所有权从 DSH 收回 OpenCraft 并固定持久化位置
triggers:
  - opencraft
  - models-json
  - replaceable-engine
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/design/model-configuration.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

# 产品模型配置仓库

## requirement_ids

- product-owned-models-json

## requirement_refs

- 当前用户明确指定 ~/.opencraft/models.json，并纠正 DSH 只是可替换引擎，文件必须由 OpenCraft 自己写。

## requirement_excerpt

“DSH只是一个可替换引擎”、“搞起来”。

## goal / non_goals

产品自有文件格式、读写、校验、CAS、原子保存与独立凭据存储，DSH 仅作为应用配置的适配器。保留现有操作并验证换运行目录后恢复。不得把 DSH 设置文件换名，不迁移登录或会话历史，不提交发布。

## history_context

此前用户配置已经存在临时 profile 的 settings.yaml 中，多个测试 profile 造成看似丢失。错误的 DSH 文件路径接线已撤销，真实数据尚未迁移。新方案由通用产品仓库和可替换端口拥有真源，旧 runtime 命令保留兼容投影。

## context_receipt

- opencraft/AGENTS.md
- opencraft/.agents/skills/opencraft-maintenance/SKILL.md
- opencraft/docs/local-agent-custom-providers.md
- opencraft/docs/build-matrix.md
- ref/wb/packages/workbuddy-app/src/adapter/workbuddy-agent-adapter-next.ts
- 当前 DSH settings/credentials 文件提供器及公开 patch 配置结构（只作适配与迁移依据）

## acceptance / validation

中性 schema 无 DSH 字段和明文 Key、替代引擎端口读取不变、引擎失败不丢配置、并发 CAS、迁移不覆盖、真实 DSH 换运行目录重启恢复。完整 gate、隔离 UI 和实际 Mac 预览。

## checkpoint

阶段：完成。产品仓库/迁移/失败保留与替代引擎端口测试 3 项通过，结合既有 provider 用例共 26 项聚焦验证通过。最终源码完整 gate 通过；真实 DSH 两次启动、不同运行目录共用产品目录，提供商/模型/默认选择恢复通过。产品仓库后端的完整模型 UI smoke（增删改、保存取消、启停、默认、发现、检查、主题、窄屏）通过，仅使用合成凭据和本地测试端点。

经只读核对目标原先不存在，从 `/tmp/opencraft-provider-list-switch.yqsQpA/dsh` 一次性导入用户“11”到 `/Users/skipzhang/.opencraft/models.json`，模型 deepseek-v4-pro-202606 和 enabled=true 保留；API Key 仅迁入独立 credentials.json，两个文件权限均 0600。旧目录不动，迁移备份位于 `.opencraft/migration-backups/`，没有覆盖其他 profile 或混入测试连接。

最终 Mac arm64 产物 `opencraft/apps/workbench-electron/release/product-model-store-final-preview/mac-arm64/OpenCraft Preview.app` 构建、签名校验和实机验证通过。使用另一个运行 profile 再启动仍读取同一固定文件，聊天菜单真实显示用户模型；截图 `/tmp/opencraft-product-model-store-final.png`。引擎应用失败阻止新 turn；派生引擎凭据的清理不删除产品凭据。文件不会反向读取 DSH 私有状态作为真源。

文档校验 errors=[]、git diff --check 通过；staged 影响检查因空暂存集仅作记录。未提交、推送或发布。未实现其他真实引擎，替换端口由无 DSH 的测试适配器验证；旧 UI 协议投影仍由 DSH 兼容适配器承接。后续请使用新版，旧二进制仍读取旧 profile，不能把旧窗口修改视为新产品仓库的写入。
