# 高级设置按 Hermes Profile 隔离

## 需求

LightVela 多 Bot 模式中，一个产品 Bot 对应一个 Hermes Profile。高级设置页的安全、记忆开关和上下文压缩配置必须读取、保存和恢复当前 Bot 的 Profile 配置，不能继续默认读写根 Profile。

## 方案

- 从 `activeBot.profileId` 向 `AgentCommonSettingsPanel` 显式传递 Profile 上下文；缺失时仅为存量主 Bot 兼容回退到 `main`。
- 读取命令将当前 Profile 目录绑定为本次命令的 `HERMES_HOME`，再读取该目录的 `config.yaml` 和解析后的配置值。
- 保存和恢复默认命令复用现有 `withHermesProfile()`，生成 `hermes -p <profile> config set|unset ...`；保存后的回读继续使用同一 Profile。
- Gateway 重启沿用页面现有的 Profile 级命令，不改变即时生效字段与重启字段的既有边界。
- 增加命令生成、保存、恢复和面板参数传递的 Profile 隔离测试，同时保留 `main` 到 Hermes `default` 的兼容断言。

## 成功标准

- 命名 Bot 的高级设置读取、保存、恢复默认都只面向其 `profileId`。
- 主 Bot 缺少显式 Profile 时仍访问根 Profile，不创建 `profiles/main`。
- Profile ID 继续通过已有 shell quoting 处理，不引入命令注入回归。
- 高级设置聚焦测试、相关 Profile helper 测试、前端 lint、类型检查和测试通过。

## 非目标

- 不调整页面布局、文案、i18n 或可见入口。
- 不修改其他 Bot 配置页、后端 API、Hermes/ACLI 本身或实例级操作。
- 不提交、推送、创建 MR、发布或修改线上配置。

## 已确认上下文

- 最新目标分支为 `codex/expose-bot-create-entry-0910`，包含多 Bot/Profile 实现。
- `Bot` 已携带 `instanceId` 与 `profileId`，但高级设置面板当前只接收 `botId`。
- `execDebugCommand(botId, command)` 只负责将产品 Bot 映射到所属实例，不会自动给任意命令追加 Profile 参数。
- Memory 页面已经使用 `profileId` 选择 Profile，可作为相邻实现参照。

## 验证口径

```bash
cd frontend
pnpm vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/lib/__tests__/hermes-agent-command.test.ts \
  src/pages/marketing/__tests__/agent-common-settings.test.ts \
  src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
  src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
  src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx \
  src/pages/marketing/__tests__/agent-common-settings-page-boundary.test.ts
pnpm lint
pnpm typecheck
pnpm test
```
