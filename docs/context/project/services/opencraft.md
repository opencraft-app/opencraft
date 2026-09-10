---
id: opencraft-service-detail
type: service
scope: OpenCraft 多端 Agent Workbench、Chat Runtime、AppServer 适配和 LightVela Hermes 扩展的派生服务上下文。
triggers: ["opencraft", "workbench", "chat runtime", "hermes extension"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - opencraft/docs/README.md
  - opencraft/catalog-info.yaml
  - opencraft/AGENTS.md
  - opencraft/MONO2_MIGRATION.md
status: active
reviewed_at: 2026-09-10
review_due: 2026-12-09
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "identity-access", "site-environment-routing"]
---

# OpenCraft 服务 Context

命中 `opencraft/`、Chat Runtime、Workbench、AppServer 或 Hermes 扩展任务时加载；先读取最近的 `opencraft/AGENTS.md`。

## 当前边界

- mono2 是唯一代码真源；旧仓库仅保留迁移历史，不继续 subtree 双向同步。
- OpenCraft 与 `frontend/` 保持独立服务和锁文件，通过显式生成闭包过渡复用 Agent Console。
- Web、Expo、Electron 与 AppServer 共享核心领域模型，平台能力由 adapter/port 接入。
- OpenCraft 校验和构建不代表 frontend 或生产发布。

## 按需深入

- 服务职责和验证：`opencraft/docs/README.md`。
- 迁移谱系与共享前端：`opencraft/MONO2_MIGRATION.md`。
- 平台、插件、Chat 与浏览器架构：按 `opencraft/docs/` 对应专题读取。
- 涉及登录、区域或发布时，再加载对应 Domain Pack。

## 验证

运行 `bash opencraft/checks/guard.sh`；聚焦变更可以先跑相邻测试，但跨包或共享前端变更必须运行完整 `npm run gate`。
