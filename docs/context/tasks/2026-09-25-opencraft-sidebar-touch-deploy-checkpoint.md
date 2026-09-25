## stage
触控侧边栏新包已切换为当前运行的本机 OpenCraft 服务。用户已明确授权替换。

## verified
- 旧 release `/opt/opencraft-server/releases/92d67f5513476f6f` 正在运行，旧 buildId `20260925014314-dfc676efa06a`，切换前健康端点返回 `{"ok":true,"appServerConfigured":true}`。
- 新归档 `/data/mono2/opencraft/release/OpenCraft-server-0.1.0-linux-amd64.tar.gz`，SHA-256 `40e759ba730cc08479fa9ab46458369870690463ad58e5fd7dacd2c74f2a61b2`，buildId `20260925022532-668d30451312`。独立 headless smoke 通过；新旧 server runtime bundle 哈希相同。
- `opencraft-deploy-stage-40e759ba.service` 成功校验 30442 个文件、Web/server buildId，并暂存 `/opt/opencraft-server/releases/40e759ba730cc084`。旧包备份保留为 `release/OpenCraft-server-0.1.0-linux-amd64-before-sidebar-touch-92d67f55.tar.gz`。
- `opencraft-deploy-activate-40e759ba.service` Result=success，日志报告 `DEPLOYED build=20260925022532-668d30451312`。当前 release `/opt/opencraft-server/releases/40e759ba730cc084`，MainPID `1927967`、`NRestarts=0`；健康端点、`/version.json` 和 HTTP 首页 buildId 均正确，release 内 CSS 包含触控修复。

## unverified
- 用户 iPhone 页面尚未刷新和实机触控验收。

## discard
- 原服务包不能直接覆盖；当前服务 `ProtectSystem=strict`，切换需独立 transient systemd unit。

## restore
- 部署脚本 `/data/mono2/opencraft/release/.deploy-sidebar-touch-40e759ba.sh`，`stage` 已成功；`activate` 会核对旧 buildId、原子切换并在失败时回滚。旧 release 和持久状态均保留。

## next_action
- 告知用户已部署并请其刷新手机页面，实测列表手指拖动及“…”菜单；若仍有粘滞 hover，再取实际触控序列与页面版本证据。
