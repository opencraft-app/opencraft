# 较大二进制附件上传

## goal
使 Web 本地 Codex 上传链路支持页面已有的 32 MiB 文件额度。

## non_goals
- 不修改推理、远端 SSH 文件能力或本轮自动连接修改。
- 不修改其他运行时行为；应用与重启按用户后续明确授权执行。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前会话：用户报告“普通文本文件上传可以 二进制不行 大点的”，随后要求继续。
- 文件类型、具体大小与界面错误待用户补充；已独立复现大小相关故障。

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/src/runtime/browser-attachment-resolver.ts`：32 MiB 文件准入与 Base64 编码。
- `opencraft/scripts/serve-workbench-web.mjs`：WebSocket maxPayload。
- `opencraft/apps/local-agent-host/src/attachments/local-attachment-staging.ts`：32 MiB 解码后额度、校验及存储。
- `opencraft/packages/app-host-server/src/index.ts`：现有逻辑连接及 RPC 路由。

## history_context
- current_design_refs：`opencraft/docs/chat-ui-architecture.md` Attachment staging、`docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution：当前运行 bundle 与源码的 WebSocket maxPayload 均为 16 MiB；前端与 Host 已声明 32 MiB 文件额度。
- superseded_refs：无。

## acceptance
- 小文本、13 MiB 和 32 MiB 随机二进制通过真实 WebSocket 上传并验证存储 SHA-256。
- 超过文件限额时返回可恢复错误并保留连接；超传输上限仍拒绝。
- 隔离候选验证不发起推理；授权应用后核对当前服务并完成真实上传验收。

## affected_paths
- `opencraft/scripts/serve-workbench-web.mjs`
- `opencraft/tests/web-attachment-upload.test.ts`
- `opencraft/package.json`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- agent-gateway-runtime、site-environment-routing、upstream-subtrees、service-opencraft；已在前序相同工作目录读取，不重复加载。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 授权与验收 | 本轮不隐含重启/发布 |
| `docs/context/domains/agent-gateway-runtime.md`、`docs/context/domains/site-environment-routing.md` | 路由必读 | 责任边界 |
| `docs/context/project/upstream-subtrees.md`、`docs/context/project/services/opencraft.md` | 路由必读 | 真源与验证范围 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`、`opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 维护方法 | 真实链路与隔离验收 |
| `opencraft/docs/chat-ui-architecture.md`、`opencraft/docs/platform-architecture.md` | 附件与 Host contract | 保持存储限额与所有权 |
| `docs/engineering/domains/agent-gateway-runtime.md`、`.agents/context/change-impact.json` | 正式设计同步 | 更新映射文档 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接 | 已检查 Host 配置与相邻测试；本轮检查附件和 Headless 相邻测试 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 状态记录 | 本 Task Pack |

## evidence
- 直接调用附件存储：1/4/8/13/32 MiB 随机二进制均成功。
- 修改前 WebSocket 回归：小文本成功，13 MiB 二进制上传断开连接，测试失败。
- 当前运行 bundle 第 70947 行仍为 16 MiB WebSocket 限额。

## risks
- 消息限额增加意味着每连接最大接收分配增加，仍保持有限 48 MiB；Host 文件解码后仍限制 32 MiB。
- 当前运行包包含现场后端补丁，后续如授权应用必须保留这些补丁，不能用旧 checkout 整体覆盖。

## validation
- 附件存储、browser resolver、WebSocket 上传聚焦测试：20 项通过。
- `npm run test:headless-server`：31 项通过。首次运行因 checkout 缺失 node-pty 原生模块失败，`npm rebuild node-pty --build-from-source` 后重跑通过。
- `npm run typecheck --workspace @opencraft/local-agent-host`：通过。
- `npm run test:bot-management`：32 项通过。
- `node --check scripts/serve-workbench-web.mjs`、`git diff --check` 与文档变更影响检查：通过。
- 当前运行 bundle 的独立候选只变更 maxPayload 16 -> 48 MiB，其他现场修复完整保留。真实 Chromium 通过实际附件选择器上传 1 KiB 文本、13 MiB 和 32 MiB 二进制，保存字节的 SHA-256 一致，33 MiB 在浏览器发起上传前拒绝，零页面错误；没有发起推理。
- 候选与证据在 `/data/opencraft-binary-upload-20261010/`，候选运行时 SHA-256 为 d56833fd5dd39e3f7a1de797cc5527ddaa18914aaee736f3281de58530048b98。

## decisions
- 将 gateway WebSocket maxPayload 从 16 MiB 调整至 48 MiB，覆盖 Base64 约 43 MiB 与协议包装，不新增第二条上传链路。

## scan_scope
- Web 附件 resolver、staging、Headless gateway、AppHost；日志只检查错误关键词，不读取附件内容。

## scan_output
- 无敏感产物。

## handoff
- 源码、隔离包与当前运行服务均已完成验证。用户明确要求“应用”后，独立切换任务已应用候选并重启，最终状态 complete。
- 当前服务 PID 634160，cgroup 为 `/system.slice/opencraft-migrated.service`，工作目录与监听 80 端口均核对一致；运行时 SHA-256 为 d56833fd5dd39e3f7a1de797cc5527ddaa18914aaee736f3281de58530048b98。
- 实际运行服务上传 13/32 MiB 二进制成功，保存字节 SHA-256 一致，33 MiB 拒绝后连接仍可用；临时验收附件已删除，用户附件保留。Web buildId 仍为 `20261010-local-codex-auto-412571440ce9`，本轮只替换后端一处上限。
- 切换与回退证据保存在 `/data/opencraft-binary-upload-20261010/`；未提交、推送源码。

## checkpoint
- 前次中断后继续同一任务，13 MiB 断连已复现，网关上限已改，待验证。
- 2026-10-10：源码、Headless 与真实浏览器隔离上传验证通过；候选仅改变当前后端 bundle 一处网关上限，当前实例及数据保持原状。
- 交接时 unit active/running，当前 PID 562423；运行时哈希仍为旧基线 5af14f85de5cafbc7b518c6aad2ea1c89d0a9a28f84ccc745a2029fb8388780f，说明上传补丁尚未应用。当前进程 PID 与前序自动连接任务不同，后续切换必须重新核验 owner。
- 应用前重新确认 PID 562423、unit owner、工作目录与旧 bundle 哈希一致。Web 产物不变，本轮只替换一处后端传输上限；用户本轮附带的 PDF 已在原附件目录保存，原文件不参与修改或清理。
- 第一次切换完成重启，但 live 验收脚本在异步文件读取之后才订阅 socket open，错过事件而超时；独立任务自动回退成功。当前回退服务 PID 621738、旧哈希与 Web buildId 已核实。修正为创建 socket 后立即订阅 open，并用隔离真实 Codex 服务执行该 live verifier，13/32 MiB 保存 SHA-256、测试附件删除及超限拒绝全部通过。继续按用户“应用”的授权重试，不重复请求确认。
- 第二次独立切换成功，重连后核对 PID 634160、cgroup、工作目录、端口与运行时哈希；`switch-result.json` 为 complete，`live-verified.json` 为 passed。
