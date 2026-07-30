# 成就页 P1 稳定性修复设计

日期：2026-07-23

## 目标

修复 `/agents/achievements` 的四个 P1 问题：Agent 切换时的异步竞态、成就命令无超时、非法成就 payload 被误判为空数据，以及自定义 `HERMES_HOME` 未用于选择 Python 虚拟环境。

## 设计

- `AchievementsPanel` 使用单调递增请求序号；只有最新请求可以写入数据、错误和 loading 状态。
- `fetchHermesAchievements` 为 `execDebugCommand` 传入固定 5 分钟超时。
- `parseHermesAchievementsOutput` 要求 `achievements` 必须是数组，否则抛出 `payload_invalid`；数组中的单条坏记录继续过滤。
- Shell 先读取 `HERMES_HOME`，为空时回退 `$HOME/.hermes` 得到 `HERMES_ROOT`；解释器与插件路径统一从该根目录推导，不可执行时回退 `python3`。

## 范围与验收

- 只修改成就页三个实现文件和聚焦测试，不修改视觉、文案、插件算法、后端接口或 Repository 公共接口。
- 四个问题均先有失败测试，再以最小实现修复。
- 运行聚焦测试、`pnpm check`、`pnpm i18n:check` 和 `git diff --check`。
