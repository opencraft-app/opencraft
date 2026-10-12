---
id: opencraft-sidebar-dismiss-20261013
type: task
scope: 手机浮动侧栏外部点击收起的修复与预览交付。
triggers: ["opencraft sidebar dismiss", "手机侧栏空白点击", "opencraft outside touch"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/design/invariants.md
  - opencraft/docs/platform-architecture.md
status: active
reviewed_at: 2026-10-13
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids

OC-SIDEBAR-DISMISS-20261013：用户报告手机展开侧栏后，点击右侧无焦点空白不能收起。恢复首次外部点击收起且不穿透正文的既有契约。

## requirement_refs / requirement_excerpt

当前用户会话：“侧边栏的右侧空白区域……点击后，左边的侧边栏并不回缩。”此前提交、MR 和当前预览切换授权沿用。

## non_goals

不增加焦点监听或另一套侧栏状态，不修改停靠偏好、Host 或会话数据。

## interface_refs / data_structure_refs

`opencraft/apps/workbench-web/src/components/app-shell.tsx` 已有透明关闭层和 `dismissFloatingSidebar`，退出期间保留覆盖层。`styles/app.scss` 的覆盖宿主使用 pointer-events:none，关闭按钮缺少自己的覆盖值，因继承而不参与点击命中。

## history_context / decisions

- current_design_refs：设计 WSP-11、平台浮动侧栏章节及工程运行时 Domain。
- relevant_evolution：旧构建真实命中测试确认关闭层继承了宿主的指针穿透；既有关闭动作本身无需修改。
- superseded_refs：无。

正式约束为设计 WSP-11 及平台浮动侧栏章节。只在透明关闭层显式恢复 pointer-events:auto，继续复用 Shell 关闭动作、退出动画和内容 Portal。内部层级与操作保持原 owner。

## context_receipt

根与 OpenCraft AGENTS、维护 Skill 及验证清单已在本任务读取。Router 查询 `opencraft sidebar floating dismiss outside pointer touch` 无匹配；在 AppShell、浮动侧栏、共享导航和样式中有界搜索；检查相邻侧栏模型测试与真实拓扑 smoke。

## validation / evidence

- 旧实际 Web 构建的手机触摸复现：外部点命中 thread-content，关闭层 computed pointer-events 为 none，侧栏保持展开。
- Web 类型检查、37 项侧栏/导航/几何回归、平台边界/字体和 Web 构建通过。
- 真实统一 AppShell 拓扑 smoke 使用带 viewport 的手机触摸页，验证内部操作不关闭、首次空白触摸只关闭侧栏、第二次正文恢复交互、草稿保留，以及原有宽度、内容节点与滚动约束。
- 新 Web 构建在真实 Workbench 与隔离合成原生/身份边界验证命中关闭层，首次触摸不穿透，退出后正文恢复交互；不调用付费模型或改用户数据。
- 旧并排 rail 的 shared-sidebar smoke 在原有 Chat 入口等待阶段超时，未改该旧 fixture，不声称该脚本通过。
- 正式设计同步；运行产物、机器路径和凭据不进入 Git。发布使用当前 PID、版本与 runtime 摘要守卫，先写不可变资源，再原子替换入口，失败恢复旧入口。

当前预览已更新到 `20261013-sidebar-dismiss-preview`；新浏览器阻断会话 RPC，只读验证实际页面手机触摸关闭、Composer 可见且无页面异常，AppServer 进程与 runtime 保持原样。

## acceptance / risks / handoff

手机外侧点击或触摸收起浮动侧栏，内部交互可用，退出前不点穿正文；鼠标与停靠布局复用原行为。物理 iPhone 与 Electron 成品未验证。原 Tasks MR !5269 在修复提交期间由工蜂合入，merge commit 为 `ec7ec13a7`，其源提交是 `d729dc1a`，不包含本次修复。侧栏补丁以独立后续 MR 交付；合入仍受工蜂至少一位评审通过的门禁约束，不能冒充已合入。
