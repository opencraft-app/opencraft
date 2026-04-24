# RemoteCommandTimeoutRateHigh

重点查看 `openclaw_remote_command_total{result="timeout"}` 的 `command_kind` 分布，并结合命令耗时、sandbox API 延迟和 provider/TAT 状态判断是执行时间过长还是轮询/下发链路超时。
