# Agent 信息与选中态视觉评审（2026-09-17）

## 范围与阶段

用户已确认「选 A，然后这个灰底稍微再浅一些」。本轮由独立 Demo 评审进入正式展示层实现：导航 / 会话选中底色由 Demo 的 `#eeeeeb` 调为 `#f2f2ef`，hover 为 `#f7f7f5`。不提交、不推送、不部署、不继续跟踪 CI。浏览器、终端、Workbench、成就业务仍不在范围内；共用组件仅做必要生成同步和宿主样式兼容。

沿用 `frontsandbox/agents-radix-refactor` 隔离工作树；运行文件放在被忽略的 `.workflow/runtime/selected-state-demo/`。Demo 使用示例数据和仓库已有 Hermes / Skills 图片，不连接账户、支付或 Agent API。

## 已验证的问题

1. `frontend/src/styles.css` 的 `.agents-ui [role="tab"][data-state="active"]` 强制 `background: #dedede !important`，覆盖了多个视觉角色。
   - 国内分支 Skills 预览的 computed style 实测：探索、技能页标题（本身为单项 TabsTrigger）、技能市场当前项都是 `rgb(222, 222, 222)`。
   - Skills 市场当前项同时保留了黑色 `::after` 下划线，因而变成灰色文字块与下划线叠加。
   - 标题灰块不是本次截图的文字选区；该元素实际为 Tab，并受到上述规则影响。
2. `console-session-list.tsx` 仅在 AppLink 上设置 `is-active`，右侧 DropdownMenuTrigger 是相邻元素；选中底色因此在更多操作前截断。
3. `console-bot-profile.tsx` 的状态位于整行 identity 下方，切换箭头在名称后、维护操作前。与用户最新截图目标不同。
4. 已有 `tabs-selected-geometry.test.tsx` 检查了全局 `#dedede` 规则，却没有验证下划线 / 分段 / 选择卡片的差异；正式修复需增加变体隔离回归，不能只更新色值断言。

## 相关组件清单与拟定规则

| 类型 | 当前消费者 / 边界 | Demo 规则 |
| --- | --- | --- |
| Agent 信息 | `agents-console/console-bot-profile.tsx` | 头像左侧；名称 + 状态同列；重启、删除、切换在右。长名称截断，维护按钮不挤出。 |
| 导航 | `console-navigation.tsx` / `styles.css` | 白色侧栏、细边框、整行浅中性底色，选中图标和文字加深。 |
| 会话 | `console-session-list.tsx` | 完整行背景覆盖更多按钮；导航与操作仍是分离的交互元素，不嵌套按钮。 |
| 分段切换 | `console-sidebar-tabs.tsx`、`agent-memory-views.tsx`、`agent-experts-views.tsx`、定时任务表单执行时间 | A：浅轨道、白色选中项和细边框；B：深色胶囊。 |
| 页面 Tabs | `SkillsDemoPanel.tsx`、`agent-skills-panel.tsx`、`agent-model-config-panel.tsx`、定时任务主分类 | 透明背景 + 深色标签 + 2px 下划线；计数 badge 独立。技能页标题不承担分类切换视觉。 |
| 筛选 / 视图按钮 | 定时任务模板类别、`ExpertToolbarView` | 小尺寸轻底色 / 边框，不使用导航的大色块。 |
| 选择卡片 | `agent-channel-views.tsx`、`SoulSlotCardView`、人设测试选项 | 边框 + 勾选表达选择；保留原有业务状态区别，不合并 selected 与 applied。A 方案采用浅底选项，并为勾选保留固定右侧空间。 |
| 表单 / 下拉 / 多选 | `ui/select.tsx`、`ui/dropdown-menu.tsx`、`automation-days-picker-view.tsx` | 保留原语的勾选和高亮语义；focus 与 checked 分开。 |
| 旧实现候选 | `agent-model-panel.tsx`、`agent-config/styles-index.css` 的 Tea selector | 未使用 `data-state=active` 的旧 Tab 不受本次同一规则直接影响；正式实施先查调用可达性，不全仓替换。 |

这是相关视觉类型的审查与方案清单，不宣称所有业务状态或海外站都已运行验收。

## 方案

- **A / 推荐：轻量分层。** 侧栏使用接近 Town / Coze 的浅中性整行底色；分段控件采用白色浮层；页面导航使用下划线。选中、hover、focus、disabled 独立表达。
- **B / 对照：强对比。** 页面 Tabs 保持下划线，分段选中为深色胶囊，导航增加左侧定位线。识别更明显，视觉重量更高。

两种方案均保持白底侧栏；顶部 Agent 与底部头像常驻，中间隐藏滚动条；按实际滚动边界出现阴影。头像向上菜单保留积分、升级与建议反馈（Demo 全为示例）。

## 已批准实现的依赖与边界

- 在 Agents 共享展示边界显式区分 `segmented` / `underline` / `choice`，移除当前全局 role + `!important` 染色。不要影响公开营销页 / account 的通用 Tabs。
- 保留 Radix 状态、键盘导航、Portal、focus return；页面 / controller 继续持有请求、Bot / Profile 身份、loading、权限和业务动作。
- Header 只调整布局，不改变重启 / 删除权限判断和 Bot 切换逻辑。
- Session 只调整视觉宿主，不改变选中会话、路由和删除生命周期。
- Skills 国内 / 国际的数据、分类内容、busy 逻辑和安装链路不变。Demo 的素材与文案仅为视觉背景，不是运营内容变更。
- 正式实现按项目流程补测试（Tab 变体隔离、整行选中、长名称、焦点及两站回归）；OpenCraft 副本只通过标准脚本同步。独立审查和验证结果记录在当前计划，不沿用 Demo 通过作为正式组件的通过依据。

## Demo 与验证边界

Demo 主文件：`.workflow/runtime/selected-state-demo/.superpowers/brainstorm/26244-1789612628/content/agent-selection-demo.html`。

本地视觉服务仅监听 `127.0.0.1`，默认闲置 4 小时关闭。服务带会话访问保护，URL 由当前工具返回，不写入仓库。

Demo 使用原生 button / details / select / checkbox 展示可操作状态；不模拟完整 ARIA Tabs 键盘模型，不替代正式 Radix 组件验证。已检查的浏览器证据在 `.workflow/runtime/selected-state-demo/verification.md` 记录。

用户已确认 A，B 仅保留为历史对照，不进入正式组件。
