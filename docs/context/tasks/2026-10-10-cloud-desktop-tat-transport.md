# 云电脑：TAT 隧道、输入授权网关与旧版连接兼容

日期：2026-10-10
分支：`feat/cloud-desktop-tat-transport`（基于最新 master）

## 背景

1. 桌面画面原先经 ingressproxy 的泛域名 `6080-<sandboxID>.<DESKTOP_INGRESS_DOMAIN>`
   传输。国际站计划下线 ingressproxy，泛域名不可达，桌面链路必须换通道。
2. 存量安全问题：旧 `desktop/session` 把 8 位 VNC 密码下发到浏览器。密码是公网
   端点上唯一的凭据，一旦端点暴露即等于桌面暴露。`desktop/resource` + Broker 的
   一次性票据模型更安全。

两个问题一起收敛：媒体走 TAT 隧道（无泛域名），授权走 `desktop/resource` +
一次性票据（无密码）。

## 方案

- **传输**：浏览器 → 已鉴权的 TAT session → 沙箱内回环端口。不再有任何公网主机名。
  沙箱内的目标由后端下发为 `{ mode, ip, port, path }`，其中 ip 恒为回环地址。
  - `rfb`：可写连接进入 `127.0.0.1:5904` 输入网关（`path=/desktop/input` 为协议提示），
    先发送一行 `desktop/attach` JSON，再执行 RFB 握手。网关校验并消费连接票据，
    绑定 grant 后转发至回环 `5903` x11vnc。只读连接直接访问 `5901`，不发送该前导帧。
    已有控制者时，新观看者只读，不自动抢占。输入准备/epoch 激活失败必须先关闭准备，
    不把未知旧授权状态伪装为只读成功；grant 失败且确认条件撤销后才可降为只读。
  - `ws`：隧道内是 WebSocket 会话（broker 的 `/desktop/connect`），由
    `src/lib/rfc6455-over-stream.ts` 在字节流上完成 RFC6455 握手与分帧。
- **授权**：`POST desktop/resource` 准备（无凭据）→ 轮询到 `prepared` →
  `POST desktop/viewer` 签发租约（`attachmentId` + 一次性 `ticket` + 隧道端点 +
  `access`）→ `POST desktop/viewer/{id}/claim` 兑换票据 → 兑换成功才允许打开隧道。
  租约绑定准备代次、5 分钟硬到期、30 秒未兑换即回收、单次使用、可显式撤权；
  服务端只保存 `SHA-256(ticket)`，响应里不含密码、不含 URL、不含 sandbox id。

### 键鼠（可写）是怎么来的

旧链路的可写入口只有 `127.0.0.1:5900`（`vela-x11vnc`），它靠 8 位 RFB 密码保护，
且被 websockify(6080) + ingressproxy 暴露到公网：**不能**摘掉它的密码，否则等于把
可写桌面公开。而 `5901` observer 的 `-viewonly` 在 x11vnc 进程内生效，任何客户端
或 ctl 参数都改不掉，就地放开也被明令禁止。

所以新增了第三个端点 `vela-desktop-input`（`5903`），安全模型与 observer 完全一致：

| | 5900（保留不动） | 5901 observer | 5903 新增 |
|---|---|---|---|
| 键鼠 | 可写 | 只读 | **可写** |
| 认证 | RFB 密码 | 无（回环 + TAT） | 无（回环 + TAT） |
| 监听 | 所有网卡 | `-localhost` | `-localhost` |
| 并发 | 共享 | 共享 | **`-nevershared` 单主** |

新连接不下发 VNC 密码；旧 `desktop/session` 的兼容字段另见发布章节。
`5903` 的 `-nevershared -dontdisconnect` 限制同一 x11vnc 进程的连接，不负责跨端点
撤权。可写客户端必须经 `5904` 网关；准备命令同时安装 x11vnc unit、gateway unit、
代理源码，全部准备结束后才发布 `prepared`。既有 5900/5901 不改动。

每实例只保留一个 write 预留/控制者；新 mint 不先撤旧，其他观看者分流只读。
claim 与 release 在实例操作锁下串行；grant 失败须确认条件撤销成功才降只读，
结果未知则保留占位到确认清理或到期，不恢复旧票据、不释放未知授权的槽位。
远端 grant/revoke 共享稳定文件锁，撤销按 attachment 匹配，并保存至到期的撤销记录，
阻断迟到 grant；记录跨 gateway 重启保留。连接票据消费只允许一次，grant 变化、
撤销或到期会释放按键/鼠标并关闭该连接，不能让旧连接继承新持有者授权。

