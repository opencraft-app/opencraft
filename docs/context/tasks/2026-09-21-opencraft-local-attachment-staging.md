## goal
冻结引擎中立的 Host-owned attachment staging 协议，并实现 Local Host adapter，使首个非图片附件无需预建目录即可进入 ready 状态并安全提交。

## non_goals
- 本轮不实现 Remote RPC/SFTP 或 Cloud COS/S3 adapter。
- 不改变图片当前的 inline data URL 路径。
- 不提交、推送或远端发布；本地安装仅在用户后续明确要求“更新一下 `/Applications/OpenCraft.app`”后执行。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户确认：“应该是订好协议，实现本地”，并授权进入实现。
- 用户随后明确授权更新本机 `/Applications/OpenCraft.app`。
- 原始故障：DOCX 在 Local Host 首次添加时显示 `Attachment ... is not ready`。

## interface_refs / data_structure_refs
- 新增 `opencraft/attachment-staging` Host capability。
- 新增 `attachment/stage`、`attachment/remove` typed AppServer extension。
- `AttachmentStageParams` 表达目标 Host 连接内的附件身份、元数据和 source；`AttachmentRef` 表达 `host-file | object-url`，不暴露具体传输策略给 Composer。
- Local v1 capability 仅声明 `client-bytes -> host-file`；Remote/Cloud 后续以同协议新增 adapter/capability，不改 Composer 状态机。
- Composer 只允许所有附件均为 `ready` 时提交；失败保留原始错误并允许删除。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md`、`opencraft/docs/chat-ui-architecture.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：当前 Renderer 拼接 `codexHome/opencraft-attachments` 并直接调用通用 `fs/writeFile`；Local Host 不创建父目录。
- `superseded_refs`：`ref/codex` 与 `ref/wb` 仅为固定参考，不是产品事实。

## acceptance
- 协议明确区分 source、location、capability 和生命周期，未实现的 Remote/Cloud 不被伪装为可用。
- Local Host 在受控数据根下自动创建隔离目录，校验大小/身份，原子落盘并返回 `host-file` ref。
- Renderer 不再拼接 Host 目录，也不直接用通用 filesystem resource staged attachment。
- 空文件、超限、大小不符、非法身份与重复身份冲突失败闭合；失败不留下可发送附件或残留 partial。
- 删除未提交附件可回收 Local staged resource。

## affected_paths
- `opencraft/packages/appserver-protocol/src/attachments.ts`
- `opencraft/packages/appserver-protocol/src/{index,methods}.ts`
- `opencraft/apps/local-agent-host/src/attachments/local-attachment-staging.ts`
- `opencraft/apps/local-agent-host/src/main.ts`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/apps/workbench-web/src/runtime/browser-attachment-resolver.ts`
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/packages/composer-core/src/store.ts`
- `opencraft/packages/codex-composer/src/codex-composer.tsx`
- 聚焦测试与正式设计文档。

## required_context
- 根与 `opencraft/AGENTS.md`。
- `opencraft-maintenance`、验证清单与 `tdd`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | OpenCraft 所有权与验证边界 | 确定协议、Host、Runtime、View 分层 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 项目维护方法 | 约束生命周期和真实验收 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 跨协议/Host 验证 | 选择 appserver、chat、desktop 门禁 |
| `opencraft/docs/platform-architecture.md@working-tree` | Host resource 所有权 | staging 归 Host，不归 Renderer |
| `opencraft/docs/chat-ui-architecture.md@working-tree` | Composer/SubmitIntent 边界 | ready barrier 与 AttachmentRef handoff |
| `ref/codex/features/editor/attachments-registry-filename.ts@fixed-reference` | Codex 数据结构参考 | 借鉴受控目录、create/copy/write/cleanup contract |
| `ref/wb/packages/agent-ui/src/hooks/use-additional-actions.tsx@fixed-reference` | WorkBuddy Local/Cloud 参考 | 验证 Local path 与 Cloud upload 是 adapter 差异 |

