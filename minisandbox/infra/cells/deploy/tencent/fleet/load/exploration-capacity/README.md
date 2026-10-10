# 探索容量第一道验收

此入口用于开发/修复阶段的短反馈周期，不是生产资格，不替代百万 dormant、万级活跃、
Router 吞吐/尾延迟及故障矩阵。它复用 `capacity-cycle/run-on-builder.sh` 的同一负载、
采样、精确清理和缩回逻辑，不另建调度器或改变运行时配额。

| 项目 | 探索 | 生产万活跃 |
| --- | --- | --- |
| 活跃 Object / 总 Object | 320 / 352 | 10,000 / 11,000 |
| Worker/Version 数 | 4 | 16 |
| Warmup 创建率 / 稳态率 | 2/s / 20/s | 2/s / 20/s |
| Warmup 稳定 / 活跃观察 | 30s / 60s | 120s / 600s |
| 初始低容量 / 最终缩回 ceiling | 10m / 30m | 12h / 36h |
| 采样 / 容量检查间隔 | 5s / 5s | 15s / 30s |
| Host drain profile | exploration：30s / 2s | production：5m / 5s |

八台基础 Host 的固定硬槽位是 256，所以 320 活跃目标超过基础容量。验收仍要求实际
Host 与 canonical Machine 扩展、峰值 Ready/admitted Node，以及最后自然缩回每 Cell
4 Host/4 Machine 的完整证据；不能通过预分配容量、强制 scale/delete 或降低 AZ/PDB。
节点供应与释放时间不因探索 profile 而缩短，30m ceiling 是失败边界，不是完成时间承诺。

探索固定这些规模，不能把 `verify.py` 的参数改成生产规模来晋升收据。Agent 的稳态
创建加首次 SQLite 写入仍要求 3 秒，稳态和 heartbeat 零重试；warmup 仅沿用原已分类
容量背压的有界重试。FDB UID/健康/完全副本、Host/MachineSet UID、runtime revision、
采样时间、每 Cell 容量、不漂移的 Object 身份、精确清理和逐台 drain 检查均复用生产
谓词。API/控制门禁失败、缩回超时及 profile 漂移不能被此前的 passed JSON 掩盖。

## 运行前提与入口

先完成生产运行时的资格与来源绑定，再在整段 operation lock 内通过既有部署 owner
选择 `exploration` Host drain profile。不得直接 patch timer、暂停 Argo 或关闭安全门禁。
安装源码已接线，但真实云模式切换及 Argo desired-state 收敛尚未验证，当前不能把本地
double 回归当作这些前提已满足。`e2e-fast` 不是本入口的运行时配置。
仅改现有 controller timer 时，应使用原安装器的
[`--transition-profile`](../../runtime/README.md#仅切换现有-controller-的-profile)，
保留当前镜像/RBAC/HPA，并绑定本次实际 Deployment UID/RV。检测到另一个声明式 owner
时必须拒绝，不能通过重新 apply 全量 manifest 或暂停 Argo 绕过。该切换/恢复仍待云验证。

准备已审阅的不可变源码、真实 `/v1` endpoint receipt、两 Cell kubeconfig/federation
selectors，并通过当前 autonomy control。入口默认调用现有整段锁 wrapper；持锁时分别
按 `runtime.qualify` 对两 Cell 验证控制收据。在任何 API 采样、负载或输出创建前拒绝
control block；不增加 bypass，不靠环境变量标记来代替 actual Deployment profile。

```sh
bash infra/cells/deploy/tencent/fleet/load/exploration-capacity/run-on-builder.sh RUN_ID
```

`RUN_ID` 必须是新的 32 位小写 hex。该命令只发送实验 `/v1` 负载和 receipt 派生的
精确 DELETE；Kubernetes 操作仅 GET，不拥有 replica、Node、Machine 或 drain 状态。
整段锁之外还与生产共用 `ten-thousand-active.lock`，禁止两个容量 producer 并行。
当前原 strict10k unit 尚未退出，不能运行此命令，也不能修改其冻结源码或观察窗口。

入口在开始和结束时读取两 Cell 实际 Host drain Deployment 校验探索配置。结束读取
失败会保留 `drainProfile` exit status 并生成失败收据；成功/失败负载都执行原精确清理，
最终缩回失败也停止并回收 observer。进程被外部杀死不保证这段 finalization 执行，
此时仍须按原 load receipt 续做精确清理，不得从 namespace 扩大删除范围。

## 证据与生产隔离

输出目录为 `$ACTOR_BOOTSTRAP_ROOT/load-tests/exploration-capacity-RUN_ID`。同生产一样
保存 load/cleanup/capacity 的 SHA-256 和真实命令退出状态；最终 schema 为
`actor-exploration-capacity/v1`，`evidenceScope=development-exploration`、
`claimEligible=false`、`hostDrainProfile=exploration`。日志仅称
`exploration_capacity_development=passed|failed`，不打印生产资格成功。

通过后，由部署 owner 受锁恢复 production profile，再运行独立生产门禁；不能重标
或复用探索收据。生产性能入口拒绝该 schema、320 cardinality 和不同的 sustained key。
源码中的 shared recipe 仍保留原万活跃负载和等待窗口；旧的已运行 tools snapshot 不变。

本地门禁：

```sh
cd infra/cells/deploy/tencent/fleet/load/ten-thousand-active
python3 -m unittest test_supervisor test_verify -v
```

这些测试执行真实 shell/Python 入口、真实本地 flock，以及严格的 API/负载子进程
fixtures；它们不生成云资格，不证明 TKE 行为或实际扩缩容速度。
