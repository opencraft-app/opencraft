# Grokbot 记忆行为对齐（0.12.0 / schema14）

用户本轮要求：「记忆这里 理论上需要紧跟（近乎复刻）grokbot」。范围仍是独立无界面 runner，不是 Join 部署。此前 0.11 只完成分层存储，不能据此称为 Grokbot 同级记忆。本轮对齐的是持续整理记忆的主链路。

## 参考的实际身份

参考本机 `/data/research/opencraft-superapp-20261102/grokbot-018`，固定提交 `a9f633e09d49a85829b8236331b9e21f7e612634`。这是非官方恢复/扩展源码，不能据此保证官方线上产品的实际行为。

核对文件：`source/host/extensions/memory/{memory-service,memory-synthesis-service,production,extension,agent-state,project-membership}.ts`，以及 `source/host/runner/{turn-memory,sand-memory}.ts`。提炼服务中既有定义，也有 production/extension 的装配；`sand_memory_dreaming` 开关决定新版是否生效。新版证据提炼与旧逐回合提取/episode 摘要是替代路径，不应叠加后宣称更接近原实现。

## 主链路

1. 接待成功回复后，MemoryLearningService 收集原用户消息和助手回复。助手内容只提供上下文，不能独立证明用户事实；系统结果不作为用户证据。
2. 15 秒静默窗口合并同一授权项目上下文内的证据，最多保留最新 12 轮；每侧超过 8000 字符保留头尾各 4000，加省略标记。丢弃的是待提炼输入，原始 ConversationHistory 保留。
3. 开始处理时固定最多 512 条事实、内容指纹、epoch、原项目 binding 和 UTC 日期。显式事实优先，其次 profile，再按写入观察时间倒序。没有证据的旧时间仍为 0。
4. 模型提出 create/update/remove，再单独调用验证模型。每批最多 64 项，每项内容统一空白、截断到 500 字符；修改/移除只能引用快照中的事实 ID，一个目标最多变更一次。每项最多 32 个证据引用。
5. MemoryService 在同一 SQLite 事务重新检查快照并应用事实、来源、epoch，与学习任务结算一起提交；迟到/过期提议不能覆盖新决定。新显式变更仍使旧执行的工具检查失效，自动提炼不会中断普通执行。
6. 每小时检查日期复查，每次完成复查后至少隔 24 小时再次复查；无复查记录的旧记忆立即可复查。普通提炼提交也延后该上下文的下一次复查。日期只能调整已有事实的时态，不能凭时钟创建新事实，不能把计划推断为已经完成。
7. 主助理上下文和新执行快照实际注入 profile/recent；Pi 原有只读召回、原文检索工具继续使用原工作资源授权。旧执行快照保持原样。

## 对照表

| 行为            | 恢复源码                                             | 本轮实际实现                                                                                                                                           |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 内容规范化/去重 | 空白统一、500 字符、小写内容去重                     | 同样规则，限定在 user 或当前 project 范围内；显式重复会提升为 explicit，不新建第二条；旧 key 的显式更正按移除旧内容/写入新内容处理，旧内容也受墓碑保护 |
| 事实身份        | 内容 SHA1 前 16 位                                   | 范围 + 内容 SHA256 前 16 位，避免混合 user/project 快照碰撞；不兼容原文件 ID                                                                           |
| 来源            | explicit/synthesis/legacy                            | 模型事实使用相同枚举；旧 SQLite provenance 的 automatic 保留，对外投影为 synthesis                                                                     |
| 用户遗忘        | 内容 tombstone 阻止自动复活，显式重加清除            | 新增持久内容墓碑；现代动作和旧 key 协议均检查。只做规范化后的同文匹配，不声称能阻止语义改写或抹除历史                                                  |
| 自动移除        | 不写用户遗忘墓碑                                     | 对齐，后续新证据允许重新建立同样的事实                                                                                                                 |
| 旧来源不明事实  | 有证据可纠正/移除                                    | 现代协议对齐；用户显式事实不可自动改。旧 key 提议保持历史保护语义                                                                                      |
| 提议            | create/update/remove、64 项、500 字符                | 现代模型提示词、fixture 和应用提交均接通；旧 key/value 提议仅保留兼容读取/校验/恢复                                                                    |
| 独立复核        | 必须精确 approved=true                               | 对齐；现代否决可重新提议，最多三次。旧提议否决保持旧版终态                                                                                             |
| 超时/重试       | 每次尝试 90 秒，三次，2 秒起、最大 30 秒退避         | 对齐整体尝试截止与上限；配置 runPolicy 更短时采用更短截止。传输失败重试复用已持久提议，源码则会重新提议，属于有意保留的恢复差异                        |
| 批次/恢复       | 内存合并证据，最多 64 agent、每 agent 12 轮          | 本地持久合并，每授权上下文 12 轮、全局最多 64 个未冻结输入。单助理没有 64 agent 调度池；溢出记 dropped，合并记 merged，原文保留                        |
| 日期复查        | 每小时轮询、每日复查、每轮最多 4 个 agent            | 本地仅一个助理与当前授权项目上下文；持久复查时间与作业，未扩成 agent 池。clock 仅日期任务可引用；内容语义仍依赖提议和验证模型                          |
| 默认 prompt     | user profile50/recent15，project25/10，项目注入最多3 | user50/15 + 当前授权项目25/10，recent 合计4000字符；没有三个项目的授权模型，不能注入未授权项目                                                         |
| 上下文固定      | 记忆可固定在 compaction epoch                        | 固定在既有 Execution 快照；主助理每轮重新观察。未复制 Pi 内部 compaction 生命周期                                                                      |
| 存储权威        | profile.md、月度 log、.dreaming 来源/墓碑旁车        | SQLite 仍是唯一权威，不写第二套可变 Markdown；无文件级 Read/Shell 记忆接口                                                                             |
| 范围            | agent/user/project 多 shard 与成员资格               | 独立助理 user/current-project，沿材料 grant/binding。尚无 agent shard、成员变动和跨 agent 汇聚                                                         |
| episode/向量    | 旧 episode 路径与新版提炼互斥；核心不是向量库        | 只启用新版整理机制；不另叠 episode，不引入向量数据库                                                                                                   |