## evidence
- TDD red/green：协议 capability export 缺失 → `opencraft/attachment-staging` v1 capability/parser 通过。
- TDD red/green：首个 Local write 模块缺失 → Host-owned staging 自动创建目录、原子写入、返回 `host-file`。
- TDD red/green：重复 identity 曾接受同大小不同内容 → manifest 增加 SHA-256，重放幂等、metadata/content 冲突拒绝。
- TDD red/green：`manifest.json` 文件名曾覆盖 registry → staged content 使用保留前缀并通过回归。
- TDD red/green：Local Host 未声明 capability → initialize、stage、remove 真实 WebSocket 链路通过。
- TDD red/green：Resolver 仍要求 Renderer directory/writeFile → 改为 semantic `stage` port；Composer failed attachment 发送屏障通过。
- 聚焦测试：protocol 5/5、Local staging 4/4、Local Host 10/10、resolver 8/8、Composer Core 18/18。
- 受影响六个 workspace typecheck 全绿；`test:appserver`、`test:chat`、`test:workbench:unit`、`check:boundaries` 全绿。
- `npm run build:electron` 通过，DSH runtime 0.1.1-rc.2 验证通过。
- 隔离 Electron profile + CDP：首个合成 DOCX 显示 ready chip、无 `not ready`；文件与 manifest 位于隔离 Host data root；点击删除后 staged 文件消失。截图 `/tmp/opencraft-attachment-ready.png`。
- `git diff --check`、documentation validation 与精确 changed-file change-impact 门禁通过；正式领域 Owner review 仍由后续 MR 承担。
- Developer ID arm64 ZIP 候选 buildId `20260921033915-1677e621c170`：深度严格签名、ZIP 完整性、Daemon/DSH 哈希和隔离包 DOCX staging 通过；公证未配置，`spctl` 明确为 `Unnotarized Developer ID`。
- `/Applications/OpenCraft.app` 已替换并从真实安装路径启动；Main/Daemon/DSH 均来自安装路径，Local Connected。旧版保留在 `/Applications/OpenCraft.app.backup-20260921-033900`。
- 模型与 Connector 丢失疑问经只读核对排除：真实 profile 的 `models.json` 保留 revision 44、3 个 provider/125 个模型；Connector client config、Host instance 与 credential 行均存在，当前会话可见 GLM-5.3 Flash 与腾讯文档 Connector。

## risks
- 当前工作树已有其他未提交改动；仅增量修改精确边界，不回退其他内容。
- 通用 `fs/writeFile` 不能自动创建任意父目录；attachment service 必须限制根目录并校验身份。
- staged 文件不能在提交 accepted 后立刻删除，否则 Agent 下一 step 可能尚未读取。

## validation
- 聚焦 protocol、local staging、resolver、composer tests。
- 受影响 workspace typecheck。
- `npm run test:appserver`、`npm run test:chat`、`npm run check:boundaries`。
- change-impact、documentation、diff-check。

## decisions
- 统一协议先行；本轮 capability 诚实声明仅 Local `client-bytes -> host-file`。
- staging path 由 Local Host data root 持有，不使用 Renderer 拼接的 `codexHome`。
- 提交只冻结 ready ref；失败附件必须阻断发送，不能在 compiler 才暴露泛化错误。

## scan_scope
- 当前 attachment resolver、Composer lifecycle、AppServer extension pattern、Local Host filesystem boundary、`ref/codex` 与 `ref/wb` 对应实现。

## scan_output
- 有界源码对照，无独立扫描产物。

## handoff
- 当前：协议、Local Host adapter、Workbench port、Web resolver、Composer barrier/删除回收、正式设计与回归验证完成。
- 未实现：Remote RPC/SFTP、Cloud object-store、Native producer；capability 未声明这些能力。
- 本机安装：已更新并运行 buildId `20260921033915-1677e621c170`；旧版有可恢复备份。
- 未执行：未提交、推送、远端发布或公证。
