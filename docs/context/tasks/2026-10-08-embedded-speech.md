## goal
普通 frontend 内嵌 OpenCraft 使用登录态，经 Service Gateway 以用户已有默认 VelaGW Key 调用标准语音转写接口。

## non_goals
- 不引入 Redis、COS 或音频落盘；本轮不启用新山。
- 不重置实例配置，不修改普通 LLM 请求及 NewAPI 转换器。

## requirement_excerpt
用户确认浏览器登录态 → Service Gateway → 用户 Key → VelaGW → NewAPI，并选择进程内缓存。

## interface_refs / data_structure_refs
- `opencraft/plugins/voice-input/src/cloud-speech.ts`: 音频会话拥有录音与取消，不拥有草稿。
- `velagw/internal/gateway/admin_command.go`: default purpose 是现有实例 Key 的归属。
- `service-gateway/internal/gateway/server.go`: 登录态 introspection 与 CORS/日志规则。

## history_context
- 当前设计：`opencraft/docs/platform-architecture.md`、`opencraft/docs/chat-ui-architecture.md`、`service-gateway/docs/README.md`。
- 本地预览语音服务不是生产账户 Key 的真源。

## acceptance
- 已登录用户标准 multipart 转写；未登录/Key 未就绪拒绝；凭据不返回浏览器。
- 缓存有容量/TTL/并发合并，取消、账号切换与晚到结果安全。
- 音频只流式转发；未配置服务时不可用，不回落到预览或系统识别。

## affected_paths
- `opencraft/plugins/voice-input/`、`opencraft/apps/workbench-web/embedded-chat/` 与 runtime。
- `service-gateway/internal/gateway/`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md` | 跨服务路由 | 不以直连作为公共路径证据 |
| `docs/context/project/services/service-gateway.md` | 代理责任 | 身份、凭据和业务状态分离 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 维护规范 | 共享录音逻辑与迟到结果隔离 |
| 各服务 `AGENTS.md` | 局部规则 | 验证与发布授权边界 |

## decisions
- 用户确认直接复用现有 VelaGW 管理 API，撤销额外内部 Key 入口。
- `POST /api/admin/users/:user/api-keys` name=default：复用 active Key，缺失可能创建，202 不代表就绪；管理令牌只在服务端。
- Service Gateway 短时、有界进程缓存，不持久化音频/Key。

## validation
- Service Gateway Go tests/race/vet；VelaGW 无源码改动，无需发布。
- Voice plugin/workbench typecheck、聚焦语音测试、boundaries。

## handoff
源码接线完成；运行配置与上线另需确认。

## delivery_authorization
- 用户已确认提交、推送、创建 MR，合入后先发布上海；未授权新山启用。
- 上海 speech 使用 `token-admin.lightvela.com` / `token.lightvela.com`。
- 独立 SOPS Secret 仅从现有 CTL 区域 SSM 版本映射管理令牌，不更改 SSM 值、不复制其他凭据。
- 发布 bundle 必须包含新增 Secret，镜像、配置、Secret 一并通过 GitOps 晋级。

## evidence
- Service Gateway `go test -race ./...`、`go vet ./...` 通过。
- Voice plugin/workbench typecheck、语音/听写/嵌入权限测试通过。
- Web 与 embedded-workbench 构建、platform boundaries 通过。
- 文档链接检查无错误，身份/运行时两个责任域 change-impact 检查通过。
- Browser smoke 使用真实 Chromium 合成麦克风与 Composer，外部识别响应模拟，不代表生产识别实测。