## 所有权与文件落点

- [领域规则](../src/domain/AGENTS.md)：`memory-synthesis.mjs` 定义规范化、内容 ID/指纹和 MemorySynthesisPolicy；`memory-recall.mjs` 继续定义范围与读限制。
- [MemoryService](../src/application/memory-service.mjs)：唯一事实、来源、墓碑、epoch、复查时间写入者。旧来源不明事实不再一律冻结，这是本轮用户要求对此前规则的明确替代；显式与遗忘保护保留。
- [学习模块](../src/application/memory/AGENTS.md)：MemoryLearningService 唯一拥有证据批次、提议、重试、终态；引用必须落在原用户证据或本次授权 clock。
- [SQLite](../src/adapters/sqlite/AGENTS.md)：新增 memory_tombstone、memory_refresh、memory_learning_control 和任务 batch/temporal/today 字段；`memory-read.mjs` 为主助理/执行共享只读投影。schema14 不改写旧事实、日期、任务提议或执行快照。
- [模型适配器](../src/adapters/models/AGENTS.md)：现代提议/独立复核提示词实际发送；提议输出最多 16384 tokens，复核1800。这是单次输出上限，不是总费用预算。
- [runtime](../src/runtime/AGENTS.md)：只唤醒持久作业，整个提议+复核共享 90 秒截止；挂起/关闭中止请求，迟到响应不能提交。

此前已被 schema13 清空值的旧遗忘行，无法从现有空值恢复内容墓碑；仍保留原 key 保护，不伪造跨 key 历史遗忘。新遗忘完整记录内容墓碑。当前SQLite墓碑保留规范化内容与哈希，恢复源码的文件墓碑只使用内容哈希文件名；两者都不等于从原文历史彻底删除。旧 profile 不会被 load 静默重写。

## 配置与验证边界

`profile.json` 可选 `memoryPolicy`，缺省等于：

```json
{
  "enabled": true,
  "debounceMs": 15000,
  "deadlineMs": 90000,
  "pollMs": 3600000,
  "refreshMs": 86400000
}
```

enabled=false 停止新证据捕获与调度，保留原事实和任务。测试 helper 和 fixture 验收显式设 debounceMs=0 以加速；生产缺省仍为 15000。受控时钟另验证真实缺省窗口和跨重启合并。配置不接远端 feature flag，也不冒充原服务开关。

新增 [memory-parity.test.mjs](../test/memory-parity.test.mjs) 验证内容去重/遗忘/显式重加、现代增改删与合并、legacy 纠正、15秒/12轮/重开、500/512边界、clock约束、事务回滚、总截止与迟到拒绝、现代否决三次、持久提议恢复、实际上下文注入/截断、note 与 schema13 迁移。原有记忆/范围/Pi/CLI与崩溃测试继续回归。完整结果见 [本轮记录](iterations/0017-memory-parity.md)。

fixture 与受控模型只能证明机制和协议；模型是否正确识别事实、遗忘改写、矛盾、计划完成和日期时态，仍未通过真实服务和人工质量验收。当前可以称为“核心记忆整理行为已对齐”，不能称为官方 Grokbot 全量复刻。

## 后续0.13.0的替代范围

本文表格保留0.12轮次对照。用户随后要求将三项差异实际实现：目前已转为Markdown事实权威、agent/user/project shard、显式项目成员与最多3项目汇聚；SQLite作为可重建索引/业务作业，旧来源/墓碑/key通过文件旁车保留。对应源码factory/装配缺口、当前真实实现、ID/格式兼容差异与恢复限制见[0.13说明](memory-files-and-shards.md)。这些能力已不属于当前“尚未实现”，真实模型质量仍未验证。
