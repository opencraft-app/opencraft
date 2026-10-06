---
id: task-devcloud-oidc-cors-20261006
type: task
scope: First-party DevCloud OIDC callbacks and CORS.
triggers: ["DevCloud OIDC", "DevCloud CORS"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - user/auth/internal/oidc/registry.go
  - service-gateway/internal/gateway/server.go
status: active
reviewed_at: 2026-10-06
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: false
---

# DevCloud first-party OIDC and CORS

## goal
允许 OpenCraft Web 的 HTTPS DevCloud 子域登录并调用 API。

## non_goals
- 不新增 client ID，不修改 readiness issuer，不直接发布生产。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前会话用户要求：“我希望允许 *.devcloud.woa.com”“CORS 也要放行”。

## interface_refs / data_structure_refs
- `user/auth/internal/oidc/registry.go`：显式注册的第一方例外；code 绑定具体 URI。
- `user/auth/api/native-login.openapi.yaml`：session exchange 与 PKCE。
- `service-gateway/internal/gateway/server.go`：反射具体 Origin，不放宽通用 return_to。

## history_context
- current_design_refs: `docs/engineering/domains/identity-access.md`
- relevant_evolution: 基于 master `5b9f70ea2dfcdd0fce6aef1165abb5634dafeddd`；原 Web 客户端仅两个精确回调。
- superseded_refs: 无。

## acceptance
- 国内国际配置一致；正常子域和多级子域通过，伪后缀、非 HTTPS、端口、非法路径被拒绝。
- 授权码跨子域兑换、错误 PKCE、重放失败；CORS 预检及错误响应可读取。

## affected_paths
- `user/auth/`, `service-gateway/`, `argocd/services/lightclaw-auth/`, `argocd/services/service-gateway/`

## required_context
- identity-access, agent-gateway-runtime, service-gateway。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | 隔离工作区和发布授权 |
| `user/auth/AGENTS.md` | 认证约束 | 认证测试与 Argo 发布 |
| `service-gateway/AGENTS.md` | 网关约束 | CORS 和独立发布 |
| `docs/context/domains/identity-access.md` | 路由 must_read | 第一方认证边界 |
| `docs/context/domains/agent-gateway-runtime.md` | 路由 must_read | 网关责任 |
| `docs/context/project/services/service-gateway.md` | 路由 must_read | CORS 实现入口 |
| `docs/context/project/adjacency/argocd-ci-secrets.md` | 部署邻居 | 检查两地注册与构建管线 |
| `docs/engineering/domains/identity-access.md` | 正式设计 | 同步通配例外契约 |

## evidence
- 修改前公开 authorize 探测：join 子域 400 unauthorized_client，chat.lightvela.com 302。
- 修改前公开 CORS OPTIONS：join 无 ACAO，chat.lightvela.com 有具体 ACAO。

## risks
- 覆盖整个子域族意味着信任所有子域；必须由第一方控制其分配，防止子域接管。
- 回滚删除两地显式注册与 CORS 配置；源码不会自动改变线上。

## validation
- gofmt，两个服务 go test ./...、go vet ./...，文档/context 门禁。
- 两个服务全量测试与 go vet 已通过；documentation 检查通过。
- Context 全库测试存在历史 schema/字段失败，审计测试 33 项通过；未宣称全库门禁全绿。

## decisions
- 用户明确选择子域族，不改 client ID；仅第一方 Web client 可注册唯一固定模式。

## scan_scope
- Auth registry/session exchange，网关 CORS，两地生产配置。

## scan_output
- 无敏感数据产物。

## handoff
- 实现与服务验证完成；未提交、推送、发布。待用户授权交付。

## checkpoint
- stage: 本地实现完成，等待提交/发布授权。
- verified: 两服务全量测试与 vet、文档检查通过；两地配置与具体回调绑定回归通过。
- unverified: 生产构建、Argo 收敛、真实浏览器登录未执行。
- discard: 不通过更换客户端 ID 或任意通配回调解决。
- restore: 隔离分支 fix/opencraft-devcloud-oidc-20261006，基线见 history_context。
- next_action: 获准后提交 MR，通过两服务发布路径配对交付镜像与配置。
