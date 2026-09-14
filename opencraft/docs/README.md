# OpenCraft 服务文档

OpenCraft 是 mono2 内的多端 Agent Workbench 服务根，包含 Codex-faithful Chat Runtime、Web Workbench、Expo 客户端、Electron 桌面壳、AppServer 适配层和 LightVela Hermes 扩展。它与 `frontend/` 共用部分 Agent Console 产品实现，但保持独立运行时、包管理器、构建矩阵和发布所有权。

## 权威入口

- 服务所有权、依赖和生成路径：`opencraft/catalog-info.yaml`。
- Agent 工作规则：`opencraft/AGENTS.md`。
- 项目维护方法与验收路由：[OpenCraft 维护总纲 Skill](../.agents/skills/opencraft-maintenance/SKILL.md)；不替代下列正式架构文档。
- 一次性迁移谱系和共享前端边界：`opencraft/MONO2_MIGRATION.md`。
- 平台与插件架构：`opencraft/docs/platform-architecture.md`、`opencraft/docs/plugin-architecture.md`。
- Chat 与浏览器 Workbench：`opencraft/docs/chat-ui-architecture.md`、`opencraft/docs/browser-workbench-architecture.md`。
- 构建目标：`opencraft/docs/build-matrix.md` 与 `opencraft/config/build-matrix.json`。

## 核心不变量

- mono2 是唯一写入真源；旧 OpenCraft 仓库仅保留迁移历史，不继续双写。
- `opencraft/` 保持独立 npm workspace 和锁文件，`frontend/` 保持独立 pnpm workspace 和锁文件。
- AppServer 事件游标、投影状态和 durable history 的生命周期必须一致；Hermes 转译遵循 Hermes Desktop 语义，Chat Runtime 遵循 Codex 的 Turn、queue、steer、工具活动和滚动所有权。
- Web、Expo 与 Electron 共享领域模型和设计 token，但平台能力通过显式 adapter/port 接入，不能用平台条件分支破坏核心状态机。
- `plugins/lightvela-hermes/src/upstream/mono2/` 是机械生成的过渡兼容层，源码所有权在 `frontend/`；生成目录禁止手改。

## 变更边界

OpenCraft 可以消费 `frontend/` 中显式列入同步闭包的 UI、domain、repository 和 locale 实现。新增跨服务复用优先提取稳定 workspace package；在包边界完成前，必须同步生成物并通过 drift check。OpenCraft 的 CI 只做安装、校验和构建，不发布 frontend、不修改 GitOps，也不推进任何生产环境。

## 验证

在 `opencraft/` 运行：

```bash
npm ci
npm run check:mono2-agent-console
npm run gate
```

只改局部包时可以先跑相邻类型检查和聚焦测试，但跨包、共享前端、协议、构建矩阵或平台入口变更必须完成全门禁。发布需要单独、明确授权，构建通过不代表已经发布。
# 任务工作区设计

Codex 工作区复刻的所有权、呈现策略、不变量及验证账本见 [design/](../design/README.md)。
