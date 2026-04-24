# RemoteCommandFailureRateHigh

先按 `command_kind` 查看 `openclaw_remote_command_total` 的失败分布，再结合 `openclaw_sandbox_api_total{action=~"tat_.*"}`、CTL 日志和 sandbox TAT 日志确认是命令本身失败、命令退出码非 0，还是下发链路异常。
