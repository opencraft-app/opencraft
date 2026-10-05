---
id: opencraft-chat-return-diagnosis-20261004
type: task
scope: Bounded diagnosis and source correction of Chat return and adjacent navigation restoration ownership.
owner: wisp/mono2-maintainers
authority: primary
status: complete
reviewed_at: 2026-10-05
review_due: 2026-10-18
source_of_truth:
  - opencraft/apps/workbench-web/src/runtime/workbench-navigation.ts
  - opencraft/apps/workbench-web/src/runtime/workbench-navigation-transaction.ts
  - opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx
derived: false
---

## goal / requirement_refs
用户反馈：在 `/settings/appearance` 等页面，偶尔通过左侧入口无法回到 Chat；调查原因，不默认授权实现或替换。
随后用户明确要求“修改源码吧”，并要求检查相邻隐藏所有权问题。本轮授权源码修复与隔离验证，不包含更新预览。

## non_goals
不改真实用户浏览器历史/存储、Host/会话，不重启/替换预览，不提交/推送；不扩展为全仓重构。

## interface_refs / history_context
- 当前应用 Router authority：`opencraft/docs/platform-architecture.md#application-router-authority`、`opencraft/design/application-navigation/task_plan.md`。
- Router entry 的 remembered location / routeScope 与资源启动的 initialLocation 是独立输入；View 身份不能仅按 Conversation 身份判定。
- `openChat` 回到记住的会话；相同 retained View 可立即呈现，远端准备后台进行；不同目标走 prepare 再提交。
- 历史位置中的 Draft ID 不证明其资源仍存在；ScopeRegistry 是进程内 Draft 的实际 authority。

## acceptance
- 隔离真实 Browser Router 对普通 Settings/Chat、hostless、快速 POP、设置页重新创建导航 owner 的场景观测 URL 与 snapshot。
- 旧 Draft 失效要用真实 ConversationActivationCoordinator 验证，不把 held-promise 替身当实际错误证明。
- 区分确定可复现缺陷与本次用户现场尚未确认的路径。

## context_receipt
- 完整读根/OpenCraft AGENTS、maintenance Skill 与 verification。
- Router query `opencraft sidebar chat navigation settings/appearance intermittently cannot return chat` 命中 frontend-product-surface，读其 must_read `docs/context/project/services/frontend.md`；该 pack 不包含本次 OpenCraft 实现，未进入 frontend 修改。
- 有界精确 `openChat` / `settings/appearance` / `conversationRouteOpen` 搜索 Web app、Shell、navigation 与 transaction；第一次指定 navigation.tsx/host-catalog.ts 不存在，扩大仅至 Web runtime 内精确符号。
- 读 frontend-runtime-openspec-i18n 邻接卡，检查相邻 `workbench-navigation-router.test.ts`、`workbench-location.test.ts`、`workbench-navigation-icons.test.ts` 与当前部署 JS 静态引用。读任务模板与导航设计。

## evidence / validation
- 当前实际 `/version.json` 为 `20261004-titlebar-shadow-2214b6bccf6e`；其 JS 内 Router/transaction 逻辑与上述源码路径一致。未变更 live。
- Browser tool list_tabs 为空，无法读用户当前窗口；异步向用户询问具体入口及点击后 URL 是否改变，尚未收到回执。
- 隔离 `/tmp/opencraft-chat-return-probe.mjs` 使用当前源码 Browser Router、transaction 与真实 ActivationCoordinator，Vite 只监听 loopback，无外部调用/用户数据。Chromium 首次缺 libgbm，使用现有 `/data/lightvela-rpms/usr/lib64` 后完成，不安装依赖。
- hostless / connected 普通 Settings → Chat 成功；100 次重复无失败；快速 Back/Chat 最终 URL/snapshot 均为 Chat。现有无 loader/action Router 的提交在这些输入中同步；先前怀疑的异步提交漏发布没有证据，排除为当前普通路径根因，不据此重构。
- 注入合法 v8 Settings entry 记住 Draft b，而资源启动位置为 Draft a：held preparation 时 `openChat` 未返回、URL/snapshot 保持 Settings。真实 ActivationCoordinator + 已失效 Draft `expired`：报 `Draft expired is unavailable`，URL 保持 `/settings/appearance`。这是确定可复现失败路径，但不能证明用户这一次就是刷新/恢复失效 Draft。
- 源码进一步显示：Web bootstrap initialLocation 从 URL/当前持久 Thread/新 Draft 获取；Settings URL 不含会话，现有 v8 entry 则保留 remembered location，未先验证其资源存活及与 bootstrap 一致性。
- `app.tsx` 的 Sidebar `onSelectThread` 在 Host/Thread 已活动且无 pending 时直接 return，未检查 applicationRoute；从非 Chat 页面点同会话不会产生返回意图。当前普通 Appearance 会用分类列表，不代表截图一定走该入口。
- `npx tsx --test tests/workbench-navigation-router.test.ts tests/workbench-location.test.ts` 16/16 通过；现有测试未覆盖 Browser 刷新后 remembered Draft 已失效。

