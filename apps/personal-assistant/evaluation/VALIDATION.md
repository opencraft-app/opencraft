# 2026-11-07 接入验证

本记录属于独立 superapp-evaluation 工作副本，不修改冻结交接包。全部为离线机制/适配证据，未调用真实模型、未运行官方 judge、未提交榜单。

- 依赖：在当前工作副本按原 package-lock 执行 npm ci --ignore-scripts --no-audit --no-fund 成功。
- 原有记忆专项：76/76，通过 memory-learning、memory-parity、memory-files、conversation-context 四个文件。
- 新增适配测试：7/7，通过 gold/角色投影、时间策略、跨题隔离、真实独立进程/原生记忆、长历史、失败保留和显式凭据边界。
- 原源码136个模块语法检查通过；新增 evaluation 模块由实际测试加载。新增代码和文档格式检查通过。
- 实际 fixture smoke：两段历史、4条原文、1项自动学习事实，运行完成。accuracy=null，未评分。
- 官方 cleaned oracle 数据：500题/10960条历史消息完成输入规划；数据SHA256为821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c。65条历史会话时间晚于问题时间，默认保留官方输入并报告，不静默过滤。仅做数据/协议验证，没有运行500题推理。oracle并非完整长历史S/M。

## 全量回归发现及修正

初次全量运行记录287项通过、1项失败，最后文件因进程未退出被手动中断，另记1项取消。不能称全量288通过。

失败在 test/user-messages.test.mjs 的附件CLI/模型查询用例，错误为ENOTEMPTY，测试清理profile时runner后台仍在写memory-space。同用例单独重跑通过，18项附件专项原样重跑也通过；进一步核对确认profileFor先注册删除钩子、随后才注册runner关闭钩子，形成生命周期顺序风险。

工作副本已将该用例的runner放进try/finally，先await runner.close，再由既有钩子删除profile。修正后18/18附件专项通过。此修正没有改变产品投递逻辑、增加目录删除重试或放宽断言。未在修正后重跑整套22文件；初次失败、单项/专项重现、修正后专项记录都保留在validation/。

## 源码变更边界

- evaluation/：数据输入白名单、独立子进程、原生History/MemoryLearning/Context/Reception复用、JSONL导出、测试与使用文档。
- src/runtime/create-local-domain.mjs：增加可选now注入，默认仍为Date.now。业务规则、提示词和schema不变。
- test/user-messages.test.mjs：修正上述测试资源释放顺序。
- README/package scripts/.gitignore：入口和本地证据忽略规则。

真实模型还需用户指定provider/model及本机私密配置。只有取得真实回答并独立评分后才能报告准确率；当前没有真实模型质量结论。
