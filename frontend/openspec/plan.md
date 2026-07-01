# 当前执行计划

> 当前需求：参考 `lightvela-next-figma.zip` 与截图，仅升级 `/agents/*` 控制台左侧导航样式。

- [x] 保留 `origin/master` 已有左侧导航入口和条件入口，不新增、删除或改名导航能力。
- [x] 将左侧 Agent profile、状态、头像、创建入口和导航项选中态调整为轻量白底细分隔线样式。
- [x] 将 profile 内原有重启 / 删除快捷操作收敛到更多菜单，不改变操作语义和确认流程。
- [x] 撤销顶栏、通道页卡片、记忆页、内容区壳层和全局页面背景相关视觉改动。
- [x] 完成 i18n、类型检查和本地预览 smoke。

> 近期 master 已合入需求：国内站 `/docs` 新增 LightVela 产品公告目录，并让首页公告跳转到文档页。

- [x] Planner/Developer: 梳理公告内容模型与 docs 接入点。
- [x] Developer: 接入 Fumadocs 同步和 docs route manifest。
- [x] Developer: 更新首页公告条跳转，并移除旧独立公告路由。
- [x] Reviewer: 运行质量门禁与页面 smoke。
