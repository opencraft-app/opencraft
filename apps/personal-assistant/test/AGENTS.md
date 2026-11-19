# 行为与恢复验证

2026-11-09：codex-credentials.test.mjs 使用真实原生持久线程、loopback 模型与合成认证值，验证禁用 shell 快照后仍可认证且原生 home 不残留凭据。修复前测试实际复现快照落盘；不能仅检查 argv/config 或禁用 Shell 工具便宣称没有落盘。

2026-11-07：codex-harness.test.mjs 使用显式原生二进制 + loopback Responses 替身验证可切换主助理、schema、无工具、一次纠正、turn ID、并发、取消/关闭、凭据环境隔离、实际 CLI/查询/Pi委托/重开和评测进程。无二进制时原生测试显式 skip，不当成通过；合成模型不证明质量。新增测试先 finally 关闭 runner/Harness，再删除 profile，避免旧 fixture 的清理顺序风险。

继承[根规则](../AGENTS.md)。测试使用独立临时profile、合成资料/凭据和真实Pi本地存储；不触碰共享运行环境或借认证。

| 关注点                          | 用例入口                                |
| ------------------------------- | --------------------------------------- |
| 领域/所有权/升级                | domain、ownership、completion           |
| 日历/有限盯办/分层记忆/原文检索 | continuity                              |
| 主助理续接/批量/报告恢复        | continuation                            |
| 多工作概览/定向跟进/版本隔离    | work-coordination                       |
| 执行接口/场景独立运行/失败留证  | module-boundaries                       |
| 执行保护/请求截止/用量/旧迁移   | guardrails                              |
| 接待/只读查询/回应              | reception、reception-queries、responses |
| 普通/分型等待                   | interaction、interventions              |
| 技能/证据学习                   | skills、memory-learning                 |
| 事件/通知/关注                  | event-notifications、attention          |
| 执行/锁/崩溃/投递               | runner                                  |
| 离线配置/真实入口拒绝fixture    | diagnostics                             |

表内名称对应本目录同名.test.mjs。helpers负责隔离profile、原生记录读取和子进程清理；不要用长时间sleep代替可观察状态，推进应用时钟测试长周期。

测试公共行为与边界：取消/修改、幂等、事务回滚、重开、真实工具/CLI和权限。模型替身仅证明协议，不能写成模型质量通过。已有静态检查覆盖部分依赖/写入约束，不保证所有新owner都已由静态规则穷举。

按改动选择相关测试；共享迁移/装配/原生恢复变更跑`npm test`。文档小改检查链接/覆盖/格式即可，不为可逆文案改动添加镜像实现的测试。失败保留原日志，不能改测试忽略真实失败或伪称未运行检查通过。

module-boundaries同时检查Pi不重新导入业务owner或装配根、工具port固定原工作和取消检查、四个真实CLI场景分别运行、未知选择在建目录前拒绝、途中失败留证/后续not_run/关闭，以及缺少显式真实模型凭据时没有服务调用。静态规则只是回归护栏，不宣称JavaScript权限隔离。

continuity专项检查时区/DST、一次性与重开、原ID更新/CAS、条件结束与交付、项目scope隔离/自动学习保护、文字召回/原文只读、schema12迁移与实际CLI/Pi新工具。条件测试用受控父提议，只证明宿主验证/结算机制，不证明真实模型的条件判断。

memory-parity专项覆盖现代增改删、内容去重/跨key同文遗忘/重加、legacy修正、15秒/12轮/重启、clock、64/500/512界限、事务/总截止/迟到、拒绝重试、上下文注入、note及schema13升级。helpers与fixture验收显式debounce0，另以受控时钟验证生产默认15秒，不以缩短默认值换绿灯。

memory-files专项包含跨助理私有隔离/共享来源/写隔离、成员及旧grant、三项目实际上下文、主助理项目命令、Pi读Markdown、实际CLI、手改/索引重建/元数据与符号链接、schema14备份/迁移、文件失败/嵌套回滚、真实进程提交前后/另一agent恢复、外部冲突、并发初始化及自动共享不打断工作。旧schema夹具删除后来的文件目录/索引表；原raw SQL注入旧事实的测试改为真实legacy Markdown或真实旧库，避免让缓存偷偷成为权威。

conversation-context专项验证有引用的滚动摘要、原文/事实/工作不变、Unicode长消息完整游标、重开复用、不可变成功版本、来源/限额拒绝、SQL失败回滚、父版本CAS、旧用户/报告锚点、有限重试/关闭/超时/迟到、短会话不调用、history.read/search只读与未来隔离、实际socket/Pi委托/CLI、模型请求协议和用量、schema15与两个真实进程崩溃点。模型替身与fixture不证明真实摘要语义；测试中的更正优先只核对注入与提示词。

user-messages专项覆盖canonical/outbox原子性、稳定ID/typed body、附件字节/符号链接/另一profile/篡改、顺序/重开/5次失败不饿死及retry、revision撤回、选择/拒绝/过期/取消、秘密不走普通回答、真实Pi选择/CLI同submission、真实模型协议的受控main查询/附件交付、Completion不绕过、通知分批不丢附件、慢adapter时socket可用、schema16不重发原文，以及真实进程写文件/回执窗口。外部服务与真实模型质量未验收。

0.16 codex-execution 和 execution-harness 使用真实原生进程覆盖持久委托、工具效果窗口、同线程恢复及迁移；test/helpers 的 running 在同一清理钩子先关闭 runner 后删 profile。

2026-11-09：codex-harness 新增真实原生 wire 的 none、后台角色分流和评测 IPC 测试。需要验证真实请求体、来源落盘及关闭，不只断言配置对象。跨装配/原生配置改动执行完整测试；真实模型与替身结果分开。

0.17：goal-coordination 验证目标CAS/DAG/优先级与等待加权、依赖证据失效/重做、模型复核区别用户确认、原子计划扩展/复核、指令去重/顺序、旧执行迟到及分页。codex-execution 使用真实原生进程验证同线程多尝试、暂停恢复；execution-harness 覆盖 schema18 外键/原生收据/根目录兼容。共享结构变更仍跑全量，质量模型另验。
