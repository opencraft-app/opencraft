# 需求名: 统一 Agent 名称真源并清理出生证旧逻辑

> feature slug: `hermes-agent-name-cleanup`
> 分支：`frontsandbox/hermes-agent-name-investigation`
> 规模：L
> 模式：单 Agent 串行执行

## 任务清单

- [x] 1. 前端 HTTP repository 接入后端名称真源。
  - 角色：Developer
  - 影响文件：`frontend/src/repositories/http-repositories.ts`、`frontend/src/repositories/__tests__/http-repositories.test.ts`
  - 验收方式：创建请求 body 包含 `name`；后端返回 name 优先于 legacy draft；空 name fallback 到区域默认名；测试覆盖 localStorage 残留 `Hermes宝宝` 不覆盖后端名称。

- [x] 2. 清理前端出生证 repository/domain 契约。
  - 角色：Developer
  - 影响文件：`frontend/src/domain/types.ts`、`frontend/src/repositories/types.ts`、`frontend/src/repositories/http-repositories.ts`、`frontend/src/repositories/fake-repositories.ts`
  - 验收方式：前端不再导出 `BotBornCard`，不再暴露 `getBotBornCard`，HTTP repository 不再请求 `/borncard`。

- [x] 3. 移除前端页面中的出生证 UI 和 “Hermes宝宝” 残留。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/pages/marketing/openclaw-success-page.tsx`、`frontend/src/pages/marketing/create-openclaw-page.tsx`、`frontend/src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx`、必要测试文件
  - 验收方式：用户可见页面不再出现出生证/出生证明/第几个 Hermes 宝宝；Workbench rail title 使用实际 bot name；`Hermes宝宝` 不再作为用户可见默认名。

- [x] 4. CTL 停止新建 birth profile，并下线 borncard 路由和响应字段。
  - 角色：Developer
  - 影响文件：`ctl/pkg/instance/async.go`、`ctl/main/api/server.go`、`ctl/main/api/internal_bots.go`、`ctl/pkg/transport/instance.go`、相关测试
  - 验收方式：创建实例不再 enqueue `BuildInstanceBirthProfile`；public/internal borncard 路由不可用；internal bot list 不再返回出生字段；保留历史 migration。

- [x] 5. 清理 gateway-dashboard 出生字段展示。
  - 角色：Developer
  - 影响文件：`gateway-dashboard/src/lib/queries/use-ctl-bots.ts`、`gateway-dashboard/src/app/(dashboard)/ctl-bots/page.tsx`
  - 验收方式：bots 表无“中国出生日期”“第几只”列，类型中无 born 字段。

- [x] 6. 更新 OpenSpec 和实现文档，移除出生证作为当前能力的说明。
  - 角色：Developer
  - 影响文件：`frontend/openspec/config.yaml`、`frontend/openspec/specs/bot.md`、`frontend/openspec/specs/marketing.md`、`docs/implementations/frontend-key-implementation.md`、`docs/agent-guides/ctl-agent-guide.md`
  - 验收方式：文档不再指导新逻辑调用 borncard 或展示出生证；如保留历史说明，明确标注已下线。

- [ ] 7. 运行目标验证并做残留扫描。
  - 角色：Reviewer
  - 影响文件：测试输出和 `rg` 扫描结果
  - 验收方式：前端 repository 测试、前端类型检查、CTL 目标测试、gateway-dashboard 类型检查按影响面运行；`rg` 残留只允许历史迁移或明确保留的第二阶段旧代码。

## 门禁重点

- 不改写历史 migration。
- 不引入新的状态管理或重型依赖。
- 不把名称真源重新放回 localStorage draft。
- 不在用户面保留“宝宝 / 出生证 / 第几只”叙事。
