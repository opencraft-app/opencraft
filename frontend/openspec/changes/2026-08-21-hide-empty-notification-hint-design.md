# 国际站通知空态隐藏后台运行说明 Design

**Status:** 方案 A 与英文空态文案已确认，等待书面规范验收后进入实施计划。

## 背景

国际站自动任务弹窗在没有任何已配置通知通道时，会同时展示：

- `No notification channels are configured yet.` 与 `Configure channels`；
- `If none are selected, the agent will only run the task in the background without sending notifications.`。

空态文案偏长，调整为 `No channels configured.`。后一条说明适用于“存在可选通道但用户没有勾选”的场景；在完全没有已配置通道时重复解释结果，应隐藏并收起其占位高度。

## 范围

- 仅调整国际站 `AutomationFormModal` 的通知说明条件渲染。
- 将英文空态文案精简为 `No channels configured.`，保留 `Configure channels` 链接。
- 已有至少一个可选通知通道、但用户未选择时，继续展示后台运行说明。
- 国内站行为不变。
- 不修改通知通道范围、Hermes 命令、任务提交、后端接口或其他语言文案。

## 方案

复用国际站现有 `GLOBAL_NOTIFICATION_CHANNELS` 与 `isHermesNotificationChannelConfigured` 语义，得到“是否存在已配置的国际站通知通道”的单一判断：

- 该判断为 `false` 时，渲染现有空态，但不渲染后台运行说明及其 spacer/占位行。
- 该判断为 `true` 且当前未选择通知通道时，继续渲染后台运行说明。
- 已选择通知通道时，保持现有等高占位行为，避免弹窗布局因选择操作跳动。
- 加载态和通道状态未知时沿用现有行为，不提前当作空态处理。

## 状态矩阵

| 区域与状态 | 通道区域 | 后台运行说明 |
| --- | --- | --- |
| 国际站，通道状态加载中 | 现有加载态 | 保持现状 |
| 国际站，无已配置通道 | `No channels configured.` + 配置入口 | 隐藏，且不保留占位高度 |
| 国际站，有已配置通道但未选择 | 可选通道列表 | 展示 |
| 国际站，已选择通道 | 可选通道列表 | 沿用现有等高占位 |
| 国内站 | 保持当前列表行为 | 保持现状 |

## 测试与验证

- 在国际站空态测试中断言 `No channels configured.` 存在、旧文案与后台运行说明不存在。
- 增加国际站已有已配置通道但未选择时的正向测试，断言说明仍存在。
- 保留国内站通知通道回归，不改变其断言。
- 运行精准双区域 Vitest、`pnpm check`、`pnpm i18n:check`、`pnpm build:global` 与 `git diff --check`。

## 非目标与已知基线

- 不同步 MR !2961 的“展示全部未配置国际站通道”行为。
- 不删除或改写后台运行说明文案；仅更新英文空态翻译。
- `origin/master` 的同一测试文件存在历史重复的国内站通知通道测试；宽泛的 global describe 筛选会误跑该测试。当前国际站空态精准基线测试通过，本需求不把该历史测试清理纳入生产改动范围。
