# Application navigation refactor

## Goal / non-goals
One Router authority for desktop/Web and connected/hostless application routes. Preserve Host, Thread, Draft and View ownership. No deployment, user-data migration, backend changes or unrelated UI redesign.

## Phases
- [x] Red: route publication, late navigation, true POP/forward, Chat return and hostless tests.
- [x] Replace handwritten History mutations with React Router memory/browser adapters.
- [x] Migrate transactions and both Shells; retain resource lifecycle.
- [x] Type/tests/build, Electron navigation sequences, AGENTS and formal contract.

## Contract
- Desktop uses memory routing; Web uses browser routing. Navigation survives Settings transitions, not a promise of cross-process desktop history persistence.
- openChat is explicit return to the remembered conversation (or Home), never a disguised history.back. Home creates/presents a draft separately.
- Router owns path/key/state/action. View identity is distinct from conversation identity. History controls consume a projection of Router entries, not a competing path writer.
- Navigation intent invalidates older async work; failed or late preparation does not alter the destination/history. POP targets restore their own View; failure has explicit rollback.
- No Host is a supported state of the same application router, not a second history implementation.
- Sidebar A→B→A selects the last successfully presented, still-owned input slot. A bounded canonical-conversation map remembers it; failed/late navigation never does. Explicit navigate creates an independent View; POP keeps its entry.
- Presentation and input budgets are independent: 20 inactive Views versus 50 nonempty draft owners. Evicting a View preserves its input; input eviction revokes the preferred slot. Promotion updates retained input even if the old presentation was evicted. Account changes clear preferred memory and fence unaccepted navigation.

## Errors
The old history spy tests failed after migration because they asserted direct window.history calls; replaced them with actual Memory Router POP/destination assertions. Red tests proved same-location publication and stale preparation faults before implementation. Remaining validation in progress.

## Handoff
Refactor and focused acceptance complete. 50 navigation/activation/chrome/legacy-route tests pass; Web/runtime typechecks, boundaries and Electron build pass. Full Workbench suite retains its pre-existing typography assertion failure; not an all-green gate claim. Real browser owner reset + reload/forward and real Electron Settings/Back/Forward/Chat with preserved draft passed. Installation/release not performed.

## 应用导航不变量

- 应用 Router 是路径、entry key、PUSH/REPLACE/POP 的唯一写入者；Electron 使用 Memory Router，Web 使用 Browser Router。入口在 `runtime/workbench-navigation.ts`，有无 Host 使用同一模型，不在页面手写 History API 或第二份 applicationRoute。
- `openChat`（回到记住的聊天）、`navigateToHome`（新草稿）、`openSettings` 与 `back/forward` 是不同意图；应用切换不得伪装成 `history.back()`。正常目的地进入历史，权限/失效路由纠正才 replace。
- Conversation 身份、View/routeScope 身份、历史 entry key 分开。相同会话不代表相同页面；路由或 View 改变必须通知消费者，POP 恢复目标 entry 的 View。
- 所有异步导航受意图代次与 owner 生命周期约束；新意图/销毁撤销旧准备及临时 lease。失败不能先修改历史再猜测回滚，迟到成功或错误不能抢回页面。路由显示不要求重建 Host/Thread/Draft。
- 历史按钮只是 Router 已知条目的投影，不是另一套导航权威。桌面内存历史不宣称跨进程持久化；Web 刷新回执不能替代实际 Router entry 校验。
- 修改导航必须测试真实 PUSH/REPLACE/POP 后的目的地、同会话多 View、hostless、快速切换/晚到结果、失败与失效页面返回；不能只断言调用了 go(-1)。
