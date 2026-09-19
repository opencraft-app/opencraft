## goal
用户纠正并确认示意图：在 + 后增加标签栏级统一下拉，上方新建类型，下方当前任务所有标签。右侧浏览器/终端恢复一键新建。

## non_goals
不新增资源存储、全局终端列表、关闭或删除操作，不改变 Browser/PTY 生命周期；不改本轮之前讨论的模型设置报错。

## context_receipt
OpenCraft AGENTS、平台架构/工作区不变量、维护/React/baseline-ui/accessibility/icon 技能；router 无 must_read。已检查 right-panel、PanelToolbarActionDefinition、Browser/Terminal 注册及相邻 panel/terminal 测试。

## contract
Shell 直接从当前 owner 的 region.tabs 投影全部标签；统一 Radix 菜单，选中后先关闭再切换/创建；Escape 仅关闭，pending/error 不推移工具栏。旧错误实现的 panelKind、类型过滤 helper、右侧箭头及专用 CSS 已删除。

## acceptance
单一下拉同时包含所有可新建类型与 Browser/Terminal 存量标签、active 标记、相同标题独立身份；切换不创建、不跨任务；右侧图标一键新建；键盘/焦点与真实界面验证。

## stage
第一次错误实现已被用户否定；按后续明确图示完成纠正，未提交/发布。

## verified
- 新增契约断言先失败后通过；84 项 panel/terminal/timeline 测试、Web typecheck、boundaries 与 Electron 构建通过。
- 新隔离 Electron CDP 9504：右侧图标直接创建 Browser/Terminal；+ 后统一 Tabs 菜单同时列新建和两类已有标签。切换 about:blank 后数量保持 2；菜单 New terminal 后数量为 3。重复 Terminal 标题显示不同序号和正确选中状态。
- Escape 不创建/切换，焦点回到 Tabs，菜单入口只有一个。截图 /tmp/opencraft-unified-tabs-final.png。
- 自动化曾因新浏览器 guest 自动成为 CDP 目标而读到 about:blank；切回真实 OpenCraft main target 后继续验收。后台 Electron 菜单退出动画需实际绘制收尾，未把点击成功当作操作完成。

## handoff
旧按类型菜单、panelKind/helper 与专用 trigger CSS 已删除。新预览已打开；未修改用户旧终端输入，未打包或覆盖安装版。仅标签栏需求完成，模型服务报错建模仍未实施。
