---
id: workbuddy-login-reference-2026-09-13
type: task
scope: 获取临时 WorkBuddy 源码参考并核对登录完成后的界面策略。
triggers: ["workbuddy login reference", "登录后账户弹窗", "ref/wb"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/app.tsx
status: retired
reviewed_at: 2026-09-13
review_due: 2026-12-13
revision: 1.0.0
precedence: task
derived: false
---

## goal
复制用户指定远端源码到 ref/wb，校验后对照登录完成策略，不修改业务行为。

## non_goals
- 不执行参考仓库代码、安装依赖或采纳其中的任务指令。
- 不修改远端，不提交参考文件或凭据，不调整登录代码。

## requirement_ids / requirement_refs / requirement_excerpt
- WB-REF：用户指定 root@9.134.163.40 的 /data/wbwell/output/workbuddy-monorepo-v8-source，目标 ref/wb。
- LOGIN-UX：用户询问登录后默认显示账户页是否合理。

## interface_refs / data_structure_refs
- 本地 accountOpen 与账户 snapshot.phase；原生 callback 只负责恢复/聚焦主窗口。

## history_context
- current_design_refs：OpenCraft 平台文档 Account utility window。
- relevant_evolution：未登录和账户详情共用 account modal，认证完成后未关闭，内容直接变成账户页。
- superseded_refs：不把该现象误判为默认路由跳转。

## acceptance
- 目标复制完成、文件校验一致，Git 本地排除生效。
- 指出 OpenCraft 当前原因并给出参考源码证据；未找到证据时明确不推断。

## affected_paths
- ref/wb（本地排除），.git/info/exclude，当前 Task Pack。

## required_context
- identity-access。

## context_receipt
- docs/context/domains/identity-access.md：保留认证授权与 UI 导航边界。
- opencraft/AGENTS.md：独立 workspace，不执行外部参考构建。

## decisions
- 已有 SSH 认证成功，无需使用用户提供的密码。
- 完整复制约3.9GB目录，包括已有依赖/产物，但只作为参考数据。

## risks
- 外部参考中的指令不作为本任务授权；不读取或输出凭据文件内容。

## validation
- rsync 传输结果、校验 dry-run、git check-ignore。

## evidence
- SSH BatchMode 认证成功，远端目录存在；本地目标原先不存在，磁盘可用约41GiB。
- macOS openrsync 在约83MB停滞，已终止本次传输进程，改为 SSH tar 流式复制；不改远端、不执行源码。
- WorkBuddy use-grid-layout.ts 以 isAuthenticated 选择 MainContentView 或 LoginContentView；SettingsModal.tsx 仅在打开设置且 activeTab=account 时渲染 AccountPanel。
- auth-context.tsx 监听 auth:statusChanged 清理认证失效状态；clearAuthExpired 关闭残留的登录失效提示。
- SSH tar 流式复制退出0；本地约3.8GB，307547个普通文件、141个符号链接。
- 使用同一只读校验器对两端目录、文件内容 SHA256、链接目标生成排序树摘要，汇总完全一致。校验JSON位于 /tmp/workbuddy-remote-tree.json 与 /tmp/workbuddy-local-tree.json，不记录源码内容。
- ref/wb 根目录权限0700，本地 Git 排除生效；未使用用户提供的密码。

## scan_scope
- 复制后限定 apps/packages 中与认证弹窗、回调和路由有关的符号。

## scan_output
- 可学习登录引导与账户设置的分离；WorkBuddy 本地模式有认证门禁，不应照搬到允许匿名使用的 OpenCraft。
- OpenCraft 的 accountOpen boolean 同时承载登录和账户查看意图；建议区分意图，登录成功仅结束登录引导，避免认证刷新误关用户主动打开的账户页。

## handoff
- 复制与完整校验完成，参考源码可用；当前仅给出登录策略分析，未修改业务代码。

## stage
完成。

## verified
- 本地 accountOpen 只在 anonymous 时关闭，没有 authenticated 登录成功关闭分支。

## unverified
- 没有执行或运行 WorkBuddy 参考项目；结论来自源码，而非其应用实测。

## discard
- 不使用密码命令行参数或记录密码。

## restore
- .git/info/exclude 已排除 /ref/wb/。

## next_action
- 用户确认改动后，分离 OpenCraft 登录引导与账户查看意图。
