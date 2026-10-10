# 云桌面（VNC）真机联调验证文档（v3 · 复用主 sandbox）

> 配套文档：`ctl/docs/cloud-desktop-vnc-plan.md`（v3 方案 + §12 部署模式决策）
> 对应提交：`dc2dbfc58`（feat(desktop): 复用实例主 sandbox + 停服务式回收）
> 面向角色：运维（A 节镜像）、开发（C/D 节）、验收（F 节）
> 前置条件：sandbox 服务已部署、ctl 可部署、ingressproxy 已运行、**有一个 Running 的实例（bot）**
>
> **v3 关键变化（§12）**：桌面**复用实例自己的主 sandbox**，不再新建独立桌面 CVM，
> 因此 **B 节「建桌面 pool」整节删除**、C 节不再需要 `DESKTOP_SANDBOX_TEMPLATE_ID`、
> idle 回收由「pause 整机」改为「只停桌面服务」。图形层需在**主镜像**预装
> （`build.sh --with-desktop`）或按需装（Ubuntu/Debian 的 apt 分支、TencentOS 4.4 的 dnf 分支）。

---

## 0. 速览：整体流程与验收门禁

```
A. 主镜像装图形层 ──▶ C. 部署 ctl(2个环境变量) ──▶ D. 前端E2E ──▶ F. 验收
   (运维,最耗时)         (开发,curl冒烟)            (开发)        (全部)
                        ▲ 用一个现成 Running 实例(bot)即可，无需建 pool
```

**每节都有独立验收门禁，过门禁再进下一节。** 全部通过 = 云桌面上线。

> v2 的「B 建桌面 pool」已删除——桌面跑在实例主 sandbox 上，实例本身就是那台机器。

---

## A. 主镜像加装图形层（运维 · 最先启动 · 0.5–1 天含调试）

> v3：图形层装进**实例主镜像**（而非独立桌面镜像），使实例主 sandbox 自带桌面能力。

### A.1 执行步骤

```bash
# 1. 起一台构建机：Ubuntu 24.04 LTS x86_64 CVM（与现网基座同规格，能访问外网装包）
# 2. 将本仓库 images/ 目录同步到构建机，执行：
cd images
bash build.sh <openclaw_version> --with-desktop
# 3. 构建脚本会在 app layer 之后加装图形层：
#    Xvfb + xfce4 + x11vnc + noVNC + websockify + 中文字体
#    + 4 个 systemd unit（vela-xvfb / vela-desktop-wm / vela-x11vnc / vela-novnc）
#    unit 特性：装好但【不】enable/【不】start —— 运行时由 ctl 经 TAT 注入 VNC 密码后拉起
# 4. 用 images/build-image.py 将该实例打成 CVM 自定义镜像
# 5. 将镜像复制到 sandbox 所在 region，并**作为实例主 pool 的基础镜像**
#    （实例新建/重建后主 sandbox 即自带图形层）
#
# 备选：不改主镜像，点桌面时 ctl 检测图形层缺失并按需安装。
# Ubuntu/Debian 使用 apt；TencentOS 4.4 使用已配置的原生 dnf 仓库。
# 安装脚本异步执行、写进度文件；完成后仍由 provision 注入密码和启动服务。
```

### 腾讯 OS 4.4 按需安装前提

本节仅适用于 CTL 生成的运行时安装脚本，不表示 `images/build.sh` 已支持 TencentOS，也不包含 WebRTC 服务。

