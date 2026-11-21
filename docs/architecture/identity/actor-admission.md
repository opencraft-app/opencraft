# Human / Session Actor 接入

核心 `identity-core` 区分外部已验证 Principal 与持久 Actor；`access-control/actors` 拥有
本地身份库。Headless 在既有私有 data directory 下创建 `actors.sqlite`，启动、关闭和
健康检查都纳入原生命周期。文件模式 0600，目录 0700；使用受管迁移和 schema 校验，
未知历史拒绝启动，不移走或重置身份库。备份须保留数据库和一致的 WAL 状态，不复制
真实身份库来初始化一个新身份域。

已准入的 企业身份 自然人通过稳定 StaffId 绑定主体，显示名可更新。原先没有启用实例成员
策略的服务不会因升级自动启用门禁；也不会自动指定管理员或改变模型设置的旧存储键。
自然人正常 HTTP/WS 访问会解析持久身份，Actor API 返回该身份。已识别但被禁用的自然人不能降级为匿名继续访问；已建立的具名 WebSocket 在核心复核失败后关闭（500ms 轮询）。未识别请求仍遵循原共享/匿名策略，不构成数据隔离。

## HTTP contract

以下路由由 Headless 核心拥有，受管 Web 入口转发；响应均为 private/no-store JSON。
版本化网站 worker 同样消费已配置的回环 Headless 目标，转发核心拥有的 HTTP 路由。
旧稳定启动器不认识新增路由时，其通用 HTTP 转发仍能到达新版 worker，再由核心验证
身份与权限；无需为新增 HTTP 接口重启稳定入口。worker 的自身健康探针仍独立于执行
服务，版本和更新管理权也不转交给业务核心。此兼容不新增 WebSocket 或中继接入协议。

| 方法和路径 | 请求 / 结果 | 授权 |
|---|---|---|
| GET `/__opencraft_actors/me` | `{actor, expiresAt}` | 已准入自然人证明或 Session bearer |
| GET `/__opencraft_actors/actors` | `{actors}` | 本库管理 |
| GET `/__opencraft_actors/audit` | `{events}`，不包含凭据明文/摘要 | 本库管理 |
| POST `/__opencraft_actors/sessions` | `{displayName}` → `{actor}` | 本库管理 |
| POST `/__opencraft_actors/credentials` | `{actorId, expiresAt}` → `{credentialId, token, expiresAt}` | 本库管理，仅 Session |
| POST `/__opencraft_actors/credentials/revoke` | `{credentialId}` | 本库管理 |
| POST `/__opencraft_actors/grants` | `{actorId, resource, action, enabled}` | 本库管理，仅本库权威资源 |
| POST `/__opencraft_actors/state` | `{actorId, enabled}` | 本库管理，不允许远端自禁用 |

所有 POST 需 application/json，最多 16 KiB，不接受额外字段。自然人还必须提供匹配
Host 或已批准中继 Origin；Session 只能用 Authorization bearer，凭据不接受查询参数。
管理权来自既有实例 admin，或核心显式授予本身份库资源
`actor-registry://<authority>` 的 `actors.manage`，两种 Actor 都可持有这项显式授权。
创建 Session 不自动授予创建者对它的控制权，也不授予 Session 创建者的权限。
本库管理是强能力，应按需授予；尚无面向最终用户的管理 UI。

Session 令牌明文仅在签发响应出现一次，应由调用方安全保存，不写进日志、模型提示或
浏览器 URL。有效期不超过 30 日。禁用再启用主体会提升代次，旧凭据继续失效；重新
签发凭据保留主体 ID。UI 登录或 HTTP 连接的结束不删除 Actor 或停止其未来执行载体。

## 当前接通范围

本次新增身份、凭据和精确授权基础，不开启执行控制。新 Session bearer 对旧 Workbench
HTTP/WS 接口返回 403；未携带可信身份的共享实例仍按旧匿名策略，不因此具备资源隔离。
当前中继登录协议仍面向已配置的人类身份来源，不新增 Session 的跨中继认证协议。
Actor 资源上的 send/control 授权记录本身不会执行动作，目标执行 API 和资源所有者的
实际授权检查需下一切片接通，不能将授权记录当作已实现的 Session 通信能力。

测试入口：`npm run test:actors`、`test:relay`、`test:headless-server`、`test:enterprise-identity`、
workspace 类型检查与 `check:boundaries`。真实 企业身份 网关、Bot 引擎和跨 Hub 调用须另验，
合成签名测试不等于真实自然人登录验收。
