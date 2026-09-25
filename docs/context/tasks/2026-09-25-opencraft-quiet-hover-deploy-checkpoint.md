## stage
Activity 共享 quiet-control 遗留 hover 修正已构建、校验并替换为当前服务。

## verified
- 用户确认首次部署后“…”常显，但手指滑动仍有问题；实际构建 CSS 发现共享 mixin 生成未受触屏限制的 Activity hover，源码已修正。
- 聚焦测试 25/25、Web typecheck、Vite 构建、平台边界与 typography check 通过；完整 Linux 包独立 smoke 通过。
- 新归档 SHA-256 `8a96e30efd894118b64058d8605f3bdfcd5fbfbc9e8f8f53fe8d88b2e404c074`，buildId `20260925024353-72c7b9ab13f4`。`opencraft-deploy-stage-8a96e30e.service` 已校验 30442 个文件并暂存 `/opt/opencraft-server/releases/8a96e30efd894118`。
- 新旧 server runtime bundle SHA-256 均为 `aacddf030569b336a051fbad3f3503ad51aba7b62430f23918c76b1fdd8be9a7`；暂存 CSS 无 `.sidebar-activity-item:hover:not(:disabled)`，保留条件式鼠标 hover 与 44px 触控菜单。
- `opencraft-deploy-activate-8a96e30e.service` Result=success，日志报告 `DEPLOYED build=20260925024353-72c7b9ab13f4`；current 指向 `/opt/opencraft-server/releases/8a96e30efd894118`，服务 MainPID `1943887`、`NRestarts=0`，健康端点与 `/version.json` 均正确。

## unverified
- 用户具体滑动症状及 iPhone 实机行为仍未确认。

## discard
- 首次触控修复遗漏了共享 quiet-control mixin 的默认 hover；仅检查 Activity 局部 SCSS 不足以证明最终 CSS 行为。

## restore
- 部署脚本 `/data/mono2/opencraft/release/.deploy-quiet-hover-8a96e30e.sh`，`stage` 已成功；`activate` 核对旧 buildId `20260925022532-668d30451312`，切换失败时回滚 `/opt/opencraft-server/releases/40e759ba730cc084`。
- 原包备份保留在 `release/OpenCraft-server-0.1.0-linux-amd64-before-quiet-hover-40e759ba.tar.gz`，持久状态不动。

## next_action
- 请用户刷新后实测触屏滑动。用户若指出问题不是行底色，继续排查具体输入序列。设计系统仍为触控/桌面一套组件、状态与 token，输入方式只决定瞬时交互呈现。