- `/etc/os-release` 必须声明 `ID=tencentos`、`VERSION_ID=4.4`；其他 TencentOS 版本明确拒绝，不猜测兼容性。
- 目标已配置原生 BaseOS/AppStream/EPOL 仓库且可访问；脚本不自动添加外部仓库或执行发行版升级。
- 目标具有正在运行的 systemd、`flock`、`getent` 和非交互 sudo；已有非 root `agentuser`，其 home 为 `/home/agentuser`。缺少账户时应先在运行时接入层准备，不在安装脚本中创建或改名、不回退为 root 桌面。
- 在有容器工作负载的开发主机上准备账户时，还须核验现有进程的数值 UID/GID，不能因 NSS 中没有该用户名就默认分配 UID 1000；不要让新桌面账户取得无关容器进程的身份。
- dnf 包：`xorg-x11-server-Xvfb x11vnc novnc python3-websockify xfce4-session xfce4-panel xfce4-settings xfce4-terminal xfdesktop xfwm4 xfce4-appfinder xfce4-notifyd dbus-daemon dbus-x11 google-noto-sans-cjk-sc-fonts curl`。
- 腾讯原生 EPOL 提供 XFCE、x11vnc、novnc 和 python3-websockify；Xvfb、D-Bus 和中文字体来自 AppStream。安装后核验 `/usr/bin/{Xvfb,x11vnc,websockify,dbus-run-session,startxfce4}` 与 `/usr/share/novnc/vnc.html`；服务与 Ubuntu 使用同一 `DISPLAY=:1` 和用户身份。
- 不关闭 SELinux、防火墙或扩大 6080 的公开访问；继续遵循 B' 的内网入口约束。

2026-10-04 在 TencentOS 4.4 x86_64 上只读查询上述仓库包和文件路径，未执行真实安装或启动桌面。模拟安装与 Bash 语法通过仍不能代替 A.3 的图形服务、中文字体和实际连接验收；真机测试应在专用测试实例上另外执行。

同日后续经用户明确授权，在承载本机 OpenCraft 的 TencentOS 4.4 上执行生成脚本：包安装和四个 unit 写入完成；以独立非特权 agentuser 启动临时回环测试，实际 XFCE/终端、1440×900 framebuffer、Noto Sans CJK SC 字体、noVNC HTTP 200 与 WebSocket→RFB 链路通过。测试后临时服务停止，正式 vela unit 保持 disabled/inactive，5900/6080 不监听；OpenCraft 与原 dbus-broker 的 PID、启动时间保持不变。此结果只验证本机图形环境和回环媒体链路，不验证 CTL/TAT/ingress 或 OpenCraft 云桌面 UI/WebRTC。详情见 [本机试装记录](../../docs/context/tasks/2026-10-04-cloud-desktop-local-install.md)。

### A.2 可调参数（环境变量，一般用默认）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DESKTOP_XVFB_SCREEN` | `1440x900x24` | 虚拟显示分辨率 |
| `DESKTOP_VNC_PORT` | `5900` | x11vnc 监听端口（仅实例内网） |
| `DESKTOP_NOVNC_PORT` | `6080` | noVNC/websockify 监听端口（对外端口） |

### A.3 ✅ 门禁 A（镜像可用性，在构建机上验收）

```bash
# 手动模拟运行时行为（unit 装好未启动是预期）：
sudo systemctl enable --now vela-xvfb vela-desktop-wm vela-x11vnc vela-novnc

# 1. 四个 unit 全部 running：
systemctl is-active vela-xvfb vela-desktop-wm vela-x11vnc vela-novnc
# 期望输出四行 active

# 2. noVNC HTTP 可达：
curl -fsS http://127.0.0.1:6080/ | head -3
# 期望返回 noVNC 页面 HTML（<!DOCTYPE html>...）

# 3. （可选但强烈建议）注入密码后用 VNC 客户端实测画面：
x11vnc -storepasswd 'test1234' ~/.vnc/passwd
sudo systemctl restart vela-x11vnc
# 用任意 VNC 客户端连 构建机IP:5900，应看到 xfce 桌面、中文显示正常
```

**常见问题（95% 卡在这里，全在镜像层解决）**：

| 症状 | 原因/解决 |
|---|---|
| unit 启动失败 | `journalctl -u vela-xvfb -u vela-desktop-wm -u vela-x11vnc -u vela-novnc --no-pager | tail -50` |
| 黑屏 | `ExecStart` 的 Xvfb 分辨率参数；确认 `DISPLAY=:1` 下 xfce4-session 正常 |
| 中文豆腐块 | A.1 步骤里 fonts-noto-cjk 未装上，`apt list --installed | grep noto-cjk` 确认 |
| `curl 6080` 不通 | websockify 监听地址；确认 `ss -lntp | grep 6080` 绑定 0.0.0.0 |

