# 技术规格：干净用户三要素实名闭环

## 状态与信任边界

```text
created
  -> face_succeeded
  -> phone_pending
  -> shadow_pending
  -> completed
```

- 创建 attempt 不再要求会话用户已有手机号。
- `send-phone-code` 与 `verify-phone` 接受可选 `phone`：无本地手机号时必填；已有本地手机号时省略并回退到会话手机号，显式传入时必须完全一致。
- 首次发送验证码时将候选手机号哈希绑定到 attempt；后续发送和校验必须匹配该哈希，避免中途换号。
- 发送前校验本地手机号唯一性；真正写入 `users.phone` 只发生在 Shadow 已验证并激活之后。
- 本地手机号写入与 attempt 进入 `shadow_pending` 使用专用存储事务，避免通用改号逻辑撤销当前 FaceID attempt。
- Shadow 基础实名同步成功后才将 attempt 完成并激活用户 `phone_3fa`。

## 前端交互

- identity 阶段始终收集姓名和身份证号。
- FaceID 成功后，已有手机号显示为只读；无手机号显示手机号输入框。
- 获取验证码和提交验证码均携带无手机号用户填写的候选手机号。
- 页面不展示独立安全手机绑定入口，也不提供跳过刷脸直达手机号阶段的路径。

## 测试

- 服务层：干净用户成功链路、手机号冲突、attempt 中途换号、已有手机号兼容。
- HTTP/API：发送和校验请求体中的可选手机号。
- 前端：无手机号用户从身份信息开始，经刷脸后输入手机号并完成；已有手机号仍只读。

---

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
  ScenarioEnableConfirmModal.tsx
```

`openclaw-automations-panel.tsx` 只负责：

- 展示场景任务区。
- 通过 `isGlobal` 在国际站屏蔽场景任务入口和相关弹窗。
- 持有当前安装 draft / preview 状态。
- 调用 `createCronJobWithScriptRollback` 创建一次性和周期 Cron。
- 调用 `refreshAll` / `refreshRecentRuns` 刷新列表。
- 场景试跑创建成功后关闭配置弹窗，通过消息通道接单确认和页面提示条给用户“已开始处理，结果稍后推送”的预期。
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
- 实时类场景 prompt 显式指定 `datetime` / `web_search` / `web_fetch` 的有界使用方式，避免 Agent 做开放式长时间浏览。
- 同一任务最多检索 3 组关键词、打开 4 个网页来源，并保留来源名称或链接。
- 生成一次性 schedule，默认当前时间后数秒执行，避免传到 Hermes 时被判定为过去时间。
- 生成周期 schedule。
- 生成 deliver；底层 builder 保留 `local` 兼容历史数据，场景安装 UI 首版只允许 `weixin` / `qqbot` 两种主动推送目标。
- 识别试跑任务和常态任务。
- 从最近执行中匹配试跑结果。

## UI

`ScenarioTaskGrid` 渲染四个 `ScenarioTaskCard`，位置在 header 和已生效 / 最近执行分段之间。无自动任务时作为主空态；已有自动任务时仍展示为紧凑推荐区。

国际站首版不渲染 `ScenarioTaskGrid`、`ScenarioInstallModal`、`ScenarioEnableConfirmModal` 和场景提示条。

`ScenarioInstallModal` 是两步弹窗：

1. `任务本身`：展示场景目标字段和任务摘要，减少产品逻辑解释文案。
2. `消息通道`：展示执行与回传摘要，并复用 `acli channel status` 结果展示微信 / QQ 扫码接入状态。

底部按钮：

- 第一步：`取消` / `下一步`
- 第二步：`取消` / `上一步` / `直接添加为自动任务` / `先跑一次`

回传目标：

- `weixin`：仅当现有通道状态显示微信已扫码接入后可试跑或添加；未接入时在当前弹窗内通过 `debug/exec` 执行 `acli gateway qr-url --platform weixin --wait true` 获取二维码。
- `qqbot`：仅当现有通道状态显示 QQ 已扫码接入后可试跑或添加；未接入时在当前弹窗内通过 `debug/exec` 执行 `acli gateway qr-url --platform qqbot --wait true` 获取二维码。
- 不再在场景安装流程内展示 `local` 作为用户可选项，也不再引导用户跳转到 `/agents/channels`。
- `--wait true` 会让命令在扫码完成前保持运行，因此二维码接入必须走 `Accept: text/event-stream` 的流式 `debug/exec`，实时读取 stdout；不能使用同步 `execCommand` 等命令结束后再解析二维码。
- 用户关闭弹窗、重新生成二维码或手动刷新通道状态时，需要 abort 当前流式请求，避免旧请求继续 pending。

点击“先跑一次”后：

- 前端创建下发后立即开始的一次性任务。
- 创建成功后立即关闭 `ScenarioInstallModal`，切回自动任务页。
- 前端尽快通过 `hermes send` 向所选微信 / QQ 推送一条接单确认消息，说明场景已开始处理、结果会稍后推送。
- 页面展示轻量提示条：已开始试跑、结果稍后推送、结果也会出现在最近执行。
- 提示条保留“添加为自动任务”入口，避免等待弹窗关闭后丢失常态化路径。
- 对应一次性任务在已生效任务卡片里显示“立即开始”。

`ScenarioEnableConfirmModal` 展示任务名称、频率、回传位置和关注摘要，确认后创建周期 Cron。

上述场景弹窗必须使用项目已有的 Radix Dialog primitive，保留焦点管理、Escape 关闭和 `aria-modal` 等基础可访问性能力。

## 状态流

```text
idle
  -> editing
  -> creating_preview_job
  -> preview_scheduled_notice
  -> enabling_recurring_job
  -> recurring_enabled
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

- 创建一次性执行任务后立即刷新 jobs 和 recent runs。
- v1 不再打开等待结果弹窗，也不在前台持续轮询；结果通过所选消息通道主动推送，并可在最近执行中查看。
- 添加为自动任务入口放在页面提示条和场景卡入口中承接。

## 测试

新增单测：

- `scenario-task-builder.test.ts`
  - 四个场景都能生成有效 draft。
  - A股 prompt 包含非投资建议。
  - AI 动态 prompt 不包含 LightVela 启发小节。
  - 实时类场景 prompt 显式限制 `datetime` / `web_search` / `web_fetch`、3 组关键词、4 个网页来源和来源保留。
  - 一次性 schedule 晚于当前时间。
  - 周期 schedule 符合默认频率。
  - 最近执行匹配优先 job name / prompt。

更新现有测试：

- `openclaw-automations-panel.test.ts`
  - 如组件导出纯 helper，只补 helper 级测试。
  - 避免在本轮把整页测试扩展为脆弱的 DOM 集成测试。

## 风险与降级

- 最近执行延迟：消息通道主动推送优先，最近执行作为补充查看入口。
- Cron 创建失败：保留 draft，显示错误 toast。
- 外部通道不可用：场景器首版要求用户先连接微信 / QQ；底层 builder 保留 `local` 仅用于历史数据兼容。
- 任务数已达上限：复用现有上限确认逻辑，不绕开限制。
