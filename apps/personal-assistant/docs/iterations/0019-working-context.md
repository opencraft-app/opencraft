# 0019 主会话长期工作上下文

2026-11-04，用户原话「主会话的长期工作上下文 搞定实现吧」，身份未确认。独立runner 0.14.0/schema16；范围不扩展Join部署。[设计与所有权](../conversation-working-context.md)。

已实现：四组有引用的滚动摘要，原文消息内游标，独立checkpoint状态/有限重试，当前锚点隔离，失败gap，原文分页查证，实际接待/系统报告/新委托Pi装配，context/context-retry CLI，schema15无损升级。模块AGENTS与总地图同批更新。

## 失败记录

- `evidence/working-context-existing-first.log`：原接待/查询共27项，26通过；旧schema-4迁移断言仍期待15，更新当前schema16断言。原迁移版本数字不变。
- `evidence/working-context-new-first.log`：新增15项12通过。三个测试夹具/断言问题：并发测试重复使用原文identity却换内容、查询返回漏取response封装、CLI输出漏取result封装。按实际公共协议修正，保留原失败；未弱化业务校验。
- `evidence/working-context-new-second.log`：15/15通过。
- `evidence/working-context-focused.log`：新增19项+查询/续接，共72/72通过。

## 最终验证

- 全量269/269，185187.884917ms，`evidence/working-context-tests-first.log`。最终测试期间代码哈希未变，原250项加新增19项均通过。
- 相关接待/查询/结果续接72/72，`evidence/working-context-focused.log`；两个进程退出86窗口包含在专项与全量中。
- 129模块语法检查通过（不是TypeScript类型检查），`evidence/working-context-check.log`；格式检查通过，`evidence/working-context-format-check.log`。
- 实际四模块CLI fixture演示25项断言，`evidence/working-context-personal-demo.log`；profile保留在`profiles/personal-1793743539248/profile`，schema16，实际生成1个ready摘要；退出后无socket/profile锁/记忆锁/待恢复日志，`evidence/working-context-demo-state.json`。
- 26份AGENTS；本地链接与目录owner覆盖见`evidence/working-context-doc-audit.json`。旧0018及更早迭代、0.13归档哈希保持；依赖与锁文件中的非root包条目未变。
- 固定源码`evidence/superapp-working-context-0.14.0-source.tar.gz`与逐文件哈希/检查清单见`evidence/working-context-validation.json`。不包含profile、凭据、依赖安装目录或运行数据。

真实模型语义质量继续unverified。fixture只探测链路，未调用外部模型/IM/业务服务或部署Join。摘要出处校验与主会话注入通过，不代表长期信息取舍已通过真实质量验收。