---

## B.（已删除）建桌面 pool

> v3 复用实例主 sandbox，**无需独立桌面 pool**。该节整体移除。
> 安全组 6080 放行等要求已并入实例主 sandbox 所在 pool 的既有配置（见 §B'）。

### B'. 实例主 sandbox 的网络前提（运维确认，非新建）

桌面复用实例主机，因此**实例主 sandbox 所在 pool** 的安全组需放行 noVNC 端口：

| 方向 | 协议 | 端口 | 来源 | 用途 |
|---|---|---|---|---|
| 入站 | TCP | 6080 | **VPC 内网网段**（ingressproxy 所在网段） | noVNC WS 流量 |

> 6080 **只放 VPC 内网**，不放公网。ingressproxy 走内网 IP 访问主 sandbox:6080
> （方案 §4.2：路由表存内网 IP，端口来自域名）。若现有实例 pool 未放行 6080，需补一条。

---

## C. 部署 ctl（开发）

### C.1 环境变量（v3：仅 2 个核心，`DESKTOP_SANDBOX_TEMPLATE_ID` 已废弃）

| 环境变量 | 值 | 缺失后果 |
|---|---|---|
| `DESKTOP_INGRESS_DOMAIN` | ingressproxy 对外泛域名 | `POST desktop/session` 到 Ready 时组不出 wsUrl → `DESKTOP_NOT_CONFIGURED` |
| `DESKTOP_IDLE_TIMEOUT_MINUTES` | 默认 30；`0` 禁用回收 | 无（可省略） |
| `DESKTOP_REAP_INTERVAL_MINUTES` | 默认 5；reaper 扫描间隔 | 无（可省略；联调提速用） |

> ~~`DESKTOP_SANDBOX_TEMPLATE_ID`~~ **v3 已废弃移除**——桌面复用实例主 sandbox，无需模板 ID。
>
> `DESKTOP_INGRESS_DOMAIN` 必须满足：`wss://6080-<主sandboxID>.<domain>/websockify` 从浏览器可达，
> 且泛域名证书覆盖 `*.<domain>`（覆盖到**主 sandboxID**，非独立桌面机）。

### C.2 ✅ 门禁 C（curl 冒烟，不需前端）

```bash
# 1. 鉴权：任取一个属于当前用户的实例
TOKEN="<用户 token>"
INSTANCE_ID="<实例ID>"

# 2. 触发（幂等，重复 POST 无副作用）：
curl -X POST https://<ctl-host>/v1/instances/${INSTANCE_ID}/desktop/session \
  -H "Authorization: Bearer ${TOKEN}"
# 首次期望：{"status":"Provisioning"}（在实例主机上 TAT 拉起桌面服务中）
# 已就绪期望：{"status":"Ready","ws_url":"wss://6080-<主sbx>.<domain>/websockify","password":"...","width":1440,"height":900}
# 图形层未装期望：{"status":"Failed","reason":"desktop graphics layer not installed ..."}
#   → 说明主镜像没装图形层（A 节未做），或该实例用的是旧镜像

# 3. 轮询直到 Ready：
curl -s https://<ctl-host>/v1/instances/${INSTANCE_ID}/desktop/session \
  -H "Authorization: Bearer ${TOKEN}"
# Provisioning → Ready 一般数十秒（复用主机，无建机耗时；仅拉起服务 + 探测）

# 4. 实例无主 sandbox 时：
#    对一个未 Running / 无 sandbox 的实例 POST，应返回 DESKTOP_NOT_CONFIGURED
#    （reason: instance sandbox not ready）

# 5. 越权验证：
curl -s https://<ctl-host>/v1/instances/<别人的实例ID>/desktop/session \
  -H "Authorization: Bearer ${TOKEN}"
# 期望 404 INSTANCE_NOT_FOUND（归属校验生效）
```

**响应字段速查**：

| 字段 | 类型 | 何时有 |
|---|---|---|
| `status` | `Provisioning` / `Ready` / `Paused` / `Failed` | 恒有 |
| `ws_url` | string | 仅 Ready |
| `password` | string | 仅 Ready |
| `width`/`height` | int | 仅 Ready（1440/900） |
| `reason` | string | Failed 时（provision 命令失败原因） |

