---
id: opencraft-navigation-ownership-20261005
type: task
scope: Standardize conversation selection and navigation restoration ownership.
owner: wisp/mono2-maintainers
authority: primary
status: complete
reviewed_at: 2026-10-05
review_due: 2026-10-19
source_of_truth:
  - opencraft/apps/workbench-web/src/runtime/workbench-navigation-transaction.ts
derived: false
---

## goal / requirement_refs
修复设置页刷新后无法返回聊天及相邻导航所有权问题。用户明确授权源码修改、预览替换，并于 2026-10-05 授权“提交推送合入master”。

## non_goals
不合入共享工作区的无关 SSH、移动端、执行队列、设计系统或其它服务修改；不修改 GitOps、云资源、生产环境或公开镜像；本次 Git 交付不重启预览或后台。

## interface_refs / history_context
- Router 独占路径与历史写入；ActivationCoordinator 接受/释放资源；ScopeRegistry、BindingStore、ViewRegistry 持有资源身份与生命周期。
- 历史是资源引用，不是 Draft 存活证据；同一 Thread 的不同 View 保持独立输入。
- 当前设计见 [Application Router authority](../../../opencraft/docs/platform-architecture.md#application-router-authority) 和 [工作区不变量](../../../opencraft/design/invariants.md#application-navigation-restoration)。
- 有界参考：Codex macOS 26.930.31428/build12913 原始 bundle 的 ThreadScope/RouteScope、条件草稿转换和恢复资格。不执行参考代码、不照搬私有宿主、不将符号恢复当作线上行为证明。

## acceptance / affected_paths
设置/扩展页返回当前保留 View 不等待网络；有效 entry 优先于共享偏好；过期 Draft 不按旧 ID 重建；已提交别名映射到 Thread；重复选择、晚到结果、销毁、失败释放和 POP 规范化具有单一事务 owner。
范围为 Web app/runtime 导航入口、相邻测试及 smoke、package 脚本和正式导航设计，不改变共享协议。

## required_context / context_receipt
根与 OpenCraft AGENTS、维护 Skill 及 verification、frontend-service-detail、frontend-runtime-openspec-i18n 邻接卡、release-gitops 边界、Task/Checkpoint 模板、导航正式设计及原导航任务已读。Context Router 命中 frontend-product-surface，但本任务不修改 frontend；有界邻居为本次实际导航测试和 Browser Router smoke。
维护 Skill 要求资源所有权、失败/取消语义和真实界面证据；Git 阶段从最新 master 隔离提交，不借用混合工作区依赖或覆盖 master 新的嵌入启动逻辑。

## decisions / risks
资源解析统一在 workbench-location-restoration，Router 写回纠正结果并保留应用目的地；显式 memory 启动隔离外层历史。侧栏只发 selectConversation；事务按位置和 View 合并准备，统一 intent/lifetime/revision 资格及接受/释放，草稿转换必须仍拥有活动 Draft。最后使用偏好仅记录仍有效的命令结果。
原工作区包含大量无关变更且分支属于另一任务，因此从远端 master 040af895f 建立独立功能分支，逐 hunk 提取；保留 master 的嵌入账户、模型、物理连接、记忆隔离与启动改动。

## validation / evidence
在独立分支及其自身 npm ci 依赖上完成：
- test:application-route-restoration：48/48。
- smoke:application-route-restoration：20/20 桌面和触控场景，真实 Sidebar/NavigationContent/Browser Router 与资源注册表；仅物理连接隔离替身，无真实 Host 写入。
- Web 类型检查、check:boundaries/typography 通过。
- 相邻嵌入 authority/Host profile、Thread fork、首次提交与 Web Host 回归 25/25，通过且保留 master 新的嵌入隔离契约。
- preview-bridge 与 Web 生产构建通过；既有动态导入及大 chunk 提示保留。
- 暂存区 docs-impact、文档系统（26 个服务、无失效一方链接）、敏感信息和 whitespace 检查通过。映射的高风险正式设计已同步，合入仍遵守远端保护。

## scan_scope / scan_output
限定导航入口与相邻测试、正式设计；不扫描固定参考项目或无关私有数据。不提交构建产物、依赖、机器路径或凭据。

## handoff / checkpoint
实现和独立源码验收完成。此前临时预览已完成前端资源核验；本 Git 交付不会重启或替换后台。手机实机、Electron、完整账号/模型链路与全产品 gate 未在本阶段验证。
下一步：暂存区检查、提交、推送功能分支、合入远端 master 并核对包含关系；若远端保护要求评审，遵守门禁而不强推。