输入授权入口允许最多 30 秒时钟偏差，但本地单调时钟将一次 grant 的存活限制在
300 秒内；同票据重发不刷新该期限。revoke 不沿用 grant 的未来时间上限，避免补偿
撤权也被时钟偏差拒绝。撤销记录保留至原授权绝对期限，阻断迟到命令。

换代先失效旧租约，保留可能已下发的授权记录，条件撤销确认后才发布新代次；
无法确认时不假装释放成功。同目标可按当前已验证权限清理旧 attachment，目标已换且
不再可授权时不跟随旧目标执行，而是保持失败关闭直到安全期限耗尽。
沙箱内 epoch 原子绑定 generation/incarnation，grant 必须匹配；切 epoch 使旧连接
立即失效，迟到的旧代授权无法复活。激活采用 compare-and-set，旧准备命令不能覆盖新代。

## 改动

后端（ctl）：

- `pkg/transport/instance.go`：`DesktopViewerResponse` / `DesktopViewerClaimRequest`
  / `DesktopViewerClaimResponse` / `DesktopViewerTunnel`。
- `pkg/instance/desktop_input.go`：可写回环端点 `vela-desktop-input`（5903）、
  `opencraft-desktop-input-gateway`（5904）的 unit、准备命令及条件授权命令。
- `pkg/instance/desktop_input_proxy.py`：握手、单次连接绑定、输入过滤、条件撤权与按键释放。
- `pkg/instance/desktop_viewer.go`：租约签发、兑换、释放、`access` 判定（write/read）、
  限额（可写每实例 1、只读每实例 4、全局 128）、代次票据失效、实例锁内绑定复验、
  失败清理后降级；`hasDesktopViewer` 供 idle reaper 使用。不支持自动夺取现有控制权。
- `pkg/instance/desktop.go`：`reapIdleDesktops` 跳过仍有存活租约的实例 ——
  `desktop/resource` 的准备态只读、没有心跳接口，租约就是活跃信号。
- `main/api/server.go`：`POST|DELETE /v1/instances/{id}/desktop/viewer[/{attachmentId}]`、
  `POST /v1/instances/{id}/desktop/viewer/{attachmentId}/claim`，含指标路径归一化。

前端：

- `lib/rfc6455-over-stream.ts`、`lib/desktop-tat-transport.ts`：TAT 隧道通道，
  产出 noVNC `Websock.attach` 所需的 raw channel 契约。
- `repositories/*`：`ensureDesktopResource` / `getDesktopResource` /
  `createDesktopViewer` / `claimDesktopViewer` / `releaseDesktopViewer`。claim 传入对象，
  由共用请求层统一 JSON 编码一次；真实 fetch 请求体回归覆盖该契约。
- 桌面 TAT 使用显式 callback-only 消费模式，不再将已处理媒体重复放入未读取的
  ReadableStream；终端等调用方默认模式不变。建连拒绝、WS 握手异常/超时均完整清理
  client/proxy/RFC 资源，保留原错误分类，协议与安全错误不自动重试。
- `pages/marketing/agent-cloud-desktop-panel.tsx`：改用新链路，`new RFB(...)` 不再
  传 `credentials.password`。
- `desktop-tat-transport.ts` 缓存 noVNC 挂上 `onmessage` 之前到达的字节，挂上后
  按序异步补发。面板先开隧道、再异步加载 noVNC，RFB 服务端的 ProtocolVersion
  首包可能早于 noVNC 就绪；丢弃会让握手永久卡在「连接中」。
- 首连与掉线采用相同的有限退避，只有实际 RFB `connect` 才重置计数；安全/语义错误
  不自动重试。资源准备有总时限，RFB 握手有独立时限；旧连接事件不清理新连接定时器。

## 发布兼容（过渡期）

`desktop/session` 的 Ready 响应**过渡期保留** `ws_url/password`，与前后端发布
顺序解耦：

- 地域配置了 `DESKTOP_INGRESS_DOMAIN`（当前 shprod/sgprod/sandbox-bj-7）时回填，
  旧前端在 CTL 先发布后仍可直连；
- 未配置时静默省略，**不让 Ready 轮询失败**（这是移除 ingressproxy 依赖的关键）；
- 新前端不读取这两个字段。新前端全量后，删除各地域 `DESKTOP_INGRESS_DOMAIN`
  即停止下发密码，随后删除 `buildLegacyDesktopWSURL` 及字段定义。

## 网关发布契约