---

## D. 前端 E2E（开发）

### D.1 步骤

1. 前端部署/本地 dev 指向 C 步的 ctl。
2. 登录 → 任一 Agent → 侧边栏 **实验室** 分组 → **云桌面**（Beta 标记）。
3. 观察四阶段：**Provisioning loading（含文案「正在启动云桌面（首次约需 1–2 分钟）…」）→ Ready → noVNC 画面出现 → 鼠标键盘可操作**。

### D.2 ✅ 门禁 D（观察点）

| # | 观察点 | 期望 |
|---|---|---|
| D-1 | 菜单入口 | 实验室分组下「云桌面」带 Beta 徽标，点击高亮当前页 |
| D-2 | Provisioning 态 | loading spinner + 文案，**不泄露 ws_url/password** |
| D-3 | Ready 连接 | noVNC 画布出现，画面为 xfce 桌面 |
| D-4 | 键鼠 | 鼠标移动/点击、键盘输入生效（在桌面里打开终端敲几个字） |
| D-5 | 断线重试 | 杀掉网络 10s 再恢复 → 提示「连接中断」→ 点重试可恢复 |
| D-6 | 无 IP 泄露 | DevTools Network 里只有 `wss://6080-<sbx>.<domain>` 域名，无任何内网 IP |

---

## E. 排障工具箱（按症状对号）

| 症状 | 排查顺序 |
|---|---|
| 一直 `Provisioning` | ① ctl 日志搜 `desktop_provision` / `desktop_probe`（TAT 命令输出）→ ② 登 CVM `systemctl status vela-*` 四 unit → ③ `curl 127.0.0.1:6080` → ④ `journalctl -u vela-novnc` 看 websockify 是否起来 |
| 返回 `Failed` + reason | reason 即 TAT 命令 stderr 摘要；命令输出受 300s/1MiB 截断，必要时登机手动跑 `renderDesktopProvisionCommand` 同款命令 |
| WS 连不上（前端 connecting 后失败） | ① 安全组内网 6080（B.2）→ ② 泛域名证书 `*.<domain>` 覆盖 `6080-<sbx>.<domain>` → ③ ingressproxy router 日志有无 upstream 连接错误 |
| 连上但黑屏 | `journalctl -u vela-x11vnc`（VNC 认证/显示错误）→ `journalctl -u vela-xvfb`（X server）→ 分辨率参数 |
| VNC 密码错 | TAT 重新注入：`x11vnc -storepasswd '<新密码>' ~/.vnc/passwd && systemctl restart vela-x11vnc` |
| 挂机 30 分钟断开 | **预期行为**（idle 回收 = 停桌面服务，主机不停机）。前端 connected 态每 30s GET 心跳刷新活跃；若「正在使用仍被回收」→ 查心跳是否被浏览器 tab 休眠打断。再次进入自动重新拉起服务 |
| `Provisioning` 超过 2 分钟 | TAT 卡住或图形层拉起慢；查 `desktop_provision` 命令是否 TIMEOUT、四 unit 是否 enable 成功（复用主机无建机耗时，慢多半在服务启动） |
| `Failed` + `graphics layer not installed` | 主镜像未装图形层（A 节）；确认该实例用的是 `--with-desktop` 产出的主镜像 |
| `DESKTOP_NOT_CONFIGURED` | `DESKTOP_INGRESS_DOMAIN` 未配（Ready 组 wsUrl）；或实例无主 sandbox（未 Running）|

**通用排障入口**：
- ctl 日志：`desktop_provision` / `desktop_probe` 关键字（含 TAT 命令完整输出）
- CVM 内：`systemctl status vela-xvfb vela-desktop-wm vela-x11vnc vela-novnc` + `journalctl -u <unit>`
- 代理层：ingressproxy router 日志按 `6080-<sandboxID>` 域名过滤

---

## F. 最终验收清单（P5 DoD，全过 = 上线）

