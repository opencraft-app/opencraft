## goal
修复 DSH 新建分支工具继承报错与模型身份丢失。

## non_goals
- 不升级 DSH、不修改 ref、不发布或替换 Applications，不创建新历史/模型存储。

## requirement_refs / requirement_excerpt
本任务用户：“你看看 deepseek harness web 怎么建模以及codex怎么聪明建模，我们来整改。”

## interface_refs / data_structure_refs
DynamicToolSpec / DshHostCapability；ThreadCatalog.configuration；thread/start、fork、resume、turn/start。

## history_context
current_design_refs: opencraft/design/dsh-jit-history.md；opencraft/docs/platform-architecture.md。
relevant_evolution: 只读恢复不能回退到强制 Agent activation；会话配置已由 Catalog 持久化。

## acceptance
空白新建及 fork 有真实模型；非法工具不创建分支；namespace/普通工具继承且 owner 隔离；重启恢复绑定；冷 resume 不激活。

## affected_paths
opencraft/apps/local-agent-host/src/{main,dsh-capability-broker,dsh-appserver-adapter,thread-lifecycle}.ts；对应测试与 smoke。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md / opencraft/AGENTS.md | 权限与入口 | 无部署、保留脏改动 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md / references/verification.md | 模型/运行时维护 | 独立 profile 与合成推理 |
| opencraft/docs/platform-architecture.md | owner | 复用 Catalog |
| opencraft/docs/local-agent-custom-providers.md | 模型 authority | 默认与会话选择分离 |
| opencraft/docs/chat-ui-architecture.md | 恢复 | 保持共享协议 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md / frontend/vitest.config.ts | 最近邻居 | 确认前端测试不等于 Host 测试，无需改前端 |

## evidence / validation
Context router 无匹配；已在 local-agent-host 与 ref/codex/conversations 精确搜索。计划与证据见 opencraft/design/dsh-thread-bindings/。

## risks / handoff
DSH Web 原生选择是进程态，不直接照搬持久化策略。实现与隔离验收完成，未提交或发布。

## stage
已完成源码整改与相关验证；安装版更新不在本次授权内。

## verified
- DSH 专项 218/218、broker/lifecycle 14/14、Host typecheck、boundaries、Electron 构建通过。
- 真实隔离 DSH：空白 fork/显式覆盖/临时 fork、重启模型绑定、冷工具注册、首次执行中包含继承工具；非法 shape/schema 不创建线程。
- Electron：冷打开空白父/子会话均显示真实模型，菜单新建分支成功，无工具或模型不可用错误。
- 文档 impact 显式变更集通过；staged 空集；diff --check 通过。

## unverified
- 未替换 /Applications 安装版；未对用户历史会话执行写操作或付费模型推理。
- 任意网络/进程故障后的跨 native/catalog/broker 原子提交不由这次 shape/schema 预检保证。

## discard / restore
不把 DSH Web 的未执行选择持久化能力当事实；续接读 opencraft/design/dsh-thread-bindings/ 与 JIT 契约。

## next_action
用户需要安装版时另行确认打包/替换流程；当前源码结果可在隔离预览复查。