北京三个环境、shprod、sgprod 的精确白名单包含五条新规则：GET/POST
`desktop/resource`、POST `desktop/viewer`、DELETE `desktop/viewer/{attachment_id}`、
POST `desktop/viewer/{attachment_id}/claim`。JP/KR 保留原实例前缀策略。

网关测试须与本轮开放范围一致，不再沿用「尚未发布、应返回 404」的旧断言。
保留精确 method/path 集合校验，并通过真实部署路由验证：所有接口未登录返回 401、
未实名 POST 返回 403、GET 与 DELETE 延续已有实名豁免、伪造身份被覆盖、
CTL 返回的拒绝状态原样透传；白名单环境的错误方法和相邻路径继续返回 404。
本次不改变鉴权实现、CI fallback 策略，也不接入 OpenCraft。

## 多副本与发布顺序

`desktopSessions/desktopViewers` 仍为进程内状态。本轮不修改普通 `ctl-api` HPA，
新增 `ctl-desktop` 专用单副本、`Recreate` 部署和独立 Service。鉴权及白名单校验后，
七个 session/resource/viewer 方法路径才路由到 `desktop_upstream`；其他实例API、
TAT、调试执行、订单和聊天保持原上游，专用桌面故障不回退到无状态副本。

六个有完整部署源的环境（北京三环境、KR、shprod、sgprod）显式启用 `CTL_API_ROLE`：
普通API拒绝桌面入口且不启动桌面回收器；桌面实例只接桌面和健康检查，不重复启动
普通业务定时任务及推荐 relay。PodSpec 在最终 overlay 继承普通API镜像、Secret、环境、
卷与调度参数，标签/Service/HPA 隔离；监控仍纳入既有 metrics selector。

JP 未在本仓库维护完整 CTL 发布根，保留旧上游，不宣称已解决其多副本问题。shared base
普通API角色默认为空兼容，避免仅升级公共base就关闭未接入环境的桌面入口。外部生成的
playground 配置也需核对角色、最终PodSpec复制与网关分流三者一致后才启用。

发布需安排云电脑维护窗口：先创建并检查专用桌面实例、部署新网关能力，协调完成普通API
角色升级和桌面路由切换，再发布前端。不能让旧普通API桌面回收器与新状态实例长期并存。
`Recreate` 更新会短暂中断桌面，进程状态丢失后重新准备并 fencing 沙箱 epoch；本轮没有
实现持久化状态或HA，也不允许将专用实例扩为多副本。旧前端字段兼容不消除此部署顺序要求。

## 验证

- 完整 service-gateway 门禁通过（105 项 Python 发布契约及 Go 全量测试），网关 `go vet`、桌面路由竞态检查通过。
- 六环境实际 Kustomize 渲染隔离检查通过：单例Recreate、最终PodSpec继承、角色/Service/HPA隔离。
  本地测试以仅名称/类型的fixture代替加密资源生成器，不解密生产凭据；正式KSOPS渲染仍需在发布环境确认。
- CTL Desktop 测试、`go vet`、Viewer/Resource/Input 竞态检查通过（含代次撤权、
  重放、未知 grant 清理、并发 claim、限额及安装命令语法与长度校验）。
- 前端 HTTP/fake repository、TAT、RFC6455、传输与面板联合 182 项通过；TypeScript 检查通过。
- 用户 Linux 实例上内存加载本分支代理、真实observer身份实现与 Python 测试：57 项通过、无跳过。使用自动分配的
  独立 Xvfb 显示与临时回环 x11vnc，实际验证 framebuffer、键鼠输入、撤权后释放及断连；
  测试进程和目录自动清理，未修改原有桌面服务。这不是正式 API→TAT→noVNC 验收。
- `npx vitest run src/lib/__tests__/desktop-tat-transport.test.ts`
  （rfb/ws 两模式、首帧票据、握手拒绝、隧道早断、早到首包缓存与顺序）。
- `npx vitest run src/pages/marketing/__tests__/agent-cloud-desktop-panel-*.test.tsx`
  （准备进度、租约兑换、无密码、卸载撤权）。

## 如何验证目标机器（物理 incarnation）

`desktop/resource` 的 `generation_id` 只是 CTL 进程内的编排代次，**不是物理身份**
（`sandbox/internal/desktop/broker.go`：「Preparation generation is never accepted as
physical incarnation」）。因此新增了签发前的物理验证：

