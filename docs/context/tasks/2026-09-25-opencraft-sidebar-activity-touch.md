## goal
触控滚动 Sidebar Activity 列表时不出现粘滞的鼠标 hover 背景/操作按钮；触屏仍能直接打开会话操作菜单，鼠标与键盘路径保持可用。

## non_goals
- 不改变 Thread/Server 身份、会话排序或导航目标。
- 不借触控修复重做整个 Sidebar 布局或改变生产服务。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-25-sidebar-touch`: 用户提供 iPhone 截图，指出活动侧边栏拖动时也会出现 hover，触控体验不佳。

## interface_refs / data_structure_refs
- `SidebarActivityItem` 是会话主按钮；`ThreadRowMenu` 的独立 `DropdownMenu.Trigger` 是“…”操作入口。
- `.sidebar-activity-item:hover` 和 `.sidebar-activity-row:hover .sidebar-activity-item__menu-trigger` 是当前视觉触发条件；`is-selected` 是独立的路由选择状态。

## history_context
- `current_design_refs`: `opencraft/design/invariants.md` 的 WSP-24、`opencraft/design/README.md`、`opencraft/docs/platform-architecture.md`。
- `relevant_evolution`: Sidebar Activity 双行项目及独立菜单按钮已实现；菜单默认隐藏，仅 hover/focus/open 时显示。
- `superseded_refs`: 无。

## acceptance
- iPhone 触控拖动列表时非当前行不获得鼠标 hover 背景；滚动持续工作，不误触发菜单或导航。
- 无 hover 输入的设备中，“…”菜单直接可见、可触达，触控命中区足够大，且不盖住来源/状态尾部槽位。
- 桌面鼠标 hover 与键盘 focus-visible 仍可访问菜单；`is-selected` 不被误当 hover 清除。
- 聚焦测试、Web typecheck、样式构建通过；真实 iPhone 拖动与菜单点击仍须在新版页面验收。若交付运行服务，另核对其 buildId。

## affected_paths
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/apps/workbench-web/src/components/sidebar.tsx`（如需输入模态守卫）
- `opencraft/design/invariants.md`
- `opencraft/tests/sidebar-activity.test.ts`

## required_context
- 根 Context Router 查询 `opencraft mobile activity sidebar touch hover drag list interaction` 无匹配 Pack；随后在 OpenCraft sidebar 目录有界检索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 交互改动维护准则 | 区分 hover 与选择并保护触控/鼠标/键盘 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 验证清单 | 选择真实组件/浏览器检查 |
| `opencraft/design/README.md@working-tree`、`opencraft/design/invariants.md@working-tree` | Sidebar 正式设计 | 维护 WSP-24 邻接不变量 |
| `opencraft/apps/workbench-web/src/components/sidebar-activity-item.tsx@working-tree` | 主行结构 | 确定选择态和尾部槽位 |
| `opencraft/apps/workbench-web/src/components/thread-management.tsx@working-tree` | 菜单结构 | 确定独立 Radix trigger 与触控可达性 |
| `opencraft/tests/sidebar-activity.test.ts@working-tree` | 相邻测试 | 增补视觉交互回归 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 前端邻接卡 | 核对测试/构建邻居，不涉及其 frontend 真源 |

## evidence
- 截图中非当前行出现 hover 底色和“…”按钮；当前 CSS 对 `:hover` 无输入能力限定，触屏浏览器可保留模拟 hover。
- 仅删除 hover 规则会令默认 `opacity:0; pointer-events:none` 的“…”按钮在触屏不可用，因此触控入口必须显式呈现。
- 用户在部署后确认“…”常显已生效，但手指滑动仍有问题。复查实际构建 CSS 发现 `controls.quiet-control` mixin 另行生成了 `.sidebar-activity-item:hover:not(:disabled)`，此前的活动行局部 hover 守卫没有覆盖这条共享规则；这能解释触摸模拟 hover 下的行底色仍出现。用户具体滑动序列尚待确认，不能据此断言所有触摸问题均已解决。

## risks
- 常显触控菜单需要占用一部分行尾空间，必须保护状态/来源图标和正文截断。
- 混合触控+鼠标设备的输入能力与当前触点可能不同；需要选择媒体查询或输入模态守卫并测试。

