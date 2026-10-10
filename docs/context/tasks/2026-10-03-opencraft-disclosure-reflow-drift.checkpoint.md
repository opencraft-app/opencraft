## stage
共享像素投影已实现、验证并更新当前 Web 预览；后台不重启，待用户真机确认。

## verified
- `useDisclosureHeight` 接入 Read/Bash 和 Group，无新增 DOM observer，动画时长和自然 auto 布局保留。
- 48 条源码真实组件路径（3 个 Turn/分数初始位置/可见标题/桌面触控/普通减少动画）全程和最终偏移、往返振幅均 0；快速反向与无虚拟列表的后续增长控制通过。
- Web 类型检查、平台边界检查通过；相关本地测量/滚动/活动测试 75 项通过。
- 正式设计 WSP-37、Chat UI 与 agent-gateway-runtime 已同步，显式变更集影响检查通过。
- 重基于 material-edge 后的实际 port80 制品 64 条展开/收起全程与往返偏移均 0，12 条取消通过；3354 个 Web 文件哈希、HTML 和健康核验一致。独立切换成功，PID 和 runtime 哈希不变。

## unverified
- `codex-activity-model.test.ts` 依赖的固定参考目录 `/data/mia/.runtime/lifecycle-authority-dead-contract-r3562` 不存在，未通过；不改上游参考或该不相关 loader 来伪装成功。
- iPhone 用户实际浏览器未验证；不能把本机 Chromium 与触控模拟称为真机。
- 首个候选包未覆盖并行 material-edge 更新；最新候选已保留它并交付。不声称本轮 Chromium 证据覆盖用户 Safari 的所有路径。

## discard
- 旧的 <=0.55px 相对误差放行条件；它允许约 1px 往返抖动。
- 诊断用高度 MutationObserver 不是产品方案。

## restore
- 运行 unit `opencraft-neutral-focus-20261004-preview.service`、PID 1554252。
- 运行包 `/data/opencraft-neutral-focus-YZHpna/opencraft-server`，交接观察为 `20261004-local-edge-cfe65f910d12`，基础本次 `20261004-disclosure-pixel-3aefaa3a6652`；已逐字比较六个相关声明，本次修复完整保留。64 条源站测试针对 disclosure-pixel，不冒称之后 CSS 更新已经重跑全矩阵。
- 交付证据 `/data/opencraft-disclosure-pixel-rebased-JAN4UI`，其 `web/` 保留上一份 material-edge Web；仅重编译共享高度适配器与两个消费者，保留其他运行代码。首个 RDyyJI 候选已经过期，不可强行切换。
- `docs/context/tasks/2026-10-03-opencraft-disclosure-reflow-drift.md` 保存来源和边界。

## next_action
- 用户刷新当前页面后测试圈出的整组标题；若仍移动，采集实际浏览器全程位置并区分动画中抖动与完成后错位，不延长定时器或覆盖其他更新。
