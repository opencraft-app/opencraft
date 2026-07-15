# 技术规格：统一 Agent 名称真源并清理出生证旧逻辑

## 方案选择

采用“后端名称为真源 + 前端清理旧叙事 + CTL 停止新 birth projection”的方案。

备选方案一是只替换前端文案，把“Hermes宝宝”改成“我的Hermes”。这个方案不能解决 draft 覆盖后端名称的问题，也会让出生证任务和接口继续存在。

备选方案二是一次性删除 CTL birth profile 全套 worker、DAO、migration 和表。这个方案清理彻底，但对线上队列和历史迁移风险更高。当前更稳妥的方式是先停止新任务、下线接口和字段，再把删表放到确认无消费者后的第二阶段。

## Agent 名称真源

前端 HTTP repository：

- `CtlInstancePayload` 增加 `name?: string`。
- `projectInstanceToBot(instance, draft)` 使用优先级：
  1. `instance.name?.trim()`
  2. `defaultHermesAgentName()`
- `defaultHermesAgentName()` 根据 `isGlobal` 返回 `My Hermes` 或 `我的Hermes`。
- `createBot(input)` POST `/v1/instances` 时传 `name`：
  - `input.name?.trim()` 非空时使用输入；
  - 为空时使用 `defaultHermesAgentName()`；
  - 不再把 name 写入 `lightclaw-http-bot-drafts-v1`，draft 只保留非真源的本地 UI 元信息。

创建入口：

- `/subscribe` 仍可传“我的Hermes”作为国内默认输入，但最终以后端返回 name 展示。
- `/agents` 已订阅直接创建同理。
- 国际站默认名通过 repository fallback 保底，避免调用方散落硬编码。

Workbench：

- `VelaWorkbenchDesktopHost` 不再硬编码 `Hermes宝宝`，改为从页面传入的当前 `bot.name` 或上层标题 prop 展示。

## 出生证前端清理

删除或失活以下前端能力：

- `frontend/src/domain/types.ts::BotBornCard`
- `frontend/src/repositories/types.ts::getBotBornCard`
- `frontend/src/repositories/http-repositories.ts` 中 `CtlBotBornCardPayload`、`mapBotBornCard` 和 `/borncard` 调用
- `frontend/src/repositories/fake-repositories.ts::getBotBornCard`
- `agent-settings-page.tsx` 中 `BirthCertificateModal`、`showBirthCert` 状态、按钮和挂载
- `openclaw-success-page.tsx` 中出生证弹窗和按钮残留
- `create-openclaw-page.tsx` 中 `Hermes宝宝` 默认名残留

清理后，前端不再存在用户可见“出生证明 / 出生证 / 第几个 Hermes 宝宝”路径。

## CTL 出生档案清理

第一阶段直接改动：

- `ctl/pkg/instance/async.go`：实例创建成功后不再调用 `enqueueBirthProfileTask`。
- `ctl/main/api/server.go`：删除 public `/v1/instances/{id}/borncard` 分支和 normalize path。
- `ctl/main/api/internal_bots.go`：
  - `handleInternalBotSubresource` 不再转发 `/borncard`；
  - 删除 `handleInternalBotBornCard`、`loadBotBornCard`、`loadBirthProfiles` 使用路径；
  - internal bots 列表不再加载 birth profiles；
  - `BotSummaryResponse` 不再写 `born_date_for_china` / `born_number_for_china`。
- `ctl/pkg/transport/instance.go`：移除 `BotBornCardResponse` 以及 `BotSummaryResponse` 的出生字段。
- `ctl/pkg/taskruntime/processor/factory.go`：不再注册 `BuildInstanceBirthProfile` worker，避免旧入口继续消费出生投影任务。
- 调整 CTL 测试，删除 borncard 成功用例，新增/调整路由下线断言。

第一阶段保留：

- `ctl/pkg/instancebirth/**`
- `ctl/pkg/model/instancebirthprofile/**`
- `ctl/migrations/000010_create_instance_birth_profiles.*`
- `taskruntime` 中旧 task 常量和底层 worker 包可在后续确认队列清空后再做物理删除。

本轮已移除 worker 注册和 `ctl/pkg/instance/async.go` 中明显无入口的 enqueue / inline helper，但不得改写历史 migration。

## Gateway Dashboard

- `gateway-dashboard/src/lib/queries/use-ctl-bots.ts` 删除 born 字段。
- `gateway-dashboard/src/app/(dashboard)/ctl-bots/page.tsx` 删除“中国出生日期”和“第几只”列。

## 文档

- `frontend/openspec/config.yaml`、`frontend/openspec/specs/bot.md`、`frontend/openspec/specs/marketing.md` 移除 borncard / 出生卡作为当前前端能力的说明。
- `docs/implementations/frontend-key-implementation.md` 移除出生证明流程说明。
- `docs/agent-guides/ctl-agent-guide.md` 移除或标注 birth profile 为已下线旧投影，避免后续实现继续引用。

## 测试策略

前端：

- 更新 `http-repositories.test.ts`：
  - `createBot({ name })` 的 POST body 包含 `name`；
  - 后端返回 `name` 时，以后端 name 展示；
  - localStorage draft 中有 `Hermes宝宝` 时，不覆盖后端 name；
  - 后端 name 为空时 fallback 到区域默认名。
- 新增或更新 Workbench 测试，断言 rail title 来自 bot name 或 prop，不再写死 `Hermes宝宝`。
- 静态测试或 `rg` 校验前端源码不再出现出生证用户文案和 `getBotBornCard`。

CTL：

- 更新 create integration test：创建实例后不再断言 birth profile 被投影。
- borncard public/internal 路由测试改为 404 或按现有路由兜底行为断言不可用。
- internal bots list 测试不再断言 `BornDateForChina` / `BornNumberForChina`。

gateway-dashboard：

- 类型检查覆盖删除字段后的列定义。

验证命令：

- `cd frontend && pnpm test -- src/repositories/__tests__/http-repositories.test.ts`
- `cd frontend && pnpm check`
- `cd gateway-dashboard && pnpm check`（如脚本存在）
- `cd ctl && go test ./main/api ./pkg/instance/...`
- `rg -n "Hermes宝宝|出生证|出生证明|borncard|getBotBornCard|born_number_for_china" frontend gateway-dashboard ctl/main/api ctl/pkg/transport docs frontend/openspec`
