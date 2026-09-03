---
id: velalink-desktop-service-detail
type: service
scope: VelaLink 桌面预览、daemon、Chat UI 与本地观测的派生服务上下文。
triggers: ["velalink desktop", "velad observability", "vela preview"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - velalink/docs/README.md
  - velalink/catalog-info.yaml
  - velalink/Makefile
  - velalink/crates/vela-observability
  - velalink/AGENTS.md
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "upstream-subtrees"]
---

# VelaLink Desktop Context

仅在桌面预览、Chat UI、work-monitor、daemon 故障或本地 telemetry 任务中加载。

## 当前边界

- 默认反馈闭环是 `make desktop-preview`，预览数据必须与打包 Vela 数据隔离；先辨别真实进程和端口，不能把 `/Applications/Vela.app` 当作当前预览。
- 运行时问题先检查进程、端口、近期错误、span 和 SQLite 证据；Electron main、preload、work-monitor 改动需要重启，renderer/CSS 才可热更新。
- VelaLink 是保留谱系的 subtree。需要 `frontend/` 消费的行为变更要更新预期 upstream pin 并验证 consumer；预览或 subtree commit 都不等于发布完成。

## 按需深入与验证

先读 `velalink/AGENTS.md` 和 `velalink/docs/README.md`；再按诊断目标读取当前 telemetry/SQLite 或相关 crate。运行受影响 package/crate 的 formatter、type、lint 和 test；consumer 行为变化还需验证 pin 与 consuming build。
