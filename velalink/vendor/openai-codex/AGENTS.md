# Vendored OpenAI Codex Agent 入口

此工作区作为 vendor 位于 VelaLink 下。最近的嵌套 `AGENTS.md` 仍然适用。需要详细 Rust、TUI、snapshot、Bazel 和 app-server v2 规则时，从 mono2 根加载 `docs/context/project/services/velalink-codex-vendor.md`。

硬约束：

- 不得变更 sandbox 环境变量 contract。
- 当更窄的 crate 可归属新概念时，不要放入 `codex-core`；避免膨胀中心 TUI 编排模块。
- Rust 变更要求 `just fmt`、聚焦 crate 测试和范围受限的 `just fix -p <crate>`。
- 依赖或编译时资源变更必须保持 Cargo 和 Bazel 输入同步。
- 用户可见 TUI 变更需要审阅过的 `insta` snapshot。
- 新 app-server API surface 属于 v2，并且要保持 Rust、TypeScript、文档和生成 schema 对齐。

不得在 vendor 树内添加通用产品文档。Mono2 特定 context 应位于仓库 `docs/context/` 层级。
