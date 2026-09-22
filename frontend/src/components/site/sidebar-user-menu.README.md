# Agent 左侧导航与账号菜单

## 范围与所有权

- AgentSidebar 只管理中间导航滚动区的上下阴影；真实页面和加载视图共享固定 Bot、探索/对话页签、可滚动导航、底部账号的布局。导航分组、Bot 操作和正文由 master 页面继续负责。
- UserAvatarMenu 按 variant 分流；header 保留 master 的交互，sidebar 使用已有 Radix Popover，click-only。头像、名称、套餐、箭头和按钮空白共享同一触发按钮。
- SidebarUserMenuController 负责账号身份、只读套餐/积分摘要、升级资格与现有路由。只有首次打开菜单才请求回退套餐；换号隔离数据，迟到请求不能覆盖新账号。
- useAccountPassSummary 与 account-pass-summary 仅服务菜单；Account 页面、续费流程、订阅写入与权限不变。升级只跳转原购买入口，不创建订单。
- 直接复用 master 的 subscribeConsoleShow / installConsoleShowCommand；show 继续 toggle，不注册 hide。工作台、模型遵循 master 条件；国内站反馈仅放在账号菜单，默认可见，不受 show 状态影响。国际站不显示反馈入口。

## 布局和交互约束

- 桌面顶部 Bot、探索/对话页签和底部账号不随导航滚动；页签与导航间距为 16px，中间区承担 overflow，ResizeObserver 和 scroll 更新可滚动边缘。
- 账号菜单根节点和按钮填满父容器内容宽度；不添加覆盖层或重复点击事件。
- Popover 使用 Portal 脱离侧栏裁切，限制可用高度。打开聚焦账号标题；Escape 关闭并归还触发器焦点。嵌套语言菜单先关闭自身。
- 积分未知、加载失败和真实零余额分别展示；进度条仅展示有效数值。升级继续复用原资格判断和本地化路由。
- 本次不改变依赖版本、全局 UI 原语、Account/Buddy/Memory 正文或 OpenCraft 产品逻辑。

## 验证

侧栏组件、controller、header 隔离、账号摘要、导航间距、tab 接线与 helpers 的聚焦测试见 docs/context/tasks/2026-09-21-sidebar-master-merge.md。组件测试验证交互与滚动边缘；不宣称完成浏览器像素命中或真实计费验收。