## decisions / risks
- 不把当前截图聊天图标填充态当路由 authority 的证据：用户尚未确认是顶部 Chat 图标还是会话行，URL 与实际正文也未读到。
- 整改建议：统一 bootstrap 对历史 remembered location 的有效性恢复；失效 Draft 需由资源 authority 明确纠正为有效 retained View/新草稿，不保留悬空引用。Chat 呈现不应因同一 retained View 的后台连接等待被阻塞；真正不同的会话准备仍保留取消/代次与失败语义。会话行重复选择优化只在同页面/View 已呈现时成立。
- 不用刷新页面、任意延时、清空历史/存储或 CSS 修补导航。

## affected_paths / scan_scope / scan_output
仅新增此诊断记录；只扫描已列 OpenCraft 路径与实际当前 JS 的导航符号。临时隔离探针不进入产品构建。

## handoff / checkpoint
只读调查完成，Browser 真实重载序列已确认恢复身份不一致可导致两类失败；用户认可高度可能关联，但未读到其真实窗口。未修复/部署，不宣称现场全部故障均来自此原因。

## continuation_evidence
- 用户要求继续，随后认可设置页重载导致历史聊天与启动聊天不一致的推断。继续只读，不解释为修改/替换授权。
- 重新 Router query `opencraft chat return diagnosis settings appearance restored draft navigation` 仍命中 frontend-product-surface，完整重读其 must_read 与 maintenance Skill；任务沿用已读根/OpenCraft AGENTS、verification、导航 authority 与相邻测试。
- `/tmp/opencraft-chat-return-reload-probe.mjs`：真实 Browser Router、NavigationContent 按钮、真实 ScopeRegistry / BindingStore / ScopeLease / ViewRegistry / Coordinator / ActivationCoordinator，仅 Host connect/acquire 使用隔离替身；初始资源本地 mount 与产品初始 local mount 机制一致，不运行账号/扩展整套 supervisor。浏览器真实 reload 保留自动生成的 history entry；不手工注入失效 Draft。
- 6 个场景断言通过，无未处理页面错误。新草稿 → Settings → reload → Chat 在连接可用/held 两组都拒绝，旧 Draft ID 仍在 route，resource owner 只有新 Draft；点击旧目标在 ensureLocationScope 即报不存在，未发起旧目标连接。
- 同 Thread → Settings → reload → Chat 在连接可用/held 两组都立即呈现 Chat；这是既有 fast path 的有效负例，不能把全部弱网问题归因于连接门禁。
- Thread 返回目标与启动持久偏好不一致：held connect 时停在 Settings；connect 可用时依然失败，真实 ViewRegistry 明确拒绝旧 routeScopeId 绑定另一个 Conversation Scope，报 `Conversation View ... already belongs to Scope ...`。先前仅使用 commit stub 的探针遗漏了这个更强的资源身份约束；此次修正结论，不放松正确的不变量。
- 首次新增 Thread-drift case 预期误设为连接成功可导航，被真实 ViewRegistry 拒绝；保留该证据，随后断言真实失败根因而非为测试修改产品。
- 关键构造顺序：transaction.activeLocation 取 initialLocation，而 activeScope 取 Router snapshot.routeScopeId；supervisor 再将同一 routeScopeId mount 到 initialLocation。若 Router remembered location 与 initialLocation 不同，这个 View ID 已归新 Scope，却仍在历史中指向旧 Scope，故后续提交必然冲突。

