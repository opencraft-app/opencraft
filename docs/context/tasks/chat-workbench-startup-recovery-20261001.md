# 国内隐藏 Chat 工作台交接与启动错误修复

## goal
修复工作台模板文字进入新版 Chat 丢失、gateway 启动终态错误分类 cleanup 后丢失，并发布国内隐藏生产。

## non_goals
- 不修改 show() toggle 或开放入口，不发布国际站。
- 不调整 Pass/隔离、账单，不绕过实例 resume 权益守卫，不重启共享基础设施。

## requirement_refs / requirement_excerpt
本次用户明确授权“把这俩修了发生产吧，直接闭环”，并再次要求“和之前一样隐藏show发布”。

## interface_refs / data_structure_refs
- frontend 的 pending workbench prompt sessionStorage 与 AgentChatMigrationSurface。
- Embedded element submitPrompt(requestId, text)，App/Composer 的 SubmitIntent 接纳边界。
- Workbench runtime automaticReconnectBlock 与 TransportStatus failure/recovery。

## history_context
current_design_refs: opencraft/docs/platform-architecture.md、opencraft/docs/chat-ui-architecture.md、docs/engineering/domains/agent-gateway-runtime.md、docs/engineering/journeys/source-to-production.md。
调查版本 48905e3f8313；开发基线 d68d2757ea5f。旧发送器只挂在 legacy；cleanup 抹掉 transport error 已有线上事件证据。

## acceptance
- 模板仅在匹配 Host、新 Draft、ready 和 active 时交接；拒绝/失败保留，接纳不重复。
- manual failure cleanup 后分类保留，显式新尝试/成功清除。
- 原有国内 show() 隐藏入口测试保持不变。
- 国内 release SHA/embed 制品及线上业务路径验收；隔离实例恢复成功另受 PASS_ISOLATED 守卫限制。

## affected_paths
frontend/src/pages/marketing、opencraft/apps/workbench-web/src/embedded-chat、opencraft/apps/workbench-web/src/app.tsx、opencraft/packages/workbench-runtime/src/appserver-runtime.ts。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、frontend/AGENTS.md、opencraft/AGENTS.md | 安全/服务门禁 | 独立工作区，不触碰既有 dirty |
| docs/context/domains/release-gitops.md | 发布路由 | 源码与上线证据分层 |
| docs/context/domains/agent-gateway-runtime.md | 运行时所有权 | 在 runtime 保留终态 |
| opencraft/docs/platform-architecture.md、docs/chat-ui-architecture.md | 嵌入/Composer | 同一 owner 接纳与草稿保护 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md、references/verification.md | 平台维护 | 聚焦真实边界测试 |
| .agents/skills/devops-pipeline/SKILL.md、reference | 流水线 | live discovery，绑定 SHA |
| .ci/README.md、.ci/frontend.yml、.ci/templates/frontend-edgeone-release.yml | 前端制品 | 国内 EO 归档制品发布，不冒充 Argo |

## evidence
证据目录 /tmp/lightvela-chat-validation-20261001。启动 regression 修复前 2 failed，修复后通过。其余测试/发布持续补充。

## risks
- 已有用户 Draft 不覆盖；pending 留存等待用户处理。
- 断线不重放已接纳请求；Conversation 拥有失败重试。
- PASS_ISOLATED 禁止测试机恢复；不扩大权限。

## validation
frontend focused/full tests、check/typecheck、国内 build；opencraft embedded-ci、相关 typecheck、boundaries、release embedded build；change-impact 与 docs；线上版本/隐藏 gate/公共实际链路。

## decisions
保持 show() 国内隐藏 gate 原代码；仅国内 EO 发布。终态源头修复，不在 UI 粘住旧错误。

## checkpoint
实现完成。frontend 聚焦 27/27、check 0 new diagnostics、国内 Next build；OpenCraft embedded-ci 初次 153/153（新增分类测试后须复跑）、相关两 workspace typecheck、boundaries 与 release embed build 通过。真实构建组件 smoke-console-embedded PASS（默认不请求模块、隐藏 show 开关、manual error/retry 提示稳定、无 pageerror）。前端全量：23 failed suites，未修改基线的同一 23 suites 亦失败；单独 renewal 7/12 失败在 baseline 与 modified 完全一致（SDK CSS loader）。全量不是绿色，不伪称通过。尚未合并/发布。
