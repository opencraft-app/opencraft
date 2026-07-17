# Worker 隔离与 Set 容量职责设计

## 目标

修复北京生产压测暴露的两个 P0：单个 O(Set) 后台任务阻塞全部 worker job，以及
set-manager 绕过 worker 主动生成扩容请求。

## 职责边界

- worker 是唯一容量决策者。启用 `LLMGATEWAY_SET_AUTOSCALER_ENABLED` 时，它根据本地
  MySQL 投影生成 provision request。
- set-manager 是 LLMFleet 执行器。它同步 Fleet fact、消费 pending provision request、
  patch LLMFleet，并回写状态；它不调用容量 reconcile。
- 删除无效的 `LLMGATEWAY_SET_MANAGER_CAPACITY_ENABLED` 配置，不保留隐藏开关。
- set-manager 不能创建 request，也不能修改 set_id、shard、database、Redis DB、目标容量等
  决策字段。它只允许按当前状态做 `pending -> created/error -> managed` 生命周期转换并写
  last_error；worker 容量开关关闭时，set-manager 仍完成已经存在的 pending request。

## Worker 调度

- 每个内置 job 运行在独立循环中，不共享 FIFO 或全局槽位。一个长 job 不能延迟其他 job
  的调度；同一个 job 在单 Pod 内最多有一个执行实例。总并发上限等于启用的内置 job 数。
- 每次执行使用唯一 lease owner token。lease TTL 最小为 15s。启动前获取 MySQL lease，
  执行期间每 `lease_ttl/4` 续租；续租调用本身使用 `lease_ttl/12` 硬 deadline。未在安全
  截止点获得成功确认就立即取消当前执行。
- MySQL 获取和续租使用数据库 `UTC_TIMESTAMP(6)` 做原子过期判断，不依赖 Pod 时钟；
  内存实现使用注入时钟覆盖相同边界测试。
- 所有 worker DB/HTTP I/O 必须使用 job context；远端单项硬超时不超过 `lease_ttl/3`，
  CPU/集合循环每项检查取消。续租在 TTL 尚余至少 `2/3` 时失败并触发取消，因此当前执行
  必须在旧 lease 到期前退出，不允许出现新 owner 与旧副作用重叠。
- worker 完成 job 时使用 `name + lease_owner` 条件更新 cursor、终态和 lease。只有当前 owner
  可以提交 `running -> success/error`，旧 owner 的晚完成不能覆盖新状态。
- panic 转换成 error run，并通过相同的 fenced 完成路径释放 lease。进程崩溃时不释放，
  由 lease TTL 提供恢复边界。
- 单个 job 失败只影响自身循环。其他 job 按自己的 interval 继续执行。

## Drift 分批

- `check_channel_drift` 将 active/setup Set 与 bundle 按 `(bundle_id, set_id)` 升序组成稳定
  工作序列，使用版本化、base64url 编码的两个字段作为持久化 cursor。
- 每轮从严格大于 cursor 的第一项开始，最多检查 10 项；到末尾后将 cursor 清空，下一轮
  从头开始，不在同一轮回绕补足 batch。
- 新增项按排序自然进入后续轮次；删除 cursor 对应项时仍从大于 cursor 的下一项继续。
  非法或未知版本 cursor 重置为空。
- 单项检查采用独立 `min(5s, lease_ttl/3)` timeout。成功或失败后都推进内存 cursor，
  坏 Set 不会永久卡住。
- cursor 与本轮 job run 在 fenced 完成事务中一起提交，语义为至少一次：在远端检查完成、
  cursor 提交前崩溃会重复检查，但不会漏检；重复的 check-only 操作是幂等的。

## 验证

- set-manager 测试断言所有 RunOnce 入口都不请求容量 reconcile，但仍读取并执行 pending request。
- worker 测试用一个阻塞 job 和一个快速 job，断言快速 job 在一个 poll interval 内执行；
  并断言每个 job 峰值并发为 1、总峰值不超过启用 job 数。
- lease 测试覆盖续租、租约丢失、晚完成 fencing、多 Pod 竞争、panic 和进程重启恢复。
- 取消测试覆盖阻塞 HTTP、阻塞 DB 和集合循环，证明续租失败后它们在旧 lease 到期前停止；
  不响应 context 的实现不允许接入 worker job。
- drift 测试覆盖复合 keyset cursor、batch、末尾回绕、失败后继续、cursor 对应项删除，以及
  cursor 提交前崩溃导致的安全重复。
- Compose/云上回归使用与 2026-07-11 相同的 2 万用户参数，检查 BYOK 队列可消费、
  set-manager 不主动生成 request、chat 成功率和订阅超时变化。

## 云上验收

- 受阻 drift 期间，`retry_byok_sync.last_success_at` 必须持续推进，最长停顿不超过 2 分钟。
- 压测结束且停止新增 BYOK 后观察 10 分钟：`retry_byok_sync.last_success_at` 至少推进
  5 次，`succeeded` 至少增加 500，pending 至少减少 500；历史 backlog 不要求清零。
- 完成一次 worker 容量决策关闭、set-manager 单独运行的受控检查，provision request 增量必须为 0。
- 2 万用户回归中，完成用户的 chat 成功率不低于 99.9%，gateway Pod 不重启。
- 若出现同名 job 双 running、fencing 失败、set-manager 主动新增 request 或 gateway 重启，
  立即回滚镜像。
