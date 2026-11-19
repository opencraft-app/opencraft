# 记忆模型输入与查询契约

2026-11-09 用户授权统一提炼/复核语义、精简模型输入、补齐检索后复测。本轮仍是独立助理，不部署 Join，不改变数据库 schema。

## 提炼和复核

MemoryLearningModel 共用 memory-model-contract 的语义：对未来交互有用且有用户证据支持；profile 保存长期属性/偏好，log 保存经历、决定、进度与时效计划。复核不再把永久性当作所有 log 的必要条件。任务正文不自动变成个人事实，任务中的明确自述约束、项目和承诺可提炼；助手发言和未认可的引文不能自证用户事实。凭据不写记忆。

原独立复核、整批提交、三次尝试、15秒/12轮合并、90秒截止、引用校验、显式保护、墓碑和 CAS 均保留。本轮不把整批复核改成逐项提交，也不通过放宽宿主边界提高覆盖。

完整证据、快照、版本和授权仍归原服务。模型适配器仅投影 today/temporal、currentMemories、一种成对 user/assistant 证据表示，以及默认 scope、已捕获项目和带 writer 来源的只读共享背景。证据只暴露原用户消息 ID，助手文字不带可引用 ID。兼容 memories、文件缓存、epoch/guardEpoch/fingerprint 和资源 binding 不传给模型。review 将原已校验提议投影为 proposedChanges；旧提议恢复仍可验证，不改写旧数据库作业。

## 搜索与文件追读

- memory.search 默认 match=literal：完整连续子串，保持旧行为。显式 match=terms 要求所有空白分隔词都出现，顺序不限，最多8词；两种模式均非语义搜索，不支持 regex。query 最多200字符，结果按 key 分页。
- 搜索/单条事实带 document 的 scope/project/agentId/path。搜索额外给出命中词在事实 value 内的 UTF-16 offset，**不是文件行号**。若仅 key 命中，value offsets 可为空。
- memory.files.list 列出当前授权索引中存在事实的 profile/月度 log 文档。返回 documentId 作为分页 cursor，并提供相对文件路径与 writer。空文件可能不列出；没有任意文件系统枚举。
- memory.file.read 使用相同授权参数，支持 profile.md 或 log/YYYY-MM.md，沿 nextOffset 分页。不开放 Shell 或任意目录。
- 主聊查询每页最多12项、文件每次最多2000字符，继续受原6次查询/7轮/输出字节限制。共享描述来自 domain/reception-query，生产 seed 与 memory-only reader 使用同一份；结构化原生 query schema 同步页大小限制。
- 工作执行器共用 recall_memory 的显式 match 模式，并为新 Delegation 增加 list_memory_files。旧快照的工具清单不扩权，已有 read_memory_file 的原授权继续有效。

文件清单从原可重建索引做 SELECT；私有 agent 只列当前 writer，项目依原捕获且仍有效的 membership/binding 可见。搜索定位不授予权限，实际 read 继续由 MemoryService 检查。leave/rejoin 后旧工作/turn 不能借文件引用获得新 grant。

## 验证与复测

机制检查包括：时间计划经原提议/复核提交到 log；模型输入不暴露兼容快照/内部身份且保留用户引用和共享 writer；短语与关键词模式分开、数量限制；事实定位追读、目录分页、私有隔离、撤销/重加入 grant；真实 Codex wire 的目录到文件读取回合；原 Pi 与 Codex 持久执行恢复。

真实回归固定原 reader DeepSeek Flash、后台 hy4/none、相同已知 PersonaMem 历史六题与原更正探针输入，各新建 profile。它是三项改动的合并回归，不是提示词/载荷/检索的独立因果消融。保留旧失败，不能按本轮成绩再修改提示词后继续冒充同一运行。