| # | 验证项 | 方法 | 通过标准 |
|---|---|---|---|
| V1 | 镜像 | A.3 门禁（在装了图形层的主镜像实例上） | 四 unit active + `curl 6080` 出 noVNC 页 + VNC 客户端可见桌面 |
| V2 | 编译/测试 | 已在提交 `dc2dbfc58` 验证 | `go build`/`go test -race`/`tsc`/`vitest` 全绿（本仓 CI 会复跑） |
| V3 | 单测 | 同上 | 18 个 desktop 单测 + 2 个导航测试通过 |
| V4 | 路由 | C.2 拿到 ws_url 后 `wscat -c "<ws_url>"` 或浏览器直连 | WS 握手成功（101），经 ingressproxy 转发到**主 sandbox**:6080 |
| V5 | 闭环 | D.1 全流程 | 前端连上、画面刷新、键鼠生效 |
| V6 | 无公网 IP | 控制台查实例 CVM | 实例无公网 IP（`AddressType=private`），链路照常工作 |
| V7 | 安全 | D-6 + C.2.5 | 前端无内网 IP 泄露；VNC 密码鉴权；越权 404；router `PROXY_ENABLE_IP_BACKDOOR=false` |
| V8 | 复用不越界 | 停桌面服务 / 删实例 | idle 只 `systemctl stop` 桌面 4 unit，**主机与 agent 不受影响**；删实例时随主 sandbox 一并释放 |
| V9 | idle 回收 | 挂机 >30min（或临时调小 `DESKTOP_IDLE_TIMEOUT_MINUTES`） | 桌面服务被 stop、状态转 `Paused`（**主机不停机**）；再次进入自动重新拉起服务回到 Ready |
| V10 | 异步状态机 | C.2 首次 POST | 返回 `Provisioning`，轮询到 `Ready` 才发 ws_url；TAT 命令均 <300s |

> **V9 提速技巧**：联调时 `DESKTOP_IDLE_TIMEOUT_MINUTES=2`、`DESKTOP_REAP_INTERVAL_MINUTES=1`，最多 3 分钟即可观察到桌面服务被停；验收完改回默认。

---

## 附：与方案文档的对应关系

| 本文档节 | 方案文档 |
|---|---|
| A 镜像（主镜像图形层） | §3 镜像层方案 / §12 TB.8 |
| ~~B pool~~（已删除） | §12 复用主 sandbox，无独立 pool |
| C ctl | §4.3 异步 session + §4.4 鉴权与安全 + §12 TB.1/TB.5 |
| D 前端 | §5 前端方案 |
| E 排障 | §4.3.1 TAT 约束 / §12 TB.4 停服务式回收 |
| F 验收 | §8 DoD + §12.7 验证清单调整 |

---

## 附二：v2 → v3 验证流程差异（给已看过 v2 的人）

| 环节 | v2（独立 CVM） | v3（复用主 sandbox） |
|---|---|---|
| 建独立桌面 pool | 需要（B 节） | **删除**——用现成 Running 实例即可 |
| ctl 环境变量 | 3 个（含模板 ID） | 2 个核心（`DESKTOP_INGRESS_DOMAIN` + 可选回收项）|
| Provisioning 耗时 | 1–3 分钟（含建机） | 数十秒（仅拉起服务）|
| idle 回收 | `PauseSandbox` 整机（STOP_CHARGING）| `systemctl stop` 桌面服务，主机不停 |
| 恢复 | `ResumeSandbox` 唤醒整机 | `provisionDesktop` 幂等重拉服务 |
| 图形层缺失 | 不会（独立桌面镜像必带）| 返回 `Failed` 提示（主镜像须 `--with-desktop`）|

## OpenCraft 资源准备兼容说明（2026-10-04）

新 `desktop/resource` 将明确准备与只读查询分开；旧 `desktop/session` 的启动、GET 心跳与 VNC DTO 保留兼容。两者核验缓存的用户/Sandbox 绑定，避免换机后复用旧 Ready；后台安装仍使用同一 Ubuntu/TencentOS 生成脚本。本轮只有模拟 TAT 测试，未执行云端命令或替换预览。新接口不提供 WebRTC 或输入控制，详见 [资源准备契约](cloud-desktop-resource.md)。
