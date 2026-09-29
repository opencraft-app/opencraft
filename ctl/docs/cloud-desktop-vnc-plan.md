# 云桌面（VNC）自建方案 —— 前端到后端闭环技术方案与执行 TODO

> 面向执行 agent 的落地文档。基于 mono2 现有代码调研得出，所有引用的文件路径、接口、字段均已在仓库中核实。
> 目标：在 mono2 内自建一套 VNC 云桌面，用户可在 **frontend 实验室菜单 → 云桌面** 页面中，通过浏览器实时操作一台云端桌面。
> 连接不依赖公网 IP，全程走 sandbox 现有的 **ingressproxy 反向代理 + WebSocket**。
>
> **版本**：v3（v2 完成一轮 CR 见 §11；v3 新增 **§12 部署模式决策**——经代码核实，桌面从「独立 CVM」改为「复用实例主 sandbox + 按需装图形层」，向全模块主流范式收敛）。

---

## 0. 结论速览（TL;DR）

| 维度 | 结论 |
|---|---|
| 是否需要公网 IP | **不需要**。走 ingressproxy 域名寻址（默认 `AddressType=private` 内网 IP） |
| 实例形态 | 腾讯云 **CVM**（完整 VM，可装 X11+VNC），非容器 |
| 可复用基础设施 | CVM provider、ingressproxy（**原生支持 WebSocket**）、TAT 命令流、镜像构建流水线（`build-image.py`）、frontend labs 菜单机制、TAT wss 客户端范式、鉴权链路 |
| 需从零建 | 镜像图形层（Xvfb/WM/x11vnc/websockify+noVNC）、桌面生命周期编排、desktop session 接口、前端云桌面页 |
| noVNC 依赖 | 已在 `pnpm-lock.yaml`（`@novnc/novnc@1.5.0` 传递依赖），需提升为直接依赖 |
| 多端口路由（原 P0 阻塞） | ✅ **已解除**：`route.Rule` 不绑端口，端口来自域名，`6080-<sandboxID>` 天然可寻址，无需改路由表 |
| ⚠️ 桌面实例回收 | **现状无自动回收**（`TimeoutSeconds` 是死字段），桌面 CVM 常驻高成本，**需新建 idle-timeout + 主动 pause**（见 §4.5） |
| ⚠️ TAT 硬约束 | 单命令 **≤300s、输出 ≤1MiB**，就绪判定须上移到 ctl 异步状态机（见 §4.3） |
| 纯代码工作量 | 1.5–2 人日（可编译+单测，不含真机） |
| 含镜像调试+真机联调 | 现实 **4–6 人日**（含 idle 回收 +0.5–1d），卡点在镜像迭代与真机环境 |

---

## 1. 现状调研结论（事实依据）

### 1.1 可直接复用（已核实）

