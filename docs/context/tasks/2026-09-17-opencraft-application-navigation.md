## goal
统一应用导航并修复设置返回、Chat 切换、历史和异步竞态；将不变量写入 AGENTS。

## non_goals
不发布、不改云端、不重建会话资源层、不承诺桌面跨进程历史持久化。

## requirement_refs
用户批准“开始重构”，追加“导航模型写入 AGENTS.md”。

## interface_refs / history_context
workbench-navigation、workbench-navigation-transaction、HostlessWorkbench、ConversationActivationCoordinator。当前正式架构为 opencraft/docs/platform-architecture.md；ref/codex、ref/wb、ref/bb 仅参考。

## acceptance
真正的 PUSH/REPLACE/POP、同会话不同视图、Settings/Chat/Home、hostless、晚到准备结果与回滚；类型/测试/构建及隔离 Electron 验证。

## context_receipt
根/OpenCraft AGENTS；frontend-service-detail（router must_read）；OpenCraft 维护技能及验证清单、platform-architecture、既有 adjacency frontend-runtime 与 vitest 邻居；TDD/planning/React/desktop 技能。本次文档仅补既有责任面，不开启全仓 context 审计。

## affected_paths
opencraft/apps/workbench-web/src/runtime/workbench-navigation*、hostless-workbench、app、runtime context；导航测试；设计文档与 AGENTS。

## stage / handoff
已完成导航重构与 AGENTS 更新；详细计划、证据和失败记录在 opencraft/design/application-navigation/。

## verified
- 同一 Router 算法与平台 memory/browser 适配；hostless 手写 History 已删除。
- 50 项导航/激活/窗口测试通过；Web/runtime typecheck、boundaries、Electron build 通过。
- Browser 实际刷新后 forward 恢复；Electron 实际点击 Settings/Back/Forward/Chat 保持草稿。
- Shell 分隔条命中区域不再覆盖标题栏；AGENTS 与正式领域文档同步。

## unverified
完整 Workbench 门禁仍有已有 typography source assertion 失败，不宣称全绿。桌面跨进程历史持久化不在契约内；未替换安装版、未付费调用。

## restore / next_action
如需安装版验收，另行确认打包/替换。源代码保持未提交，保留其他人的脏改动。
