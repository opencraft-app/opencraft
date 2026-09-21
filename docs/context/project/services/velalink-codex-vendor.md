---
id: velalink-codex-vendor-detail
type: service
scope: VelaLink 内 vendored OpenAI Codex Rust、TUI 和 app-server 的派生服务上下文。
triggers: ["velalink codex vendor", "codex-rs", "app-server v2"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - velalink/docs/README.md
  - velalink/catalog-info.yaml
  - velalink/vendor/openai-codex/codex-rs/Cargo.toml
  - velalink/vendor/openai-codex/justfile
  - velalink/vendor/openai-codex/AGENTS.md
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "upstream-subtrees"]
---

# VelaLink Codex Vendor Context

仅在命中 vendored Codex Rust、TUI、Bazel 或 app-server 工作时加载；最近的嵌套 `AGENTS.md` 优先。

## 当前边界

- 不得改变 sandbox 环境变量 contract。可归属更窄 crate 的新概念不放入 `codex-core`，避免膨胀中心 TUI 编排模块。
- 依赖或编译时资源变更要保持 Cargo 和 Bazel 输入同步；用户可见 TUI 变更需审阅 `insta` snapshot。
- 新 app-server surface 属于 v2，Rust、TypeScript、文档与生成 schema 保持同步；不在 vendor 树内放 mono2 通用产品文档。

## 验证

在 `velalink/vendor/openai-codex/codex-rs` 运行 `just fmt`、受影响 crate 的测试和范围受限的 `just fix -p <crate>`；app-server contract 变更还运行对应协议测试与 schema 生成。共享风险才运行全 workspace。