| 能力 | 位置 | 对云桌面的价值 |
|---|---|---|
| 腾讯云 CVM provider | `sandbox/internal/provider/tencent.go` | 建机/销毁/改配/取址现成；完整 VM 可装桌面 |
| ingressproxy 支持 WebSocket（router→shard 双跳） | `sandbox/internal/ingressproxy/router.go` + `router_test.go:492-572 TestEndToEndWebSocketViaRouterAndShard` | ⭐ noVNC 走 WS，代理层**零改动**透传桌面流；**E2E 测试覆盖全链路两跳**（CR 已核实） |
| 域名寻址（端口来自域名，非路由表） | `target.go:57-75 parseSandboxHost`（`<port>-<sandboxID>`）+ `router.go:205 url.Parse("http://"+address+":"+target.Port)` | ⭐ 一条 `Rule{Address}` 天然支持任意端口；6080 无需单独注册（CR 已核实，原 P0 解除） |
| 路由写入/删除接口 | `sandbox/api-gin/handler.go:225-233, 273-274`；`route.Store.Set/Delete(route.Rule{SandboxID,InstanceID,Address})` | 建机时写一次即可，桌面 6080 自动可寻址 |
| TAT 命令流（同步 exec-stream） | `sandbox/internal/provider/tat_stream.go`；ctl 侧 `adapter.go:1214 StreamPtyCommand`；现网范例 `ctl/pkg/instance/async.go:2399 configureOnboard` | 远程在 CVM 上装/起桌面服务，免 SSH。**约束：单命令 ≤300s、输出 ≤1MiB、固定 `agentuser`/`/home/agentuser`** |
| instance→sandbox 客户端 | `ctl/pkg/adapter/sandbox/adapter.go`（`SandboxAdapter`：`CreateSandbox`/`StreamPtyCommand`/`PauseSandbox`/`ResumeSandbox`/`DeleteSandbox`） | desktop session 直接复用，无需新建客户端（CR 已核实） |
| pool 绑镜像/规格 | `core/types.go:122-152`（`BaseImage`/`InstanceType`/`SystemDiskSize`）；`internal_pools.go:72-96 POST /pools`；`service/pool.go:126 CreateBoundPool` | 加桌面 pool 是纯配置（DB 行），不改 provider 建机代码（CR 已核实） |
| 镜像构建流水线 | `images/build-image.py`、`images/build.sh`、`images/build-manifest.json` | 打 CVM 自定义镜像、多区域复制现成 |
| systemd service 安装范式 | `images/build.sh:1807-1829`（envd.service） | VNC/websockify 服务可照抄写 unit |
| 镜像基座 | `img-mmytdhbn`（Ubuntu 24.04）含 Node/Python/**Playwright+chromium** | 省掉底座，仅需加图形层 |
| frontend labs 菜单机制 | `src/lib/agent-routes.ts` + `src/pages/marketing/agent-settings-page.tsx` | 加一页是标准活，有 DeepSeek Harness 范例 |
| TAT wss 客户端范式 | `src/lib/tencent-tssh-proxy-client.ts` / `tencent-pty-client.ts` | 桌面 WS 连接可照抄 |
| 桌面宿主 UI 参考 | `src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx` | viewer 布局参考 |
| 鉴权链路 | `http-repositories.ts`（`Authorization: Bearer` + `readStoredAuthToken`） | 复用，不新建 |
| DSH 动态能力框架（可选） | `opencraft/apps/local-agent-host/src/dsh-capability-{plugin.mjs,broker.ts,link.ts}` | 若要让 agent 也能操作桌面，注册 `vela_desktop` namespace |
| 浏览器控制插件（可选参考） | `opencraft/packages/browser-appserver/src/dynamic-tools.ts`（`vela/browser-use`） | agent 桌面/浏览器能力的现成范式 |

### 1.2 需从零建（仓库中确认不存在）

- 全仓 `git grep vnc/novnc/websockify/guacamole/x11vnc/xvfb/6080` **零命中**（业务代码）。
- 现有镜像 chromium 是 **headless**，无 X11 显示服务器、无窗口管理器、无 VNC。
- 无 "Cloud Desktop / VNC / remote-desktop" 插件或占位（`RemoteControl*` 是账号级远程控制配对协议，语义不同，**勿混用**）。

### 1.3 关键设计约束（CR 后更新）

- ✅ **多端口路由已解除阻塞**：`route.Rule` 不含端口字段，端口由域名 `<port>-<sandboxID>` 提供，upstream 动态拼 `http://<address>:<port>`。同一条路由规则天然支持任意端口，6080 无需单独注册（详见 §4.2）。
- ⚠️ **TAT 硬约束**：单命令 ≤300s、输出 ≤1MiB、运行用户固定 `agentuser`。桌面"就绪判定"不能塞进一条长轮询命令，须上移到 ctl 异步状态机（详见 §4.3）。
- ⚠️ **无现成实例回收**：`TimeoutSeconds`/`AutoPause` 是死字段（sandbox timeout 端点空实现 `handler.go:732-735`，worker 不回收 ALLOCATED 活跃实例）。桌面省费需**新建** idle 回收（详见 §4.5）。
- ⚠️ **IP backdoor 安全边界**：ingressproxy router 默认 `PROXY_ENABLE_IP_BACKDOOR=false`、shard 默认 `true`。桌面方案须保证 **router 侧保持 false**，6080 只走域名路由 + 鉴权（详见 §4.4）。

---

## 2. 目标架构（端到端闭环）

```
浏览器 (frontend labs/云桌面页)
   │  noVNC over WebSocket
   │  wss://<port>-<sandboxID>.<ingress-domain>/websockify
   ▼
ingressproxy (router → shard)   ← 已支持 WS，零改动
   │  内网转发 http(ws)://<CVM内网IP>:6080
   ▼
CVM 云桌面实例 (自定义镜像)
   ├─ Xvfb (:1)                 虚拟显示
   ├─ 窗口管理器 (xfce4/openbox)
   ├─ x11vnc  → :5900           VNC server
   ├─ websockify/noVNC → :6080  VNC→WS 网关（对外暴露端口）
   └─ chromium (复用现有)        桌面内浏览器
```

**控制面（建机/装桌面/取连接串）——异步 Provisioning→Ready：**
```
frontend ──HTTP(Bearer)──▶ ctl POST /v1/instances/{id}/desktop/session
   ctl ──▶ sandbox (建/查 CVM + 经 TAT 短命令拉起桌面服务，不长等)
   ctl ◀── 首次返回 { status: "Provisioning" }
frontend ──轮询──▶ ctl GET .../desktop/session  直到 { status:"Ready", wsUrl, password, w, h }
frontend ──WS(wsUrl)──▶ ingressproxy(router→shard) ──▶ CVM:6080
```

**核心原则：**
1. 连接寻址一律由后端下发 `wsUrl`，前端**绝不拼内网 IP**（防 SSRF）。
2. 复用 TAT 拉起桌面服务，不开 SSH。
3. VNC 加密码/一次性 token 鉴权，wss 承载。

---

## 3. 镜像层方案（图形栈）

### 3.1 基座与新增

- 基座：`build-manifest.json` 的 `img-mmytdhbn`（Ubuntu 24.04，已含 Node/Python/Playwright/chromium）。
- 在 `images/build.sh` 新增一个安装阶段 `install_desktop_layer()`，`apt_install` 以下包：
  - 显示/桌面：`xvfb xfce4 xfce4-terminal dbus-x11 x11-utils`（或更轻量 `openbox tint2`）
  - VNC：`x11vnc`（或 `tigervnc-standalone-server`）
  - WS 网关：`novnc websockify`（Ubuntu 源自带；或 pin 版本从 COS 拉）
  - 中文/字体：`fonts-noto-cjk fonts-wqy-zenhei`（避免中文豆腐块）
- 参数：新增 `--with-desktop` / `--desktop-only` flag，纳入 `should_install_*` 体系（参考 `install_all_plugins` 的开关范式，`build.sh:2000+`）。

### 3.2 systemd 服务（照抄 `build.sh:1807-1829` envd.service 范式）

需要写 3 个 unit（建议 system 级或 `agentuser` user 级，与 envd 一致）：

1. `vela-xvfb.service` — `ExecStart=/usr/bin/Xvfb :1 -screen 0 1440x900x24`
2. `vela-desktop.service` — 依赖 xvfb，`Environment=DISPLAY=:1`，`ExecStart` 拉起 WM + x11vnc（`x11vnc -display :1 -rfbport 5900 -rfbauth <passwd_file> -forever -shared`）
3. `vela-novnc.service` — `ExecStart=websockify --web=/usr/share/novnc 6080 localhost:5900`

> 注意：VNC 密码文件由**运行时注入**（见 §4.3），不写死进镜像。镜像里放好 unit，但 `x11vnc` 密码在建机后由 TAT 下发生成。

### 3.3 分辨率/DPI

- 默认 1440x900x24；支持后续通过 `xrandr`/重启 xvfb 调整（一期固定分辨率即可）。

### 3.4 规格提示

- 桌面 pool 必须用**大内存规格**（图形环境远超默认 `SA9.MEDIUM2`）。规格随 pool 配置，不改 provider 代码（见 §4.1、CR-4）。

---

## 4. 后端方案

### 4.1 sandbox 层：桌面生命周期编排

在 sandbox 新增桌面能力（建议放 `sandbox/internal/desktop/` 或复用现有 provider 扩展）：

1. **建机**：复用 `SandboxAdapter.CreateSandbox`（`adapter.go:504`）；**桌面走独立 pool**（§3 自定义镜像 + **大内存规格，勿用默认 `SA9.MEDIUM2`**）。需配置"桌面 template_class → 桌面 pool"的分配映射（`service/pool.go` `AllocationResolution`），否则会落到普通 pool。
2. **拉起桌面服务**：建机后经 **TAT 同步 exec-stream**（`StreamPtyCommand`，范式见 `async.go:2399 configureOnboard`）执行**短命令**（受 300s/1MiB 约束，见 §4.3）：
   - 生成 VNC 密码 → `x11vnc -storepasswd <pwd> ~/.vnc/passwd`（运行用户固定 `agentuser`）
   - `systemctl enable --now vela-xvfb vela-desktop vela-novnc`
   - **只快速探测一次** `localhost:6080`，不在命令内长轮询等待；就绪判定交给 ctl 外层轮询（§4.3）。
3. **路由**：**无需为 6080 单独注册**。建机时 `route.Store.Set(Rule{SandboxID,InstanceID,Address})` 写一次内网 IP 即可，`6080-<sandboxID>` 自动可寻址（见 §4.2）。
4. **销毁**：复用 `route.Store.Delete(ctx, sb.ID)`（`handler.go:273-274`）+ `DeleteSandbox` 释放 CVM。
5. **省费回收**：见 §4.5（现状无自动回收，需新建）。

### 4.2 多端口路由 —— ✅ 已确认（原 P0 阻塞解除）

**CR 已核实结论：无需任何路由表结构改动。** 机制如下：

- **端口来自域名，不来自路由表**：`parseSandboxHost`（`target.go:57-75`）把 `Host` 按 `<port>-<sandboxID>` 拆开，`isValidPort` 只校验 1–65535（6080 合法）。
- **`Rule` 不绑端口**：`Rule{InstanceID, Address}`（`router.go:108-111`）只存内网 IP。
- **upstream 动态拼接**：`address = rule.Address; upstream = "http://" + address + ":" + target.Port`（`router.go:196-205`）。

因此同一条 `Rule{Address}` 天然支持任意端口：`6080-<sandboxID>`→`http://<内网IP>:6080`（noVNC）、`8080-<sandboxID>`→`:8080`（主服务），**共用一条路由，建机写一次即可**。

> 原方案 B（扩展 `route.Rule` 加端口字段）**已废弃，不需要**。
>
> 剩余仅两个**环境侧**待确认（非代码阻塞）：① 桌面 CVM **安全组放行内网 6080**；② ingress 泛域名证书覆盖 `*-<sandboxID>`。见 §9 风险表与 T0.2。

### 4.3 ctl 层：desktop session 接口

在 `ctl/main/api/server.go` 注册新子资源（现有 `mux.HandleFunc("/v1/instances/", handler.handleInstance)` L234，且已有子资源分发范式 `handleInternalInstanceSubresource` L226）：

**采用异步 Provisioning→Ready 模型（CR 修订）**，原因见 §4.3.1。

- 路由：
  - `POST /v1/instances/{id}/desktop/session` —— 触发建机/装桌面（幂等），立即返回当前状态。
  - `GET  /v1/instances/{id}/desktop/session` —— 前端轮询就绪状态。
- 逻辑（`ctl/pkg/instance/` 新增方法，复用 `SandboxAdapter`，参考 `logic.go`/`async.go`）：
  1. 校验用户拥有该实例（复用 `instanceDao.GetByInstanceID` + user 校验）。
  2. 若无桌面沙箱：`CreateSandbox`（选桌面 pool）→ 记录状态 `Provisioning` → 异步（或下次轮询时）经 TAT 短命令拉起服务。
  3. 每次调用探测 6080 就绪：未就绪返回 `Provisioning`；就绪则生成/取 VNC 密码 + 组 `wsUrl` 返回 `Ready`。
  4. `wsUrl` = `wss://6080-<sandboxID>.<ingress-domain>/websockify`。
- 响应 DTO（`ctl/pkg/transport/instance.go` 新增）：
  ```go
  type DesktopSessionResponse struct {
      Status    string `json:"status"`             // Provisioning / Ready / Failed
      WsURL     string `json:"ws_url,omitempty"`    // 仅 Ready 时有
      Password  string `json:"password,omitempty"` // 仅 Ready 时有；或短期 token
      Width     int    `json:"width,omitempty"`
      Height    int    `json:"height,omitempty"`
      Reason    string `json:"reason,omitempty"`    // Failed 时的原因
      ExpiresAt int64  `json:"expires_at,omitempty"`
  }
  ```
- 指标：复用 `server.go` 现有路径归一化（L382+），把 `/v1/instances/{id}/desktop/session` 加入归一表避免高基数标签。

#### 4.3.1 为什么必须异步（TAT 300s/1MiB 硬约束）

TAT 单命令硬上限 **300 秒 / 输出 1MiB**（`tat_stream.go:23-24`；`internal_tat_stream.go:22`；`adapter.go:41`）。桌面首启（Xvfb+WM+x11vnc+novnc + 等 6080 就绪）若塞进一条长轮询命令易撞 300s、日志易超 1MiB。因此：
- TAT 命令只做"生成密码 + `systemctl enable --now` + 快速探测一次"，秒级、输出精简。
- 就绪判定上移到 ctl 外层 `GET session` 轮询（Provisioning→Ready），而非命令内 sleep 等待。

### 4.4 鉴权与安全边界

- 前端→ctl：复用 `Authorization: Bearer`（`http-repositories.ts` request()）。
- ctl→sandbox：复用现有内部调用鉴权（`X-API-Key`，`adapter.go:178,801`）。
- 桌面本身：VNC 密码/一次性 token；wss 传输加密。**一期用 VNC 密码即可**，二期接短期 token。
- ⚠️ **IP backdoor（CR 核实）**：ingressproxy router 默认 `PROXY_ENABLE_IP_BACKDOOR=false`（`cmd/ingressproxy-router/main.go:40`），shard 默认 `true`（`cmd/ingressproxy-shard/main.go:53`）。桌面 6080 暴露的安全性依赖 **router 侧保持 false**（只允许 `<port>-<sandboxID>` 域名路由，禁止按任意 IP:Port 直连）。**方案约束：桌面上线不得把 router 的该开关设为 true**，否则打开 SSRF/越权面。6080 一律走域名路由 + 鉴权。

### 4.5 桌面实例回收（CR 新增 —— 现状无自动回收，必须新建）

**背景（CR 核实）**：`Sandbox.TimeoutSeconds`/`AutoPause` 是**死字段**——sandbox timeout 端点空实现直接 204（`handler.go:732-735`），service 层不消费；worker 回收 loop **明确不碰 ALLOCATED 活跃实例**（`cmd/worker/main.go:815-817`）。**不存在对活跃桌面的自动回收**。桌面 CVM 是大内存常驻机，成本高，必须自建回收。

**方案（一期，MVP）**：
- ctl 侧引入**桌面 idle-timeout**：记录 `last_active_at`（前端 viewer 定期心跳 / 每次 `GET session` 刷新）。
- 超过阈值（如 30min 无活跃）→ ctl 调 `SandboxAdapter.PauseSandbox`（`adapter.go:621`，`STOP_CHARGING` 关机省费、保留数据）。
- 用户再次进入 → `ResumeSandbox`（`adapter.go:672`）唤醒。
- 触发方式：ctl 侧定时扫描，或复用现有异步任务框架（`ctl/pkg/instance/async.go`）。

**二期（可选）**：sandbox worker 增加基于时间的 reaper loop（需新增 `last_active_at`/`timeout_at` schema），把回收下沉到 sandbox 侧。成本较高，非 MVP。

> **执行提示**：谁维护 `last_active_at`、阈值多少、pause 还是 delete，必须在实现前拍板。默认建议：前端心跳维护、30min、pause（可 resume）。

---

## 5. 前端方案（frontend 实验室加一页「云桌面」）

技术栈：Next.js 16 App Router + React 19。范例：DeepSeek Harness。改动 4 处 + 新建 1 组件：

1. **`src/lib/agent-routes.ts`**
   - `AgentSettingsSectionId` / `AgentLabSectionId` 增加 `"cloud-desktop"`。
   - `AGENT_SECTION_PATH_BY_ID` 加 `"cloud-desktop": \`${AGENTS_HOME_PATH}/labs/cloud-desktop\``。
   - `AGENT_LAB_SECTION_ID_BY_SLUG` 加 `"cloud-desktop": "cloud-desktop"`。
2. **`src/pages/marketing/agent-settings-page.tsx`**
   - `settingsGroups` 的 `id:"labs"` 分组 `sections` 加一条：`{ id:"cloud-desktop", label:t("云桌面"), icon:<Monitor/>, path:AGENT_SECTION_PATH_BY_ID["cloud-desktop"], badge:"Beta" }`（icon 用 `lucide-react` 的 `Monitor`）。
   - 渲染分发处（约 L6572-6586）加：`{activeSection === "cloud-desktop" && <CloudDesktopPanel botId={activeBot.id} />}`，并 import。
3. **新建 `src/pages/marketing/agent-cloud-desktop-panel.tsx`**（`"use client"`）
   - 用 `useRepositories()` 拿 client。
   - `POST .../desktop/session` 触发 → **轮询 `GET .../desktop/session` 直到 `status:"Ready"`**（展示 Provisioning loading 态），拿到 `{ wsUrl, password, width, height }`。
   - 用 `@novnc/novnc` 的 `RFB` 连 `wsUrl`，传 `credentials.password`。
   - WS 连接错误/断线/重连参考 `src/lib/tencent-tssh-proxy-client.ts`；容器布局参考 `agents-workbench/VelaWorkbenchDesktopHost.tsx`。
   - **活跃心跳（配合 §4.5 回收）**：viewer 打开期间定期调 `GET session` 或专用心跳刷新 `last_active_at`。
4. **App Router**：`app/(site)/agents/labs/[lab]/page.next.tsx` **无需改**（动态段自动处理新 slug）。
5. **依赖**：`package.json` 把 `@novnc/novnc` 提升为直接依赖（当前仅传递依赖存在于 lock）。
6. **repositories**：`http-repositories.ts` 增加 `createDesktopSession(instanceId)` 方法；`types.ts` 加类型；`fake-repositories.ts` 加 fake。
7. **测试**：仿 `src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx` 增导航/渲染断言。

**安全**：`wsUrl` 由后端下发，前端不拼内网 IP；baseUrl 走 env（`NEXT_PUBLIC_AUTH_API_BASE_URL`），勿硬编码。

---

## 6. 端到端调用时序

```
1. 用户进入 frontend labs → 云桌面页（选中一台实例）
2. 前端 POST /v1/instances/{id}/desktop/session  (Bearer)
3. ctl 校验归属 → CreateSandbox(桌面 pool) → 记 Provisioning → TAT 短命令拉起 xvfb/wm/x11vnc/novnc
     （建机时 route.Store.Set 写内网 IP 一次，6080 自动可寻址，无需单独注册）
4. ctl 首次返回 { status:"Provisioning" }
5. 前端轮询 GET .../desktop/session；ctl 探测 6080 就绪 → 生成 VNC 密码 → 返回
     { status:"Ready", wsUrl: wss://6080-<sandboxID>..../websockify, password, 1440, 900 }
6. 前端 noVNC RFB 连 wsUrl → ingressproxy(router→shard) → CVM:6080 → 画面渲染，鼠标键盘可用
7. viewer 期间定期心跳刷新 last_active_at；空闲超时 ctl 调 PauseSandbox 省费
```

---

## 7. 执行 TODO（供其他 agent 按序执行）

### 阶段 P0：设计确认
- [x] **T0.1** ✅ **已完成（CR 核实）**：多端口路由方案 A 成立，`Rule` 不绑端口，`6080-<sandboxID>` 天然可寻址，无需改路由表（见 §4.2）。
- [ ] **T0.2（环境侧，非代码阻塞）** 确认：① 桌面 CVM 安全组放行内网 6080；② ingress 泛域名证书覆盖 `*-<sandboxID>`；③ 桌面 pool 的镜像/规格/template_class 映射（见 §4.1）。

### 阶段 P1：镜像图形层（1–2.5d，含调试；建议最先并行启动）
- [ ] **T1.1** `images/build.sh` 新增 `install_desktop_layer()` + `--with-desktop` flag（apt 装 xvfb/xfce4/x11vnc/novnc/websockify/中文字体）。
- [ ] **T1.2** 写 3 个 systemd unit（xvfb/desktop/novnc），照 `build.sh:1807-1829` envd.service 范式。
- [ ] **T1.3** 用 `images/build-image.py --with-desktop` 打自定义镜像；本地/单机验证 `localhost:6080` 出画面。
- [ ] **T1.4** 更新 `build-manifest.json` 记录桌面镜像 id；多区域复制。

### 阶段 P2：sandbox 编排（1–1.5d）
- [ ] **T2.1** 新增桌面 pool（DB 行：桌面镜像 + **大内存规格** + template_class 映射）；确认分配链路选中桌面 pool。
- [ ] **T2.2** 桌面编排：`CreateSandbox`(桌面 pool) → TAT **短命令**(生成 VNC 密码 + `systemctl enable --now` 三服务 + 快速探测一次，≤300s/≤1MiB)。
- [ ] **T2.3** 路由**无需为 6080 单独注册**（复用建机时 `route.Store.Set` 单条）；销毁复用 `route.Store.Delete` + `DeleteSandbox`；单测覆盖幂等。

### 阶段 P3：ctl 接口 + 回收（1.5–2d）
- [ ] **T3.1** `ctl/pkg/transport/instance.go` 加 `DesktopSessionResponse`（含 `status`）。
- [ ] **T3.2** `ctl/pkg/instance/` 加桌面 session 方法（**异步 Provisioning→Ready**）：校验归属 + `CreateSandbox` + TAT 拉起 + 探测就绪 + 组 wsUrl/发密码。复用 `SandboxAdapter`。
- [ ] **T3.3** `ctl/main/api/server.go` 注册 `POST`+`GET /v1/instances/{id}/desktop/session` + 路径归一化。
- [ ] **T3.4** **（CR 新增）idle 回收**：`last_active_at` 维护 + 超时调 `PauseSandbox`，再次进入 `ResumeSandbox`（见 §4.5）。
- [ ] **T3.5** 单测：归属校验、幂等、Provisioning→Ready 状态机、wsUrl 组装、鉴权失败、idle→pause。

### 阶段 P4：前端云桌面页（1–1.5d）
- [ ] **T4.1** `agent-routes.ts` 加 `cloud-desktop` 路由/slug/类型。
- [ ] **T4.2** `agent-settings-page.tsx` labs 分组加菜单项 + 渲染分发。
- [ ] **T4.3** 新建 `agent-cloud-desktop-panel.tsx`（noVNC RFB + WS 连接 + 断线重连 + loading/error 态）。
- [ ] **T4.4** `package.json` 提升 `@novnc/novnc` 为直接依赖；`http-repositories.ts`/`types.ts`/`fake-repositories.ts` 加 `createDesktopSession`。
- [ ] **T4.5** 测试：仿 `agent-settings-labs-nav.test.tsx` 补导航/渲染。

### 阶段 P5：联调与验证（1d，依赖真机）
- [ ] **T5.1** 端到端：前端点开→建机→装桌面→noVNC 出画面→鼠标键盘可操作。
- [ ] **T5.2** ingressproxy WS 透传验证（大流量/长连稳定性）。
- [ ] **T5.3** 断线重连、超时回收、并发多用户隔离。
- [ ] **T5.4** 安全核查：无公网 IP 直连、wsUrl 不泄内网、VNC 密码强度、token 过期。

### 阶段 P6：可选增强（非 MVP）
- [ ] **T6.1** VNC 密码 → 短期一次性 token。
- [ ] **T6.2** 分辨率自适应（xrandr）。
- [ ] **T6.3** 让 agent 也能操作桌面：注册 DSH `vela_desktop` capability（参考 `browser-appserver/dynamic-tools.ts`）。
- [ ] **T6.4** 桌面镜像固化进 pool 预热，降低冷启动。

---

## 8. 验证清单（Definition of Done）

| # | 验证项 | 通过标准 |
|---|---|---|
| V1 | 镜像 | 自定义镜像单机 `curl localhost:6080` 出 noVNC 页，VNC 能连出桌面 |
| V2 | 编译 | `go build ./...`（sandbox+ctl）通过；`pnpm build`（frontend）通过 |
| V3 | 单测 | sandbox 编排、ctl session、前端导航测试全绿 |
| V4 | 路由 | `wss://6080-<sandboxID>...` 经 ingressproxy 正确转发到 CVM:6080 |
| V5 | 闭环 | 前端云桌面页连上、画面刷新、鼠标键盘生效 |
| V6 | 无公网 IP | 桌面实例 `AddressType=private`，全程无公网 IP 仍可用 |
| V7 | 安全 | 前端无内网 IP 泄露；VNC 有鉴权；未授权用户拿不到他人 session；router `PROXY_ENABLE_IP_BACKDOOR=false` |
| V8 | 销毁 | 实例销毁后路由删除、CVM 释放、无残留 |
| V9 | idle 回收 | 空闲超时自动 `PauseSandbox` 省费；再次进入 `ResumeSandbox` 可恢复 |
| V10 | 异步 session | 首启返回 Provisioning，轮询到 Ready 才给 wsUrl；TAT 命令均 <300s |

---

## 9. 风险与决策点

| 风险/决策 | 说明 | 处置 |
|---|---|---|
| ~~多端口路由~~ | ~~现有 rule 单 Address~~ | ✅ **已解除**：`Rule` 不绑端口，6080 天然可寻址（§4.2） |
| ⚠️ **桌面回收（CR-1）** | `TimeoutSeconds` 是死字段，无自动回收；CVM 常驻高成本 | **必须新建** idle-timeout + `PauseSandbox`（§4.5，T3.4）。**不能依赖现状** |
| ⚠️ **TAT 300s/1MiB（CR-2）** | 单命令硬上限 | session 改**异步** Provisioning→Ready；TAT 只跑短命令，就绪判定外层轮询（§4.3） |
| ⚠️ **IP backdoor（CR-3）** | shard 默认开、router 默认关 | 桌面上线**保证 router 侧 `PROXY_ENABLE_IP_BACKDOOR=false`**，6080 走域名+鉴权（§4.4） |
| ⚠️ **桌面 pool 规格（CR-4）** | 默认 `SA9.MEDIUM2` 不够跑图形 | 显式配大内存规格 + template_class→桌面 pool 映射（§4.1，T2.1） |
| 环境侧待确认 | 安全组 6080 / 泛域名证书 | T0.2（运维，非代码阻塞） |
| 镜像调试耗时 | 黑屏/分辨率/中文/权限反复调 | P1 最先并行启动；一期固定分辨率 |
| 真机依赖 | 联调需腾讯云环境 | P0–P4 全部可脱离真机开发+编译+单测；P5 才需真机 |
| 冷启动慢 | 建机+装桌面耗时 | 异步 Provisioning 缓解体验；二期镜像预热/pool 预置（T6.4） |

---

## 10. 关键文件索引（执行时直接定位）

**sandbox**
- `sandbox/internal/provider/tencent.go` — CVM provider（建机/取址/AddressType）
- `sandbox/internal/provider/tat_stream.go` — TAT 命令流
- `sandbox/internal/ingressproxy/router.go` — WS 代理 + 域名寻址（**P0 必读**）
- `sandbox/api-gin/handler.go:225-233,273-274` — 路由 `route.Store.Set/Delete`
- `images/build.sh`（`:1807-1829` systemd 范式，`:2000+` 插件开关范式）
- `images/build-image.py` / `images/build-manifest.json`（`img-mmytdhbn` 基座）

**ctl**
- `ctl/main/api/server.go`（`:234` 实例路由，`:226` 子资源范式，`:382+` 路径归一化）
- `ctl/pkg/instance/logic.go`（实例方法范式，`toInstanceResponse` `:1462`）
- `ctl/pkg/transport/instance.go`（DTO）

**frontend**
- `src/lib/agent-routes.ts`（路由/slug/类型）
- `src/pages/marketing/agent-settings-page.tsx`（`:5666-5716` labs 菜单，`:6572-6586` 渲染分发）
- `src/pages/marketing/agent-deepseek-harness-panel.tsx`（面板范例）
- `src/lib/tencent-tssh-proxy-client.ts`（WS 客户端范式）
- `src/pages/marketing/agents-workbench/VelaWorkbenchDesktopHost.tsx`（桌面宿主 UI 参考）
- `src/repositories/http-repositories.ts`（API client + 鉴权）
- `src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`（测试范例）

**可选（agent 桌面能力）**
- `opencraft/apps/local-agent-host/src/dsh-capability-*.{mjs,ts}`
- `opencraft/packages/browser-appserver/src/dynamic-tools.ts`

---

## 11. CR 修订记录（v1 → v2）

本方案经一轮代码级 CR，对 6 项"原先靠推断填写"的假设逐条回仓核实，修补如下：

| 编号 | 问题 | v1 原写法 | v2 修订 | 依据 |
|---|---|---|---|---|
| CR-1 | **实例回收** | "复用现有超时回收（TimeoutSeconds/AutoPause）" | **删除该说法**，新增 §4.5 自建 idle-timeout + PauseSandbox；工作量 +0.5–1d | `handler.go:732-735` 空实现；`worker/main.go:815-817` 不回收 ALLOCATED |
| CR-2 | **TAT 限制** | session 同步返回 wsUrl | 改**异步 Provisioning→Ready**（§4.3）；TAT 只跑短命令 | `tat_stream.go:23-24` 300s/1MiB 硬上限 |
| CR-3 | **IP backdoor** | 未提及 | §4.4 明确 router 保持 false，6080 走域名+鉴权 | router `main.go:40` false / shard `main.go:53` true |
| CR-4 | **pool 规格** | "≥2C4G" 泛泛 | §4.1 显式大内存规格 + template_class 映射；警示默认 `SA9.MEDIUM2` 不够 | `core/types.go:122-152`；`service/pool.go:59` |
| CR-5 | **就绪检查** | 命令内探测 6080 | 拆为 TAT 快速探测 + ctl 外层轮询 | 承接 CR-2 |
| P0 | **多端口路由** | 列为"最大结构风险"，需确认 A/B | ✅ **已解除**：`Rule` 不绑端口，6080 天然可寻址，删方案 B | `target.go:57-75`；`router.go:196-205` |

**已验证成立（无需改）**：WS 经 router→shard 双跳（`router_test.go:492-572`）、instance→sandbox 客户端复用 `SandboxAdapter`、pool 加桌面为纯配置。

**整体评估**：架构方向经代码验证成立；两个真问题（回收、TAT 约束）已定位并给出修补；工作量估算由 3–5 人日调整为 **4–6 人日**。

---

## 12. 部署模式决策：独立 CVM vs 复用实例 sandbox（v2 → v3 重大方向评审）

> 本节回答一个 v2 未展开的核心问题：**桌面到底跑在哪台机器上？** v2 默认「每个桌面会话新建一台独立 CVM」，本节经代码核实后提出改为 **「复用实例主 sandbox + 按需安装图形层」**，并给出证据、对比与改造点。

### 12.1 触发问题

上线后是否「每个用户一台独立 CVM」？—— 是 v2 当前实现的结果，成本与回收模型存在长期隐患（见 12.4）。产品直觉是「桌面应直接开在 vela 实例自己的机器上」，因为 **vela 实例主体本身就是一台 sandbox（CVM）**。

### 12.2 代码事实（决定性证据）

| 事实 | 证据 |
|---|---|
| **vela 实例主体就是一台 sandbox CVM** | `modelinstance.Entity.SandboxId`（`entity.go:39`，DB 列 `sandbox_id`），create 主流程 `createSandboxWithFallback`→`persistCreatedSandboxID`（`async.go:1021-1038`）新建的就是这台主机 |
| **除 desktop 外，全模块 TAT 功能都复用主 sandbox** | `configureOnboard`（`async.go:2374`）、website credential（`async.go:1067`）、ChatClaw（`chatclaw_state.go`）、debug（`logic.go:1914/1970`）、weixin（`weixin_login.go`）、gateway 重配（`async.go:2451`）全部用 `entity.SandboxId`，**无一额外开机** |
| **desktop 是唯一异类** | `desktop.go:226` `CreateSandbox(桌面模板)` 新建独立 CVM；这是整个 `ctl/pkg/instance/` 里除 create 主流程外唯一的 `CreateSandbox` 调用 |
| **desktop 链路当前已能拿到主 sandboxID** | `provisionDesktop(ctx, session, entity)`（`desktop.go:201`）入参已含 `entity`，`entity.SandboxId` 直接可用，无需额外查询 |

**结论**：desktop 走独立 CVM 是全模块的「异类」；复用主 sandbox 才是本代码库的主流范式。改为复用是**向一致性收敛**，非另辟蹊径。

### 12.3 绕过 TAT 300s 上限的现成范式（支撑「按需装」可行）

复用主 sandbox 需在主机上「按需装图形层」，而 apt 装 xfce4 全家桶可能 3–5 分钟，撞 TAT 300s 硬上限（`tat_stream.go:23-24`）。代码里已有三套成熟范式可直接复用：

| 范式 | 现存案例 | 手法 | 适配桌面 |
|---|---|---|---|
| **A 条件幂等安装（拆短命令）** | ChatClaw 装 sqlite3（`chatclaw_state.go:42` `command -v sqlite3 \|\| apt install`）、Hermes 装 harness（`async.go:2490` `command -v acli \|\| curl`） | 检测已装则跳过；安装拆成独立 ≤60s 短命令 | 用于「检测图形层是否已装」 |
| **B 触发即返回 + 外层轮询** | desktop 现有 `systemctl enable --now` + GET 轮询探测（`desktop.go:401`/`probeDesktop:277`，探测仅 20s） | provision 只触发不等就绪，就绪判定交外层 GET | 用于「拉起桌面服务 + 探测」 |
| **C 后台 goroutine + 短命令轮询** | weixin 登录（`weixin_login.go:211` bgCtx goroutine + 3s ticker 查 status） | 长等待挪到 ctl 后台，TAT 只跑 ≤30s 短命令 | **用于「首次安装图形层」这类分钟级长任务** |

**关键结论**：首次装图形层的分钟级耗时，用范式 C（ctl 后台 goroutine 触发安装 + GET 查进度）化解——这不是新发明，weixin 已在生产这么做。

### 12.4 两种模式对比

| 维度 | **A：独立桌面 CVM**（v2 现状） | **B：复用实例 sandbox + 按需装**（v3 建议） |
|---|---|---|
| **成本模型** | 用桌面才建机，idle→pause；**只有用桌面的人产生成本**，但会攒下大量 pause 机器（存储费 + 无 delete 回收，见下） | 桌面「复用现有机」不新增 CVM；**只有真正点桌面的实例付出首次安装耗时**，不新增机器成本 |
| **回收语义** | pause 整台桌面机省费（干净） | **绝不能 pause 主机**（agent 在跑），改为 `systemctl stop` 桌面 unit |
| **镜像策略** | 独立桌面镜像（`build.sh --with-desktop` 预装 4 unit），agent 镜像不变 | agent 镜像**不变**；点桌面时 TAT 按需 apt 装（范式 A+C） |
| **首次体验** | 建机 + 拉起（分钟级） | 首次装包 3–5min（进度可见），**二次进入已装好秒开** |
| **故障隔离** | 桌面崩不影响 agent | 同机，图形层 OOM 有拖垮 agent 风险（需 cgroup 限制缓解） |
| **长期成本黑洞** | ⚠️ **pause≠免费**（盘仍计费）；**只 pause 不 delete**，机器永久累积占盘占配额 | 无额外机器，无此黑洞 |
| **适用场景** | 桌面是「偶尔用的独立重型工具」 | 桌面是「每个 bot 自带、与实例强绑定的能力」 |

### 12.5 决策：采用模式 B（复用主 sandbox + 按需装）

**理由**：
1. **一致性**——收敛回全模块主流范式（复用 `entity.SandboxId`）。
2. **成本**——不新增 CVM，且规避 v2 「pause 机器无限累积」的长期黑洞。
3. **不让全员买单**——按需装使「所有实例镜像变重/规格上调」的代价只落在真正用桌面的实例上（相较「镜像预装」路径）。
4. **可行性有据**——TAT 长任务用范式 C 化解，非空想。

**权衡取舍（接受的代价）**：首次安装慢（范式 C + 进度提示缓解）；同机故障隔离弱（cgroup/内存限制缓解）；主实例规格需能容纳图形层（评估现有规格，不足则按需提示）。

### 12.6 模式 B 的改造点（供执行 agent）

- [x] **TB.1** `provisionDesktop`：删除 `CreateSandbox` 分支，改用 `entity.SandboxId` 作为桌面 sandboxID。**已实现**（复用主 sandbox；主机无 sandbox 时置 Failed；密码首次生成、重试复用幂等）。
- [x] **TB.2** 「按需装图形层」**已实现**：范式 A 检测（`systemctl cat vela-novnc.service`）→ 未装则 `startDesktopInstall` 起后台 goroutine（范式 C），经 TAT `nohup` 丢后台安装脚本立即返回（避开 300s），apt 装 xvfb/xfce4/x11vnc/novnc/中文字体 + 落 4 个 unit，写进度文件；goroutine 轮询进度：DONE→Provisioning、FAIL/超时→Failed。`Installing` 状态带 `install_progress`/`message`。含并发只装一次防护 + 单测。
- [x] **TB.3** provision 命令图形层 unit 运行时注入：**已实现**（TB.2 安装脚本运行时 `tee` 落盘 4 个 systemd unit，与镜像预装等价）；镜像预装仍作为可选预热加速首次。
- [x] **TB.4** idle reaper：**绝不 `PauseSandbox` 主机**，改为 TAT `systemctl stop <4 units>` 只停桌面服务；Paused 再访问由 `provisionDesktop` 幂等重新拉起（不再 `ResumeSandbox`）。**已实现**（含回归测试 `TestReapIdleDesktopsStopsServicesNotHost`）。
- [x] **TB.5** `buildDesktopWSURL`：sandboxID 随复用切换为**主 sandboxID**；ingress 泛域名证书需覆盖 `*-<主 sandboxID>`。**已实现**（代码/注释已切换，证书覆盖为运维环境项）。
- [ ] **TB.6** 状态机新增 `Installing`（含进度百分比）+ 前端进度提示：**随 TB.2 一并补**（当前未装即 Failed，前端已能展示 reason）。
- [ ] **TB.7** 资源隔离：桌面进程 systemd `MemoryMax=`/cgroup 限制，避免图形层 OOM 拖垮 agent。**镜像侧待补**。
- [ ] **TB.8** 镜像层降级为「可选预热」：预装则秒开、未预装则按需装两条路径都跑通。**随 TB.2 一并补**。

> **已交付**：TB.1 + TB.2（按需 apt 装，范式 C）+ TB.3 + TB.4 + TB.5。核心「复用主 sandbox + 按需装图形层 + 停服务式回收」闭环，编译/vet/`-race` 全绿。
> **待补**：TB.6 前端 `Installing` 进度 UI（当前分支无云桌面前端 UI，需单独决策）、TB.7 cgroup 资源隔离（镜像/systemd 侧）、TB.8 镜像预热两条路径联调。真机验证走「按需装」路径即可，无需预装镜像。

### 12.7 对既有 CR 修订的影响

- **CR-C（凭据熵）**：VNC/RFB 认证密码**上限 8 字符，超长会被截断**，所以不能靠加长提熵。原实现用 4 字节 → 8 位 hex，仅 **32 bit**，桌面经公网 noVNC 暴露、密码是唯一凭据，可被脚本化枚举。改为 62 字符集（字母数字）8 位 ≈ **47.6 bit**，在协议上限内把枚举成本提高约 5 万倍；采样用拒绝采样消除取模偏置。真要做到 128 bit 必须换鉴权（短期一次性 token，见 T6.1），不是加长密码能解决的。
- **Provisioning 轮询语义**：`GET` 在 `Provisioning` 态**只走 20s 的 `probeDesktop`**，超过 `desktopProvisionRetryAfter`（60s）仍未就绪才允许重发一次 provision。原因：provision 是 120s 超时的重命令（storepasswd + 4 个 unit + 探测），前端秒级轮询会反复下发；状态进入 Provisioning 时打时间戳，探测失败续留不刷新计时，避免重试窗口被无限续期。
- **CR-1（回收）**：模式 B 下「回收」= 停桌面服务而非 pause 整机（**已按此实现**）。
- **CR-4（pool 规格）**：模式 B 不再需要独立桌面 pool（`DESKTOP_SANDBOX_TEMPLATE_ID` 已废弃移除）；改为评估「实例主规格是否够跑图形」。
- **V6/V8/V9（验证清单）**：无独立桌面机后，V8「CVM 释放」并入实例销毁；V9「idle pause」改为「idle 停服务」。

---

## 附：为什么不用公网 IP（背景，供 CR 理解）

- ctl `instances` 表无 IP 字段；现网 `ListInstances`/sandbox 沙盒 API 均不返回、不依赖 public_ip。
- 连接走 `SandboxID → ingressproxy 域名 → 内网 Address`，`AddressType` 默认 `private`。
- 因此云桌面沿用同一套无公网 IP 架构，仅新增一个对外端口（6080）纳入既有代理寻址。
