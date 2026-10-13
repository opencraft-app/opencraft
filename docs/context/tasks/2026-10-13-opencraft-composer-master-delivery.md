# OpenCraft Composer 与 Tooltip 主干交付

## goal / requirement_refs
用户明确要求将已确认的 OpenCraft 界面调整提交 mono2 master。

## non_goals
不发布生产、不修改 GitOps、不提交其他工作区中尚未交付的文件卡片或后端改动。

## context_receipt / history_context
读取根与 OpenCraft AGENTS、维护 Skill、工蜂 Skill、前端服务上下文及邻接卡，检查相邻 Composer 与嵌入测试。Context Router 命中 frontend-product-surface。基于最新 master af50066fe 整理差异；侧栏外部触摸收起、权限中文化、移动标题和参与者等前序改动已经存在于 master，不重复提交。

## decisions / interface_refs / affected_paths
Composer 空段落占位改为 node decoration 属性和伪元素；coarse 主指针的普通 Enter 换行；新建会话未显式选择权限时采用 Host 声明可用的 full profile。已有会话、显式选择、代码/列表/建议优先级保持原语义。ui-preferences 缺省 followup queue，保留用户显式 steer。独立和嵌入复用 companion 提示及64px桌面/48px手机编辑区；删除嵌入专用高度覆盖。Sidebar 来源小球复用共享 Radix Tooltip 和 Presentation Root Portal，文案可选中。同步相关正式设计与聚焦验证。

## acceptance / validation
相关 typecheck、45项聚焦测试与平台边界通过。隔离浏览器验证移动粘贴/换行/真实权限选择、默认队列/偏好同步、独立和Shadow DOM编辑高度、Tooltip hover/focus/选中文字；完整Web构建及文档门禁。仅从核对后的提交推送master，不强推。

## risks / evidence
隔离 checkout 初始缺少共享目录的依赖解析入口，使用同一 checkout 自己安装的 npm 依赖补齐；浏览器fixture避免扫描整个站点并显式预构建React/Intl依赖。iPhone原生长按菜单尚无实机证据。运行独立预览已在前序更新；主干提交不代表LightVela生产发布。

## handoff
最新master上的workbench-web typecheck、45项聚焦测试、check:boundaries、完整Web构建、文档及staged影响门禁通过。真实浏览器验证手机原生Chromium paste、两种Enter路径、实际full选择、已有及显式选择保留；默认queue/跨窗口偏好同步；12组viewport/指针类型×4个独立/Shadow DOM新建/已有编辑器高度及长文滚动；Tooltip hover transfer/选中/focus/Escape/原行点击均通过。iPhone系统长按菜单仍未实机确认。待核对远端接收结果。
