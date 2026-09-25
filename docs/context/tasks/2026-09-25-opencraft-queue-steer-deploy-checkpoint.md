## stage
OpenCraft headless 预览服务已切换到新 release，并完成运行态检查。

## verified
- 用户明确要求替换现在运行的服务。
- 当前 systemd unit：`opencraft-server.service`，旧 current `/opt/opencraft-server/releases/00dabc60f1901b13`，旧运行 buildId `20260925010234-cf363a381056`；切换前 `/__opencraft_health` 为 `{"ok":true,"appServerConfigured":true}`。
- 新归档 `/data/mono2/opencraft/release/OpenCraft-server-0.1.0-linux-amd64.tar.gz`，SHA-256 `92d67f5513476f6ffb35741c34be8df934d45f312ea4bc89328e74b2becdee1f`；前一轮 headless smoke 通过。
- `opencraft-deploy-stage-92d67f55.service` 成功校验归档路径、manifest 的 30442 个文件与 Web/server buildId，并预置 `/opt/opencraft-server/releases/92d67f5513476f6f`，buildId `20260925014314-dfc676efa06a`。旧服务仍 active。
- `opencraft-deploy-activate-92d67f55.service` 结果为 success，日志报告 `DEPLOYED build=20260925014314-dfc676efa06a`；新服务 PID `1901811`，`/proc/1901811/exe` 指向新 release 的 Node。
- `current` 指向 `/opt/opencraft-server/releases/92d67f5513476f6f`；`opencraft-server.service` active；`/__opencraft_health` 返回 `{"ok":true,"appServerConfigured":true}`；`/version.json` 与首页 HTML 的 buildId 均为 `20260925014314-dfc676efa06a`。
- 真实运行服务的 DSH `/appserver` initialize 和 Codex `/apphost` hello/connect/initialize/accounts-list 握手通过，未做付费推理。

## unverified
- 无 OpenCraft 内置浏览器标签可见，未直接验证用户手机的旧标签刷新后的 DOM；静态 HTML 的新 buildId 已由 HTTP 核对。
- 未做真实模型推理；完整 Codex 原子 queued Steer 尚未实现，当前能力门控会禁用该动作。

## discard
- `curl /health` 返回 404；此服务的正确健康端点是 `/__opencraft_health`。
- 当前进程受 `ProtectSystem=strict` 影响，对 `/opt` 写入即使提权调用仍只读；未来更新应使用已验证可写的独立 transient systemd unit。
- 部署日志中启动健康轮询前两次 JSON 解析遇到空响应，随服务启动后消失；最终任务 Result=success，现有健康检查通过。

## restore
- 部署脚本 `/data/mono2/opencraft/release/.deploy-92d67f5513476f6f.sh`，`stage` 已成功；`activate` 将核对旧 buildId、原子切换 current、重启、最多 40 秒核对新 buildId，失败时自动回滚旧 release。
- 新旧 release 都保留；不要删除 `/var/lib/opencraft-preview-codex-20260923173651` 的持久状态。
- 切换记录读 `journalctl -u opencraft-deploy-activate-92d67f55.service --no-pager`；运行态核对 `readlink -f /opt/opencraft-server/current`、`systemctl status opencraft-server.service`、`curl http://127.0.0.1/__opencraft_health`、`curl http://127.0.0.1/version.json`。

## next_action
- 告知用户已部署并提醒手机旧标签刷新；如需验证 queued Steer 的实际按钮状态，在刷新后的 Codex 会话中查看，不能将未实现的原子操作宣称可用。
