# Computer 在线状态与终端可靠性设计

## 背景

当前 `Computer.connectionState` 直接来自持久化的 `tat_agent_state`。该字段只在注册完成或人工刷新时更新，因而一次 `online` 可以无限期保留。新 Computer daemon 虽然保存了平台签发的 Computer credential，却只运行内嵌 TAT Core，没有向平台发送 heartbeat。结果是 TAT 控制 WebSocket 已断开时，页面仍显示在线；终端实时签发失败后，用户只能看到笼统错误。

## v1 在线语义

后台保存两个独立事实：

- `tat_agent_state` / `last_observed_at`：最近一次腾讯 TAT probe 快照，用于诊断和修复。
- `host_last_seen_at`：Computer daemon 最近一次通过平台 credential 成功 heartbeat 的时间，用于产品在线状态。

返回 Human API 时：

- 生命周期不是 `active`：`unknown`。
- `host_last_seen_at` 在租约 TTL 内：`online`。
- 曾有 heartbeat 但已过 TTL：`offline`。
- 从未 heartbeat：`unknown`。

`lastObservedAt` 对 Human 表示最近一次 daemon heartbeat；不再用 TAT 注册完成时间冒充“最近连接”。首版使用固定 90 秒 TTL，daemon 每 30 秒发送一次 heartbeat，允许连续丢失两次且无需协调时钟。

## Computer daemon

daemon 启动后在同一 Go 进程中并行运行：

1. 内嵌 TAT Core；
2. 平台 heartbeat 循环。

heartbeat 客户端只读取受限权限的 `computer.credential`，向现有 Computer control heartbeat API 发送 Computer/版本/健康信息。credential 不进入参数、日志或通用 JSON。首次 heartbeat 立即发送，此后每 30 秒发送；临时失败采用有界退避但不停止 TAT Core。401/403 表示 credential 已失效，daemon 进入可诊断失败状态，不继续以旧身份续租。

credential 距到期不足 7 天时，daemon 使用短期 Computer Bearer 调用既有轮换接口；新 credential 先以 `0600` 原子写入，再更新本地非敏感版本/到期元数据，随后清空旧 Session 并用新版本重新建连。相同幂等键可在落盘失败或进程崩溃后安全重放。已经过期的历史 credential 只能由 owner/admin 走人工恢复，不允许客户端自行越权续期。

## 终端

终端签发以实时 `StartSession` 为权威。若 daemon 租约过期，返回 `computer_offline`，不使用历史 TAT 快照放行。若签发失败，HTTP 仍返回稳定、非敏感的产品错误，但服务器日志记录：请求 ID、Computer ID、Pod、稳定 provider 错误码和是否可重试；不得记录凭据、SessionId 或 StreamUrl。

现有 `terminal_target_offline`、`terminal_rate_limited`、`terminal_session_rejected`、`terminal_target_not_found`、`terminal_session_unavailable` 分类应透传到 HTTP 错误映射，不再次统一折叠。

## 兼容与恢复

- 已注册但尚未升级 daemon 的 Computer 显示“等待连接”，不会继续假在线。
- 已完成安装可接受同一平台、同一 target、版本严格递增且通过既有 Ed25519 公钥验证的本地 release 升级；升级只切换 daemon 二进制与 handoff，不重新 claim credential、不重新注册 TAT。
- release 升级使用 pending handoff：旧 handoff 在新 daemon 完成接管前仍可校验，安装或 LaunchAgent 切换中断后可安全重跑；拒绝降级、跨平台或跨 target 覆盖。
- `enrollment.lock` 只串行化安装/升级，`runtime.lock` 只保证 daemon 单实例；旧版 daemon 首跳升级前先安全停止，失败时恢复可启动的 handoff。
- LaunchAgent 切换必须等待旧服务完成 `bootout`，再 bootstrap，并使用不带强杀参数的 kickstart；禁止对刚启动的新 daemon 执行 `kickstart -k`。
- TAT probe 保留，管理员刷新仍可用于诊断，但不改变产品在线租约。
- daemon 重启后首次 heartbeat 会立即恢复在线；相同 heartbeat 可幂等重试。
- 不增加数据库表、不增加新进程、不要求公网域名。

## 验收

- daemon 启动后 30 秒内 `host_last_seen_at` 更新，页面显示在线。
- 杀掉 daemon 或阻断平台请求，90 秒后自动显示离线。
- 仅断开 TAT WebSocket 时，终端返回准确错误；TAT 恢复后可直接重试成功。
- 失效 credential 不能续租。
- 临近到期 credential 自动轮换并原子持久化；人工恢复后可直接重新启动。
- 日志可定位 provider 错误，但凭据扫描无泄漏。