## validation
- `sidebar-activity.test.ts` 与 `workbench-sidebar-dock.test.ts`：25/25 通过。测试还修正了已有的菜单文案断言，使其匹配真实模板字符串插值。
- Shell-space、floating-sidebar-layout、context-pane-geometry：17/17 通过。
- Web `tsc --noEmit` 通过；Vite Web 构建通过，构建 CSS 已核对包含精细指针 hover 守卫、触控输入标志和 44px 触控菜单入口。
- `git diff --check` 通过。当前环境未安装可用的移动端浏览器自动化，未做真实 iPhone 触控验收。
- 根文档校验通过（0 errors、0 warnings、0 broken first-party links）。`validate_change_impact --staged` 通过，但当前没有 staged 文件，因此不作为本次改动覆盖的独立证据。
- 用户随后明确授权替换当前运行服务。完整 Linux headless 包构建成功，SHA-256 `40e759ba730cc08479fa9ab46458369870690463ad58e5fd7dacd2c74f2a61b2`，buildId `20260925022532-668d30451312`；独立 headless smoke 通过。包内 CSS 包含触控守卫和 44px 菜单入口；新旧 server runtime bundle 的 SHA-256 相同，服务端逻辑未变。
- `opencraft-deploy-stage-40e759ba.service` 已独立校验归档路径、manifest 的 30442 个文件及 Web/server buildId，并暂存 `/opt/opencraft-server/releases/40e759ba730cc084`。旧服务仍运行 buildId `20260925014314-dfc676efa06a`。
- `opencraft-deploy-activate-40e759ba.service` 成功切换；当前 `current` 指向 `/opt/opencraft-server/releases/40e759ba730cc084`，服务 active、`NRestarts=0`，健康端点通过，`/version.json` 与 HTTP 首页均为 buildId `20260925022532-668d30451312`。实际 release 中的 CSS 含触控守卫、粗指针菜单与 44px 命中区。
- 后续修正：`quiet-control` 增加可关闭默认 hover 的选项，Activity 行关闭该选项，其他控件仍保留默认交互。聚焦测试 25/25、Web typecheck 与 Vite 构建通过；编译 CSS 已核对不存在无条件 `.sidebar-activity-item:hover:not(:disabled)`，而鼠标条件式 hover 和触屏菜单仍存在。此修正尚未部署。
- 修正后完整 Linux 包 SHA-256 `8a96e30efd894118b64058d8605f3bdfcd5fbfbc9e8f8f53fe8d88b2e404c074`，buildId `20260925024353-72c7b9ab13f4`；独立 headless smoke、平台边界与 typography check 均通过。当前服务仍运行旧 buildId。
- `opencraft-deploy-stage-8a96e30e.service` 成功校验 30442 个文件并暂存 `/opt/opencraft-server/releases/8a96e30efd894118`；暂存包与现版 server runtime SHA-256 一致，实际暂存 CSS 无无条件 Activity hover，保留鼠标守卫和 44px 触控入口。
- `opencraft-deploy-activate-8a96e30e.service` Result=success，当前 release `/opt/opencraft-server/releases/8a96e30efd894118`，MainPID `1943887`、`NRestarts=0`；健康端点及 `/version.json` 返回新 buildId `20260925024353-72c7b9ab13f4`。

## decisions
- Hover 是鼠标 affordance，不代表当前会话；选择态继续由 `is-selected`/`aria-current` 控制。
- 无 hover 设备不依赖首次触碰来揭示菜单。

## scan_scope
- `opencraft/apps/workbench-web/src/components/sidebar*`、`thread-management.tsx`、`styles/app.scss` Activity 区域与相邻测试。

## scan_output
- 精确命中 `.sidebar-activity-item:hover` 与 `.sidebar-activity-row:hover`，入口位于 `Sidebar` → `ThreadRowMenu` → `SidebarActivityItem`。

## handoff
- 源码与运行服务均已更新；旧 release 和旧包备份保留以备回退。部署脚本为 `opencraft/release/.deploy-sidebar-touch-40e759ba.sh`。启动健康轮询的两次空 HTTP 响应产生 JSON 解析警告，但最终部署任务 result=success，服务已稳定通过健康和版本检查。
- 下一步需在新版页面以手指按住、拖动、松开列表，检查非选中行不出现粘滞 hover；再点每行“…”并验证菜单、来源/状态图标与正文截断。
- 用户报告首次部署后仍有滑动问题；源码已修复共享 `quiet-control` 遗留 hover，但尚未替换正在运行的 buildId `20260925022532-668d30451312`，亦未收到具体触控症状的进一步确认。不得把这次源码修正描述为线上已生效。
- 用户报告首次部署后仍有滑动问题；源码已修复共享 `quiet-control` 遗留 hover，新包已切换且服务健康，但尚未收到具体触控症状的进一步确认与手机实测，不得宣称滑动体验已完全解决。
- 用户确认触控/桌面仍应是一套设计系统：同一 Activity 组件、状态与 token，仅输入能力决定瞬时 hover 和菜单命中区；不维护两套业务语义或页面。