- `ctl/pkg/instance/desktop_target_verify.py`（embed 下发）：在沙箱内以 root 运行，
  读仅 root 可读的 `/run/opencraft-desktop-observer/key`，向回环上的
  `opencraft-desktop-observer-proxy`(5902) 发随机 nonce，用 HMAC-SHA256 校验
  `opencraft-desktop-observer/v1\0nonce\0incarnation`，**只输出 incarnation**。
  key 与 MAC 都不出沙箱。
- incarnation = `sha256(boot_id + observer 进程启动 tick + systemd invocation +
  xvfb 进程启动 tick + invocation)`，来自 `desktop_observer_proxy.py`。
- 租约钉死在这个 incarnation 上；准备激活后、mint 和 claim 下发grant前分别核验。
  5904 attach 和握手边界复用可信root只读observer Runtime，连接期间周期复核真实身份，
  不只比较epoch里的旧字符串。验证失败/incarnation变化/丢失readOnly保证均拒绝。
  Runtime仅连接时查询systemd，周期检查使用/proc及X socket；同步身份探测最多等待1秒，
  不能承诺撤权严格在200毫秒内完成。要求毫秒级撤权需另做异步探测及执行预算设计。
- 前端逐字段校验（`incarnation` 必须 64 位 hex、`expiresAt` 必须在未来且 ≤ 10 分钟），
  任一不符就不开隧道。

## 关于 sandbox/internal/desktop broker：本次不挂载（决策记录）

**决策**：不挂载。当前场景是「用户个人在浏览器里使用自己的桌面」，单人单机。

**为什么 broker 给不了键鼠**：broker 的 `OpenVerified` 走
`OpenVerifiedDesktopObserver`（5902 核验代理），该路径**强制只读**（`!proof.ReadOnly`
直接失败）；可写端点 5903 在沙箱内，sandbox 服务侧**没有任何能仲裁它输入的执行器**。
挂上后 `VerifiedStream.Control` 只能是 `nil`，等于把可写能力换成只读。

**本方案覆盖的职责（不等价于完整 broker）**：

| broker 职责 | 本方案由谁承担 |
|---|---|
| 客户端鉴权 | 产品登录 + 实例级 TAT session |
| 加密媒体中继 | TAT 隧道 |
| 媒体路径上的仲裁 | 浏览器 → TAT → 沙箱回环；broker 不在这条路径上 |

**已知并接受的代价**：

1. **单写、多只读**：一个 write 槽位，5901 提供最多 4 个只读租约，不自动抢控制权。
2. **主动撤权依赖 TAT 下发**：下发失败时返回错误并保留未知授权占位；5904 连接的
   grant 到期由沙箱内网关检查并断开，不只依赖前端定时器。普通断连时释放按键。
3. **集中管控弱**：无统一观测与紧急熔断入口，状态分散在各沙箱。
4. **不是强制隔离边界**：浏览器仍获得实例级 TCP TAT 能力，底层回环 5903 仍可由
   拥有该能力的客户端直接访问。5904 上的绑定/撤权不能被宣传为所有路径不可绕过，
   如需不可信客户端或多主体隔离，必须收紧 TAT 端点或引入服务端 broker。
5. **OpenCraft 暂不接入**：保留实例级接口，未来适配仍需核对其授权契约，不视作已验收。

**重新评估的触发条件**（出现任一即应上 broker 或沙箱内可写输入执行器）：

- 需要多人同时观看（协作 / 演示 / 客服接管）
- 需要毫秒级撤权 + 集中熔断（合规或安全事件响应）
- 桌面观看成为高频功能，需要独立扩展 / SLO / 观测
- 要统一接入 opencraft 生态

## 未完成 / 后续

- **端到端验收**：隔离 Linux 真机已验证网关 RFB 画面、输入和撤权；尚需发布后验证
  实际 API → TAT → noVNC 完整链路及国际站体验，不能以 mock 或隔离测试替代。
- **撤权断连**：5904 当前在撤销/到期时断开并释放按键，面板重建；不提供原连接无缝只读。
  5901 只读媒体仍不受网关输入 grant 强制约束，不能把租约释放称为全媒体强制撤权。
- **浏览器崩溃/服务崩溃**：网关正常存活时不依赖浏览器定时器检查输入期限；网关进程
  非正常终止仍不能保证 finally 按键释放，需结合 x11vnc 生命周期防护。
- **租约无续期协议**：重连需重新签发租约，旧写授权未知时可能先获得只读连接。
- **任意 TAT 能力边界**：要服务不可信或多主体场景，先约束底层端点访问；本轮不承诺
  绕过 5904 也能执行输入撤权，不接 OpenCraft。
