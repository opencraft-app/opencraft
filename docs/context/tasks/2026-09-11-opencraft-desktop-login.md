---
id: opencraft-desktop-login-2026-09-11
type: task
scope: OpenCraft 桌面通过系统浏览器进行国内国际原生 OIDC 登录。
triggers: ["desktop login", "system browser authentication", "OpenCraft native callback"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-electron/src/lightvela-login.ts
  - opencraft/docs/platform-architecture.md
status: retired
reviewed_at: 2026-09-11
review_due: 2026-12-11
revision: 1.0.0
precedence: task
derived: false
---

## goal
按用户选择，让 macOS OpenCraft 在系统浏览器登录后接收回调并恢复账户状态。

## non_goals
- 不修改后端 OIDC client allowlist，不发布生产，不引入内嵌登录浏览器。

## requirement_ids / requirement_refs / requirement_excerpt
- LOGIN-01：国内/国际选择打开系统浏览器的统一登录页。
- LOGIN-02：回调返回发起登录的桌面进程；取消、失败和过期可重试。
- LOGIN-03：系统加密保存会话，重启和 loopback 端口变化不丢失账户。

## interface_refs / data_structure_refs
- `opencraft-native-v1` / `opencraft://auth/lightvela` / `/auth/session/exchange`。
- Electron 主进程持有 PKCE，preload 只提供 signIn/cancel/readSession/clearSession。
- 不把会话放进浏览器 URL、日志、回调套接字或 Chromium localStorage；renderer 仅内存持有。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md` 和 `docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution：前一版桌面复用了 location.assign，被 will-navigate 拦截；loopback Web callback 在两区域均为 400，注册的原生回调均为 200。
- superseded_refs：桌面使用 Web 登录事务与 origin-local 持久化。

## acceptance
- PKCE、精确回调、重复/错误 state、取消、过期、失败重试、跨 profile 路由和加密存储测试通过。
- packaged macOS Preview 打开系统浏览器，返回应用并更新会话；真实账号验证若需用户操作，明确边界。

## affected_paths
- `opencraft/apps/workbench-electron/`
- `opencraft/plugins/lightvela-hermes/src/account/`
- `opencraft/plugins/lightvela-hermes/src/settings/lightvela-login-options.tsx`
- `opencraft/tests/`

## required_context
- `docs/context/domains/identity-access.md`、`opencraft/AGENTS.md`、`opencraft/docs/build-matrix.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/identity-access.md` | router must_read | 后端授权边界 |
| `opencraft/AGENTS.md` | workspace 边界 | 独立 npm gate 与 preview |
| `opencraft/docs/platform-architecture.md` | 平台所有权 | 原生认证由主进程实现 |
| `opencraft/docs/build-matrix.md` | 预览产物 | 独立产品和 profile |
| `user/auth/AGENTS.md` | 验证注册 contract | 不修改或发布后端 |

## evidence
- 两区域只读 authorize/context 对比：当前 loopback Web redirect 400、注册的 Web/native redirect 200。
- 首轮 native broker 与 Web auth 聚焦测试 19 项通过。
- 真实 Safari 登录已完成原生回调和加密存储；随后发现 Web CORS 不允许 loopback Origin，补充主进程账户 HTTP port，限定 region authority 与既有账户/实例操作。
- `npm run gate` 退出 0，882 项测试及 Web/Expo Web/iOS bundle 通过；最后的 callback-only 启动调整另经 Electron 类型检查。
- 真实国际站链路：系统 Safari 授权确认 → 系统允许打开 OpenCraft Preview → 原发起 profile 收到会话；localStorage 无明文凭据、系统加密会话存在。
- 新包签名和 ZIP 完整性通过。新构建第一次重新读取 Keychain 时触发系统授权，Main 栈停在 Security/SecItemCopyMatching；Computer Use 明确禁止访问 SecurityAgent，已请求用户在系统提示中自行授权。
- 使用当前 Electron 的异步 safeStorage API，避免系统授权等待阻塞主线程；read/save 与 clear 用 generation 和 AbortSignal 隔离，旧加密结果不能在退出后恢复会话。
- 最终异步版本完整 `npm run gate` 退出 0，883 项测试通过，macOS preview 构建完成。重启实际确认 Main 可响应，readSession 仍等待用户完成系统 Keychain 授权。
- 用户完成 macOS 钥匙串授权后，最终 packaged 实测：加密会话恢复为国际站登录态；账户资料、订阅、Pass、实例目录均为 HTTP 200；账户入口不再显示 Sign in，页面无 alert，Main 正常响应，Chromium localStorage 不含明文会话。重启后的回环服务端口已变化，仍成功恢复同一 profile 的会话。

## risks
- 回调可能被另一个 profile 接收：按随机 state 的摘要寻址本地受限套接字，代码与 verifier 不跨域暴露。
- 浏览器页比桌面事务更长寿：取消/过期后旧回调不能再交换会话。

## validation
- 受影响 workspace 类型检查、desktop-login tests、完整 npm gate。
- Preview 签名、ZIP、系统浏览器/原生回调验收。

## decisions
- 登录时注册 opencraft 系统协议；只允许固定区域 authority 与固定 native callback。
- Pending verifier 只在主进程内存；退出应用会取消尚未完成的登录事务，已完成登录的会话从系统加密存储恢复。
- 生产与预览分 profile 存储；跨进程转交只传单次回调，不传会话。

## scan_scope
- Electron main/preload，LightVela account，UserAuth OIDC registry 和既有 Expo native transaction。

## scan_output
- router 命中 identity-access；源码与已部署只读 contract 一致。

## handoff
- 系统浏览器真实国际站登录、原生回调、资料加载与重启恢复均已验证，预览保持打开。国内站共用实现的区域参数与端点 contract 已验证，未执行另一账号的真实登录。未提交或发布。

## stage
最终验收完成。

## verified
- Safari 实际登录、原生回调、会话加密保存与重启恢复；四个账户/目录接口均为 HTTP 200，UI 已登录且无错误；完整 gate、签名与 ZIP。

## unverified
- 无阻塞项；国内站未使用真实账号重复登录，共用实现已有参数与 contract 验证。

## discard
- Browser renderer 直连 API 的 CORS 失败已由窄原生端口替代，不作为登录交换失败。

## restore
- 当前新包使用此前同一临时用户 profile；调试端口 19555。只输出状态、HTTP code 和凭据是否存在，不输出凭据或账户隐私内容。

## next_action
- 用户继续使用预览；提交或发布按后续指示执行。