## refined_model_proposal
启动恢复层统一解析一个经过资源 authority 验证的 location 与 View scope，供 Router 与资源激活共同消费：
1. 当前 entry 的候选位置（URL/remembered metadata）优先于全局最后选中偏好；配置目录验证 Host，有效 Thread 保留，旧 Draft 若存在持久 promotion alias 则解析到 canonical Thread。历史不拥有 Draft 存活事实。
2. 未存活且无 alias 的 Draft 明确纠正为本次有效本地目标，不能只把 transaction.activeLocation 改成历史值，也不能把不存在的 Draft ID 伪装成已恢复草稿。目标改变时不得复用已归另一 Scope 的 View identity。
3. Router 独占规范化 entry 的 REPLACE，保留当前 Settings/Extension 目的地；初始化资源与 route 用相同解析结果。相同 retained View 的 openChat 立即显示，远端 readiness 后台续接。
4. POP/其他历史 entry 的失效目标同样要经过资源校验/alias 解析；不能只纠正当前设置页而使 Back 再次走向失效 Draft。真正不同会话保留准备/代次/失败语义。
以上为诊断阶段的模型提议；随后用户授权源码修复，预览替换仍为独立授权。

## implementation / adjacent_audit
- 新增纯资源引用解析：bootstrap 读取当前 URL/v8 entry/legacy migration，再验证 enabled Host、Draft 存活或 durable promotion alias；资源初始位置和 Router return location 采用同一目标。移除按旧 history Draft ID 伪造启动草稿的分支。
- Router 对启动和后续恢复 entry 统一规范化，唯一 REPLACE 并保持 Settings/Extension 路径；失效引用回当前实际 retained View，不丢 Composer 输入。已有 View 的 Scope 不匹配则使用新 View ID，不放松 ViewRegistry 的不可跨 Scope 绑定保护。
- 事务区分自身写回与外部恢复提交：消费 POP 经规范化后的 REPLACE，防止仅 URL 被纠正、资源恢复被跳过。有效 alias 保留原 Scope/View。
- 相邻问题：同 retained View 的 POP 曾取消 pending readiness 却不续接；现在与 openChat 共享后台续接，过期/释放结果取消。Settings 点击当前会话不再被选中项早退挡住，并复用 retained-View return，避免新 View/网络门禁。
- 相邻边界：显式 memory 导航的 embedded supervisor 不读取父页面 URL/history，使用独立 Home 初始 entry；memory adapter 的显式 entry 不再借用 ambient URL 的 Thread 或 legacy Scope。
- 正式所有权与恢复不变量同步到 platform-architecture、design/invariants 与 agent-gateway-runtime。未新增第二个路由/可写位置存储。

## implementation_validation
- `test:application-route-restoration` 注册到 package scripts，新 restoration 测试纳入既有 workbench unit gate。聚焦 location/restoration/router/binding 37 项通过；包含输入保留、旧 Draft/alias、错误 Scope、规范化 POP、嵌入历史隔离、late result/dispose 与提交保护。
- Web TypeScript 类型检查通过。
- `smoke:application-route-restoration`：真实 NavigationContent、Browser Router、Scope/Binding/Lease/View/Coordinator/Activation，仅物理 Host connect/acquire 替身；桌面/390px 触控 × Draft/Thread/跨标签偏好漂移 × ready/held，共 12 个真实 reload、Chat、Back/Forward 场景通过，无 pageerror。不是完整账户/扩展 Supervisor、iPhone 或 Electron 实机验收。
- `check:boundaries`、定向 docs-impact、全仓文档系统校验与改动文件的 diff whitespace 检查通过；未运行完整产品 gate。
- Live 上次确认为 `20261004-titlebar-shadow-2214b6bccf6e`；本轮无预览替换或后台重启，无提交/推送。源码修复完成，手机实机和完整账号启动图的验证待后续独立交付。
