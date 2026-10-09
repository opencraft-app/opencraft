## stage
连接器页面文案与结构完成，准备交接。

## verified
- 顶部标题为「连接器」，下方仅一句说明。
- 说明文案为「连接常用服务，扩展 Agent 能力边界，帮你完成更多任务」。
- 已移除「应用连接」小标题、重复说明和未来连接器占位卡；实际卡片及授权操作保留。
- 七种必需语言翻译齐全；聚焦测试 20/20、`pnpm check` 和 `pnpm build` 通过。

## unverified
- 全量 Vitest 在此前运行中有大量无关失败并触及 4GB worker 堆上限。
- OpenCraft 清单 `sourceRevision` 漂移；根据 `frontend/AGENTS.md`，需在真源提交后同步副本并重新检查。

## discard
- 构建生成的字体和 `next-env.d.ts` 改动已还原。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/agent-connector-nav/lightvela`。
- 同一工作树包含上一轮导航顺序改动。

## next_action
- 核对最终 diff 和工作树状态，向用户交接本地结果。
