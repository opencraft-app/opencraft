# 技术规格：LightVela 场景任务安装器 v1

## 集成点

主入口在 `frontend/src/pages/marketing/openclaw-automations-panel.tsx`。

新增场景任务模块：

```text
frontend/src/pages/marketing/scenario-tasks/
  scenario-packs.ts
  scenario-task-builder.ts
  ScenarioTaskGrid.tsx
  ScenarioInstallModal.tsx
  ScenarioRunPreview.tsx
  ScenarioEnableConfirmModal.tsx
```

`openclaw-automations-panel.tsx` 只负责：

- 展示场景任务区。
- 持有当前安装 draft / preview 状态。
- 调用 `createCronJobWithScriptRollback` 创建一次性和周期 Cron。
- 调用 `refreshAll` / `refreshRecentRuns` 刷新列表。
- 处理 toast 和错误文案。

## 方案取舍

1. 推荐方案：前端场景安装器 + 复用 Hermes Cron。
   - 优点：不新增后端接口，能直接落在现有 `/agents/automations` 体验里，最快完成“先跑一次 -> 添加为自动任务”的闭环。
   - 缺点：最近执行匹配依赖任务名 / prompt 兜底，不如 metadata 稳定。

2. 备选方案：新增后端 `runScenarioOnce` 接口。
   - 优点：试跑状态、结果和 metadata 更可控。
   - 缺点：跨后端和运行时，超出 v1 节奏，也会把当前产品验证变重。

3. 备选方案：独立场景市场页面。
   - 优点：长期可扩展到更多场景和 SkillHub 商品化。
   - 缺点：冷启动路径变长，且 v1 目标是让用户在自动任务页直接达成首个结果。

因此 v1 选择方案 1，并把 metadata 与专用试跑接口作为后续优化方向。

## 数据模型

```ts
type ScenarioTaskId = "stock-morning-brief" | "world-cup-daily" | "daily-news" | "ai-digest";

type ScenarioTaskDraft = {
  scenarioId: ScenarioTaskId;
  values: Record<string, string>;
  generatedName: string;
  generatedPrompt: string;
  generatedDeliver: string;
  generatedDeliverLabel: string;
  oneShotSchedule: string;
  recurringSchedule: string;
  oneShotJobName: string;
};
```

四个场景配置集中在 `scenario-packs.ts`，包含名称、描述、默认频率、字段、提示、安全说明和图标 key。React 组件只消费配置，不在 JSX 中拼长 prompt。

`scenario-task-builder.ts` 负责：

- 根据场景字段生成 prompt。
- 生成一次性 schedule，默认当前时间后 2 分钟。
- 生成周期 schedule。
- 生成 deliver，默认 `local`；只允许 `local` / `weixin` / `qqbot` 三种场景回传目标。
- 识别试跑任务和常态任务。
- 从最近执行中匹配试跑结果。

## UI

`ScenarioTaskGrid` 渲染四个 `ScenarioTaskCard`，位置在 header 和已生效 / 最近执行分段之间。无自动任务时作为主空态；已有自动任务时仍展示为紧凑推荐区。

`ScenarioInstallModal` 是单页弹窗：

1. 场景目标字段。
2. 执行与回传摘要，并复用 `acli channel status` 结果展示微信 / QQ 扫码接入状态。
3. 试跑确认。

底部按钮：

- 主按钮：`先跑一次`
- 次按钮：`取消`
- 链接按钮：`直接添加为自动任务`

回传目标：

- `local`：默认项，结果留在最近执行中查看。
- `weixin`：仅当现有通道状态显示微信已扫码接入时可选。
- `qqbot`：仅当现有通道状态显示 QQ 已扫码接入时可选。
- 未接入微信 / QQ 时，弹窗提供跳转到 `/agents/channels` 的扫码接入口，不在场景器内重做扫码流程。

`ScenarioRunPreview` 展示试跑状态：

- `creating_preview_job`
- `waiting_preview_run`
- `preview_succeeded`
- `preview_timeout`
- `preview_failed`

`ScenarioEnableConfirmModal` 展示任务名称、频率、回传位置和关注摘要，确认后创建周期 Cron。

## 状态流

```text
idle
  -> editing
  -> creating_preview_job
  -> waiting_preview_run
  -> preview_succeeded
  -> enabling_recurring_job
  -> recurring_enabled

waiting_preview_run
  -> preview_timeout
  -> preview_failed

preview_succeeded
  -> editing
  -> enabling_recurring_job
```

## Cron 策略

一次性试跑：

```ts
{
  name: `试跑 - ${scenario.name}`,
  prompt: draft.generatedPrompt,
  schedule: draft.oneShotSchedule,
  deliver: draft.generatedDeliver
}
```

常态任务：

```ts
{
  name: draft.generatedName,
  prompt: draft.generatedPrompt,
  schedule: draft.recurringSchedule,
  deliver: draft.generatedDeliver
}
```

试跑任务和常态任务来自同一份 draft，只替换 schedule 和 name。

## 最近执行匹配

v1 不依赖后端 metadata。匹配优先级：

1. `run.job_name === draft.oneShotJobName`
2. `run.job_prompt === draft.generatedPrompt`
3. `run.job_name` 包含场景名称，且 `run.run_at` 晚于试跑发起时间

轮询策略：

- 创建一次性 Cron 后立即刷新 jobs 和 recent runs。
- 每 4 秒刷新一次，最多 2 分钟。
- 超时后保留“添加为自动任务”入口，同时提示任务可能仍在执行，可去最近执行查看。

## 测试

新增单测：

- `scenario-task-builder.test.ts`
  - 四个场景都能生成有效 draft。
  - A股 prompt 包含非投资建议。
  - AI 动态 prompt 不包含 LightVela 启发小节。
  - 一次性 schedule 晚于当前时间。
  - 周期 schedule 符合默认频率。
  - 最近执行匹配优先 job name / prompt。

更新现有测试：

- `openclaw-automations-panel.test.ts`
  - 如组件导出纯 helper，只补 helper 级测试。
  - 避免在本轮把整页测试扩展为脆弱的 DOM 集成测试。

## 风险与降级

- 最近执行延迟：展示超时状态和刷新入口。
- Cron 创建失败：保留 draft，显示错误 toast。
- 外部通道不可用：默认 `local`，微信 / QQ 未扫码接入时禁用对应选项，不阻塞试跑。
- 任务数已达上限：复用现有上限确认逻辑，不绕开限制。
