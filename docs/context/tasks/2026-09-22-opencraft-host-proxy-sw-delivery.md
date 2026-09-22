# OpenCraft Host Proxy Service Worker 生产交付

## goal
修复国际站 Embedded Chat 加载后 Host Proxy Service Worker 404，使远程 Host 的 loopback Browser 代理可用。

## non_goals
- 不扩大 Service Worker 到整个 LightVela 站点。
- 不发布国内站，不执行生产推理。

## requirement_refs / requirement_excerpt
- 用户线上控制台：`/opencraft-host-proxy-sw.js` 注册返回 404，并确认功能不工作。

## interface_refs / data_structure_refs
- `WebHostProxyBroker.start()` 注册入口。
- `HOST_PROXY_PATH_PREFIX` 与 Service Worker scope。
- embedded Vite artifact、frontend staging、EdgeOne Build Output 上传树。

## acceptance
- Embedded 构建包含 namespaced SW，staging 和实际 `.edgeone/assets` 均保留。
- 注册 URL 返回 200/no-cache，scope 仅覆盖 `/__opencraft/host-proxy/`。
- 线上注册成功，不再出现 SW 404；Host proxy broker ready。

## affected_paths
- OpenCraft Host Proxy URL/Broker、Vite 构建、frontend artifact/EdgeOne 投影及测试。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| `/Users/skipzhang/.codex/skills/trace/SKILL.md` | 执行路径追踪 | 确认注册、产物、上传三段缺口 |
| `opencraft/AGENTS.md` | 服务规则 | 状态与交付边界 |
| `docs/engineering/domains/release-gitops.md` | 发布真源 | 生产证据分层 |

## decisions
- 将 SW 放在 `/__opencraft/opencraft-host-proxy-sw.js`，scope 收窄为 `/__opencraft/host-proxy/`；不使用站点根 scope。
- embedded 构建显式 emit SW；artifact 缺 SW 时失败；EdgeOne 对稳定 SW 路径设置 no-cache。

## validation
- OpenCraft Web typecheck 通过；Host Proxy/Web release 16/16 通过。
- frontend release/artifact/EdgeOne 聚焦测试 69/69，pnpm check 通过（0 新增类型诊断）。
- CI frontend artifact contract 测试通过。
- embedded release 构建实际生成 13,569-byte `opencraft-host-proxy-sw.js`。
- 完整国际站静态构建完成，EdgeOne 上传树包含 namespaced SW；配置为 no-cache，路由总数 18。
- 以实际 `.edgeone/assets` 启动本地 HTTP server；Chromium 成功注册 SW，active=true，scope 精确为 `/__opencraft/host-proxy/`。

## handoff
- 待提交、MR、国际站发布与线上注册验收。
