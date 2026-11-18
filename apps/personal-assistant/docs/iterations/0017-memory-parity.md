# 0017：按Grokbot对齐核心记忆整理（0.12.0 / schema14）

2026-11-03，用户要求「你看看记忆这里 理论上需要紧跟（近乎复刻）grokbot」。提出人未确认。独立runner继续开发，无Join/Core/router集成、重启或部署，无Git/远端操作。

## 实现与替代

固定核对非官方0.18恢复/扩展源码 `a9f633e09d49a85829b8236331b9e21f7e612634` 的 memory-service、memory-synthesis-service、production/extension 与 turn-memory/sand-memory。逐项行为、所有权、配置与有意差异见[记忆对照](../grok-memory-parity.md)。新版 synthesis 受开关控制，与旧逐轮提取/episode 路径互斥；不因为文件同时存在就宣称线上同时运行。

本轮新增内容规范化/去重、同范围跨key内容墓碑、显式重加、现代create/update/remove与独立复核、15秒/12轮持久证据合并、512事实快照/指纹/CAS、整体90秒截止与三次有界重试、每日日期复查/小时轮询，实际profile/recent注入接待和新执行。模型和fixture都接现代协议，旧key提议仍可恢复。

用户本轮要求覆盖了旧“来源不明事实一律不可自动覆盖”的现代协议范围：现允许凭新用户证据纠正/移除legacy，已向用户说明并更新根与模块AGENTS。explicit和显式forget保护保留；自动remove不写用户forget墓碑。内容墓碑只是规范化同文，不是语义遗忘，不清除原文历史。

MemoryService独占事实/来源/墓碑/epoch/复查时间，MemoryLearningService独占批次/证据/提议/重试/结算，runtime只持临时请求和截止。schema14新增三表与三列，旧事实/日期/提议/执行快照不重写；内容已经为空的旧遗忘行不能补造内容墓碑。SQLite仍唯一权威，未复制Markdown文件权威、agent shard/成员资格和多项目汇聚。没有新增依赖。

## 验证事实

- 首轮全量 **223/223通过**，190362.809314毫秒：[完整日志](../../evidence/memory-parity-tests-full-first.log)。原204项加19项本轮专项，包含真实Pi、socket、CLI、重开和进程崩溃恢复机制；不是实际模型质量结论。
- 新增专项首轮13/14：一个新测试错误地把第二条用户证据提交给第一条任务，被正确拒绝。只修正测试归属，保留[首轮日志](../../evidence/memory-parity-new-first.log)。第二轮28/28为扩充后的18项专项+10项原记忆测试；最后再加schema13迁移，本轮最终19项已包含在223项中。相关[第二轮](../../evidence/memory-parity-new-second.log)。
- 原相关首轮40/40通过：[日志](../../evidence/memory-parity-focused-first.log)；原记忆复核10/10通过：[日志](../../evidence/memory-parity-learning-second.log)。保留全部中间证据，不重写旧绿灯。
- 真实命令行四模块fixture演示 **25项断言通过**：[日志](../../evidence/memory-parity-personal-demo-first.log)。自动记忆经现代synthesis动作写入，事件/原用户证据均留存；所有场景quality仍unverified。首轮演示目录 `profiles/personal-1793700212699` 保留；最终代码再跑25项通过，见[memory-parity-personal-demo-release.log](../../evidence/memory-parity-personal-demo-release.log)，目录 `profiles/personal-1793700719286`，进程已结束，不接真实服务。
- 116个模块语法检查通过（不是类型检查），格式检查通过；本地文档链接、24份AGENTS/目录覆盖、依赖与历史文件比较、归档逐文件哈希见[固定验证清单](../../evidence/memory-parity-validation.json)。

收尾继续核查并补齐：无复查标记的导入记忆立即可复查；更新目标内容已被遗忘时只退役旧事实；历史大段记忆的兼容快照也限制500字符；显式key更正对被替换内容写墓碑，阻止旧内容跨key复活。第二轮226/226通过（130542.426459毫秒），随后包含最后更正的相关63/63通过；最终固定代码全量 **227/227通过**（135249.679457毫秒，原204项+新增23项），见[memory-parity-tests-release.log](../../evidence/memory-parity-tests-release.log)。相关代码文件在启动前和结束后逐项校对哈希，没有运行中修改；结果与本轮封存源码一致。未用正在运行中的测试掩盖后续代码变化。

首轮导航检查在清单生成前发现两处待生成清单链接，记录memory-parity-navigation-first.json；生成归档与清单后重新检查，不把待生成链接算作通过。首次封存脚本将docs/acceptance文档集合误算为执行模块而报缺指南，修正检查范围为原docs owner覆盖（与iterations相同），保留memory-parity-freeze-first.log；没有为凑覆盖率新增空模块。

源码封存为 `evidence/superapp-memory-parity-0.12.0-source.tar.gz`，旧0.11归档及失败记录保留，旧归档SHA256仍为 `50f3956b2b5c6f5e874c6691a8319bc47624748a66cbeab080d4197b496c03a7`。

## 未通过或未实现

未使用真实模型服务或外部认证/IM，未运行官方原服务。日期时态、矛盾取舍、长期质量和改写后的遗忘仍需模型质量验收；不能用受控clock测试声称模型会自动正确判断事件是否发生。SQLite与文件权威、单助理与agent/user/project多shard等差异明确保留。整体仍development，不宣称官方Grokbot全量复刻或成熟产品验收。
