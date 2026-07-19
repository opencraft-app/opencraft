# 回归框架 P0 加固设计

## 目标

把现有统一回归从 LLMGateway traffic Deployment 的成功滚动验证，扩展为可证明多 Set 发布、故障隔离、自动回滚和进程中断恢复的生产级门禁。北京环境是可破坏的集成环境，可以使用专用回归 Set 执行真实故障注入。

## 设计原则

- Case 描述一个可观察结果，Scenario 只负责编排 Case。
- 所有破坏性 Case 必须显式选择隔离 Set，并通过配置开关启用。
- 控制面同步成功不等于流量面生效；最终门禁必须使用真实 `/v1/chat/completions` 探针。
- 故障必须由受控 mock/pacer 确定性注入，不使用随机断网。
- 失败运行保留业务现场，成功运行逆序清理；报告不得包含明文密钥。
- 旧 soak runner 不得用局部倍率 map 覆盖共享环境的完整 new-api Option。
- `golden-channels` 是唯一自动生效的 DesiredConfig；其他配置包只作为草稿或历史，不参与新 Set 纳管、准入和定时漂移检查。

## P0 行为

### 流量生效门禁

渠道包同步和 Set admission 通过后，runner 使用回归租户和 Key 对目标模型持续发送真实请求。允许等待 new-api `SYNC_FREQUENCY` 引起的最终一致性，默认超时至少 130 秒；超时报告最后一次流量错误。

### Fleet Campaign 门禁

统一 runner 使用已经登记的 target Release 和 Ring 拓扑创建 Campaign，等待每个 Ring 按序完成。断言同一时刻最多一个 Set 处于升级、Ring 顺序正确、所有 Set 最终使用目标 Release、generation 只增加一次且 route revision 前进。

### 自动回滚门禁

通过回归 pacer 的受控状态注入两类失败：Green 切流前探针失败，以及切流后回滚窗口内探针失败。分别断言不切流或切回旧 runtime、Campaign 暂停、后续 Ring 不启动；清除故障后允许幂等恢复。

`rolled_back` 是不可变终态。清障后创建新的升级 batch，从 Set 当前 generation 重新发布；旧 run 永久保留回滚证据，不能原地改写成 completed。

Kubernetes Readiness 不能代表 new-api 已加载定价和渠道运行态。Green runtime 在进入正式探针计数前必须完成一次真实模型调用；启动期的未定价、缓存未同步等错误在超时内仅表示“尚未功能就绪”，不会被误记为发布故障。渠道计划必须把远端全局 Option 纳入实际状态和漂移判断，禁止只凭渠道指纹产生假绿。超时后仍失败则阻断升级。

### set-manager 接管门禁

在 preparing、switching/outbox publish、draining 三个阶段终止当前 manager Job/Pod。等待 Lease 过期并由后续 Job 接管，断言 generation 和 route revision 不重复、没有孤儿 runtime，最终完成或确定性回滚。

回归 manager Job 使用 Job 名称作为显式租约 owner。场景同时断言被终止 owner 和接管 owner 都来自本次受控 Job，避免普通 CronJob 或其他 reconciler 抢占后让测试假通过。

### 旧 soak 安全化

旧 runner 在保存测试渠道包前读取黄金渠道包的完整 `ModelRatio` 和 `CompletionRatio`，仅增量补充测试模型；缺少黄金快照时拒绝在共享环境运行，不得退化为局部 map。

## 验证层级

1. Go 单元和 HTTP 测试验证状态、超时、报告和客户端契约。
2. OrbStack Kubernetes 验证全部破坏性状态机。
3. 北京隔离回归 Set 验证真实 TKE、CLB、DNS、TLS、TCR 和 Campaign 行为。
