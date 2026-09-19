## goal
按 opencraft/design/dsh-jit-history.md 的行为契约实现 DSH AppServer JIT 历史恢复。

## non_goals
- 不删除用户原生日志、现有索引或执行回执，不提交发布。
- 不扩大默认超时，不改模型推理行为。

## acceptance
- 展示与激活解耦；恢复不写历史副本；最新 Turn 按需投影，分页身份稳定。
- 聚焦测试、Host typecheck、构建及大规模恢复验证。

## context_receipt
- 已读 opencraft/AGENTS.md、opencraft-maintenance/SKILL.md 与 verification.md。
- Router 无匹配；精确定位 dsh-routed-client、dsh-history-index、adapter、thread-engine 及 history-pages 测试。
- 参考固定安装的 DSH 0.1.1-rc.2 Session.open/historySourceFor；契约见正式设计。

## evidence
- 实施前确认 wrapper 每 100 个事件调用一次 native tail refresh，造成大日志重复同步。
- DSH 聚焦测试 216/216 通过；Host typecheck 与 Electron build 通过。
- 120,050 事件合成测试：两页只发两次原生请求；测试覆盖跨消息页 Turn 起点、非法 cursor、generation seed 去重、激活 single-flight 与失败重试。
- 安装版原生数据源只读验证：最新 5 Turn 及逐 Turn Item 页共 122 Item，约 2970ms。此为新 adapter 对真实数据源的诊断，非已更新安装版 UI。
- 真 DSH 隔离模型 smoke 通过：重启、只读 resume、随后冷执行、图片能力、默认模型；确认无 opencraft-history-index.sqlite。
- 全量 gate 已运行，停在未修改的 typography-system.test.ts:39（缺少 navigation-action mixin 断言）；不得称全 gate 通过。
- 显式变更集 docs-impact、文档 validation 和 diff check 通过。

## limitations
- 正向全历史兼容查询仍可遍历历史；超大单 Turn 仍需覆盖该 Turn 起点，未承诺恒定成本。
- 当前保留原有附件 hydrate 与历史/live 同源投影，未跳过 chunk；图片懒加载及 per-request 跨进程取消需独立契约。
- 原生 DSH inspect 的全日志成本仍存在，安装版未替换。

## handoff
- 当前实现与专项验证完成，新隔离 Electron 预览已启动（本轮 CDP 9481）。安装版未更新，未提交/推送/发布；完整 gate 的排版失败仍待处理。
