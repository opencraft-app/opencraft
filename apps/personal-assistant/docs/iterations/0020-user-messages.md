# 0020 用户交互与SendMessage

2026-11-04，用户原话「完整的用户交互与交付 SendMessage 那你搞一下？但是要怎么搞呢」，提出人未确认。独立runner0.15.0/schema17。设计、owner与明确缺口见[消息设计](../user-messages.md)。

实现：主助理结构化send与原结果deliver.message、typed用户消息/outbox/回执、文字/附件ID/原文回复引用、工作Interaction选择卡与原安全等待、本地文件交付、有限5次重投/显式retry、原文原子引用、revision撤回、通知附件合并、实际Pi/CLI/主模型装配。worker仍向主助理报告；Work完成继续原local-mailbox契约。当前local:main，不新增UI、外部渠道或Join部署。

## 保留失败与中间检查

- `user-messages-existing-first.log`：原接待/问答/分型介入27项23通过；迁移已写17但支持版本列表漏加17，导致4个重开测试失败。修复版本列表，保留故障记录。
- `user-messages-existing-second.log`：27/27通过。
- `user-messages-new-first.log`：新15项14通过；取消测试把submit和cancel复用同一输入ID，被业务去重正确拒绝。修正测试动作ID，未放宽业务去重。
- `user-messages-focused-first.log`：77项76通过；原pump合成夹具未装配新messages阶段，更新夹具与阶段顺序断言。
- `user-messages-focused-second.log`：77/77通过。
- `user-messages-new-final.log`：新增17/17通过；随后补5次永久失败不饿死与retry，`user-messages-new-release.log`18/18通过。

- `user-messages-tests-first.log`：第一轮287项286通过；执行期间有后续变更，只作中间诊断。静态SQL边界守卫将业务方法`.prepare(...)`当作SQL prepare，已将消息解析方法改名resolve，未放宽守卫或将SQL搬进应用层。
- `user-messages-tests-release.log`：本轮第二次全量过程中发现同一命名问题并修复，最终固定源码另跑一轮，保留中间记录。

- 第二次中间全量287/287通过，但运行期间有命名修复，以后续固定源码为准。
- `user-messages-tests-release-final.log`：固定全量287项286通过，真实SIGKILL恢复报Memory root is busy。原测试清理了临时现场，无法从该日志断言具体锁owner；进一步定向推进时钟复现“已死亡锁清理耗尽等待期后，可用根仍报busy”的确定路径，原失败见`user-messages-lock-reproduce.log`。
- 已修复：只有ESRCH确认死亡的锁清理成功后，立即尝试一次claim；不删除未知/不完整或活跃owner锁，不放宽等待保护。新增一项定向回归，真实SIGKILL与记忆文件锁检查见`user-messages-lock-fix.log`。最终固定全量另跑，失败记录全部保留。

## 最终固定验证

- 全量288/288，201826.547831ms，`evidence/user-messages-tests-stable.log`；源码开始/结束哈希保持。新增消息专项18项加记忆锁回归1项，原269项继续通过。
- 消息专项18/18：`evidence/user-messages-new-release.log`；SQL边界/消息相关27/27：`evidence/user-messages-ownership-release.log`；死锁期限复现与真实SIGKILL2/2：`evidence/user-messages-lock-fix.log`。最终全量在所有修复后执行。
- 136模块语法（非类型）通过，`evidence/user-messages-check-stable.log`；最终格式通过，`evidence/user-messages-format-stable-final.log`。
- 四模块实际CLI fixture演示25断言通过，`evidence/user-messages-personal-demo-stable.log`；当前保留profile为`profiles/personal-1793746665106/profile`，schema17；用户消息实际接受/文件哈希与残留检查见`evidence/user-messages-demo-stable-state.json`。质量仍false/unverified，进程已退出。
- 27份AGENTS，链接/owner覆盖、旧0019及更早迭代/0.14归档、依赖与非root锁文件条目保持，以及固定源码逐文件哈希见`evidence/user-messages-validation.json`。
- 源码归档`evidence/superapp-user-messages-0.15.0-source.tar.gz`，不含profile、用户文件、凭据、node_modules或运行数据。所有原失败日志保留。

真实模型、外部渠道和平台UI仍unverified。没有Join/Core/router、远端Git或发布操作；当前完成与渠道接受范围按设计明确区分。
