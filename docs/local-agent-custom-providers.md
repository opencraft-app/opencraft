# Local Agent custom providers

当前桌面模型配置真源已改为 OpenCraft 自己读写的 `~/.opencraft/models.json`，凭据独立存储在私有 credentials.json 中。详见 [模型配置所有权](../design/model-configuration.md)。下文的 DSH namespace/API 是兼容适配层，不是产品持久化格式。

## 界面状态

地址输入明确为“API 基础地址（Base URL）”，不接受 /chat/completions、/responses、/models 操作路径作为基础地址。界面内联说明并阻止保存/检查，主机保存、探测、发现及引擎应用使用同一校验规则；保留合法网关/部署前缀，不静默截断用户输入。旧错误配置可读取并明确修正，不因新增规则清空存储。

提供商列表每行以共享 SettingsSwitch 滑动开关替代绿点，打开启用、关闭停用；名称按钮与开关为兄弟控件，点击名称只选择，不嵌套交互控件。所有提供商的右键菜单复用现有默认模型命令：只有一个已启用模型时直接“设为默认”，多个时通过子菜单明确选择，不建立 provider-only 默认值；自定义项另外保留重命名和删除。默认提供商的关闭有保护及说明，未提供启停能力的项只读。详情摘要明确区分“连接已配置 · 未启用／已启用”；窄屏隐藏列表时保留直接启用和详情更多入口。所有启停入口调用同一 toggle 命令，不自动保存脏草稿或改变默认模型。不另建原生 checkbox 样式分支。

品牌标识是纯呈现层：`model-services/brand-mark.tsx` 为提供商列表、标题与模型行提供固定尺寸槽位。提供商按精确 ID/显式别名匹配，模型独立按家族匹配，不把网关品牌当作模型品牌；未知提供商使用共享 `ExtensionsIcon`，未知模型使用共享 `ModelIcon`。映射不得参与默认选择、配置、凭据或路由。品牌资源使用 MIT 标识的 `@lobehub/icons-static-svg@1.95.1`（[Lobe Icons](https://github.com/lobehub/lobe-icons)），随应用本地打包、按需加载，不引入其 UI 框架；单色 SVG mask 继承主题文字颜色。品牌商标仍属于各自权利人。

两版旧模型设置 UI 已移除且不恢复。模型服务页面由 `model-services/controller.ts` 与 `model-services/view.tsx` 实现：提供商分组/搜索，同页配置与模型列表；不恢复旧弹窗和连接页面。当前注册“模型服务”，默认模型接口保留但旧默认模型设置页不恢复。

DSH 运行时、配置/凭据协议及其测试继续保留。实际模型配置、凭据和用户数据没有删除。LocalAgentSettingsService 是无界面的 Host-scoped 配置客户端，并固定绑定 `local` Host：Electron 指向本机 Daemon，明确启用内建 Agent 页的 Web 部署指向已配置的服务器 Host；配置与凭据由 Host 持有，浏览器不另存副本。ModelServicesController 持有选择、搜索和内存草稿。连接表单采用明确的“保存并收起”，取消放弃未提交输入并取消待保存计时器；原始 revision 的 CAS 不变。界面检查通过 runtime/models/check 读取后端已保存的连接和密钥，脏草稿必须先保存，不隐式提交。离开提供商后清空已保存草稿中的明文输入，存储密钥不会返回给页面。

简化呈现保留“提供商 → 模型”：已有配置且凭据确认存在时默认折叠连接表单，首次配置自动展开，未知凭据状态不冒充已配置；“连接已配置”不表示检查成功。脏草稿始终展开，显式展开偏好按提供商保留。模型行常驻名称、品牌、当前默认标记和开关，ID 与设为默认放入 Radix 操作弹层；取消重复的全部/对话分类。未启用提供商默认折叠，搜索或选中其中项目时展开。模型服务作为 Settings 中的 master-detail 页面呈现；Electron 使用“本机”分组，Web 使用“服务器”分组，不再经过环境选择、概览或面包屑。

新发现模型通过 `disableNewModels` 在同一次 CAS 保存目录并设置为未启用，既有开关状态保留；手动添加模型是独立用户意图。配置保存、provider 启用、模型开关、文本检查均不改默认模型或会话选择。DeepSeek 与其他提供商共享启停命令和默认模型保护；维护补丁在其原有 settings namespace 增加 enabled，并真实释放/重新注册适配器路由。停用不删除配置或凭据，重启后仍保持停用。其原生协议差异只留在适配层，公开草稿检查默认地址不代表环境变量覆盖后的实际路由。

Settings Shell 只拥有分类导航和容器。master-detail 决定模型服务内部提供商目录与详情布局；提供商页面不自行绘制第二个标题栏。宽度由实际容器决定，窄容器只改呈现，不重建配置服务，也不改变其固定的 `local` Host 目标。

成功的提供商/模型变更统一取消并失效对应 Host 的 Composer 能力查询。TanStack Query 缓存 agents 与 models 的联合结果，按 Host 和必要的 thread 范围隔离；两边所有分页完成后一次发布，不能用新模型目录拼接上一轮 Agent modelIds。打开模型菜单检查 60 秒新鲜度，失效或上次失败时重新读取；失败保留完整旧结果并提示重试，空结果正常覆盖。RPC 当前不支持中断网络 I/O，但查询消费 AbortSignal 并在发布前校验，取消后迟到结果不得发布。现有协议没有事务 revision，联合读取只保证前端成组发布，不声称后端事务一致性。目录更新不写用户模型选择；原选择不可用时提示重新选择。

每个已启用模型都有统一的“设为默认”入口，当前默认模型显示标记。默认提供商的停用保护对所有适配器相同，用户可先显式更换默认模型再停用原提供商。原生 DeepSeek 的 enabled 默认值保留存量兼容性，但显式停用不会因刷新或重启而恢复；停用释放新请求的路由，不删除既有配置，也不承诺取消在途请求。

## Ownership

Responses API 协议开关只在适配器声明支持时出现在连接表单的“高级设置”内，默认折叠；启用时摘要显示“协议：Responses API”。折叠仅影响可见性，不重置协议、草稿或保存状态。

Configuration clients call the selected AppServer host. OpenCraft's ModelConfigurationRepository owns the versioned JSON document and CAS; ModelConfigurationService coordinates commits and a replaceable ModelEnginePort. DSH settings and credentials are execution projections through the DSH adapter. The runtime registry still owns actual availability, separately from saved product intent. Renderer unmount or WebSocket disconnect does not cancel a submitted command.

The bundled pi-ai adapter supports `openai-completions` and `openai-responses`.
These are API wire formats, not authentication mechanisms or a guarantee that
every provider implements every model capability. Codex OAuth remains separate.

Ollama Cloud is a fixed provider entry even when the pinned DSH catalog does not
list it. Its new connection draft uses the provider's OpenAI-compatible endpoint
`https://ollama.com/v1`, the `openai-completions` wire format and the optional
Host environment reference `OLLAMA_API_KEY`. The existing endpoint discovery
reads `/v1/models`; imported models stay disabled until the user enables them.
For Ollama Cloud, discovery also reads each model's same-origin `/api/show`
capabilities with a bounded, unauthenticated request. A reported `vision`
capability adds image input. String levels reported in `thinking.values` add
the corresponding reasoning efforts (`minimal`, `low`, `medium`, `high`,
`xhigh`, `max`) to the model declaration. The `false` value is not mapped to
Off: omitting `reasoning_effort` on the OpenAI-compatible endpoint does not
guarantee that Ollama disables its default thinking. Missing metadata stays
conservative. Re-fetching fills missing metadata on existing models while
preserving explicit user choices. Model actions let users set supported
reasoning levels individually when an endpoint does not expose that metadata;
the model endpoint must actually accept the chosen `reasoning_effort` value.
The product model document persists these declarations and projects them to
DSH, so they survive Host restart and feed the Composer reasoning selector.
Other providers' catalog and OpenAI-compatible `/models` discovery currently
return model IDs without reliable per-model reasoning levels. Built-in DSH
models can still report their own capabilities at runtime; declared custom
models can use the same manual setting instead of guessing from model names.
The entry does not install a separate Ollama runtime or change local Ollama
connections. An API key is required before enabling inference unless the Host
already provides `OLLAMA_API_KEY`.
An enabled provider also needs at least one enabled model. The Host rejects
an enable command before persisting when no model is ready. A previously saved
empty enabled connection reports an actionable application error; fetching
models and enabling one repairs the engine projection without changing the
stored credential or default model.

## AppServer surface

- `runtime/models/check`: 调用方只能传 provider、model、expectedRevision。后端绑定已保存的地址、协议、模型和凭据引用，缺失密钥才提示配置；解析凭据后再次检查连接快照，防止新地址接收旧密钥。可以检查尚未启用的完整连接，但不改变启用或默认模型状态。前端仅在宿主声明 canCheckSaved 时呈现此能力。

- `runtime/providers/delete`: 仅删除 `llm-pi-ai` 声明的自定义提供商，按 namespace revision 进行 CAS；验证精确配置路径，保护默认提供商，同次移除其 modelSelection 配置，不删除可能共享的凭据。内置提供商不提供删除入口。
- 提供商行通过 Radix 右键菜单提供默认模型选择；单一可用模型直接提交，多模型必须在子菜单选择具体模型。菜单消费 `agent-default-model`、实际 active 状态和模型 enabled 状态，脏连接草稿、只读或忙碌时禁用。自定义提供商另提供重命名和删除。重命名沿用 apply，只更新显示名，保留连接身份、模型和凭据。脏连接草稿需先保存或取消，确认窗口捕获打开时的 revision；冲突不自动重试。删除需要确认，删除当前项后回到已有启用项或目录。

- `runtime/providers/list`: directory and host-supplied creation capabilities
  (`kind`, supported `apis`, namespace `revision`). Existing providers advertise
  editable model/protocol capabilities. The UI does not invent a DSH write path.
- `runtime/providers/apply`: create/update a stable provider ID, expected revision,
  endpoint, optional display name/protocol/model declarations, credential intent.
  Host resolves the underlying namespace/path, validates, coordinates credentials,
  and submits a CAS settings mutation.
- `runtime/providers/setEnabled`: revision-checked runtime lifecycle command.
  Disabling retains settings and credentials; enabling changes actual registration.
  The list reports `configured`, `enabled`, and registry `active` separately.
- `runtime/models/discover`: required `source: catalog | endpoint`. Catalog lookup
  strips the draft URL and key. Endpoint discovery requests `<baseURL>/models`,
  preserves deployment prefixes, rejects redirects, and bounds response size/time.
  Only an explicitly supplied draft key is used; stored credentials are never
  implicitly forwarded to a new host. Results are unsaved candidates.
- `runtime/models/list`: effective model registry, not discovery candidates.
- `runtime/models/probe`: one explicit draft text request, capability-gated by
  `configuration.canProbe`. Takes protocol, base URL, model ID and optional write-only
  probe key. Does not read DSH credentials, persist anything, enable a route or create
  a session. Rejects redirects, bounds time to 15 seconds and body to 256 KiB, makes
  no retry and never returns provider body or key. A valid text response verifies
  only that draft request, not streaming/tools/vision or the effective DSH route.
- `runtime/settings/mutate`: remains for generic settings such as default model;
  provider saves from this UI no longer use it directly.

Credential intents: keep (endpoint changes require explicit reuse confirmation),
replace (fresh unique secret reference), reference (explicit existing reference),
none (detach via an unbound reference so inherited credentials cannot reappear).
Detaching does not mean unauthenticated inference is supported: DSH rejects a
missing required credential. No shared old secret is overwritten or deleted.

## Commit invariants and limits

1. Provider identity is distinct from display name and model ID. New providers
   cannot overwrite an existing directory entry. Duplicate/stale writes reject.
2. Settings updates modify addressed fields, not a copy of all effective defaults.
3. New credentials are staged under unique references. A rejected save cannot
   change the secret used by an existing session/provider.
4. Lost acknowledgement is not rejection. Host reads authoritative settings and
   recognizes committed operations. Even DSH `settings-rejected` can follow a
   successful persistence step when a commit listener throws.
5. Cleanup occurs only after a CAS conflict or a definitive rejection plus an
   unchanged authoritative revision. Unknown outcomes retain the staged secret
   and return `provider-save-uncertain`; no automatic resubmission or deletion.
6. There is no cross-store atomic transaction or durable application journal.
   A process crash between credential staging and settings commit can leave an
   unreferenced credential. It must not be collected without checking ownership.
   This implementation does not claim crash-safe automatic orphan collection.
7. `saved: true` means config persisted, not registration/inference/network success.
   Saving a provider does not alter default model or existing session selections.
   Changing a route affects later requests that resolve that route; in-flight
   or whole-run configuration pinning is not introduced by this change.

## Verification

- `npx tsx --test tests/execution/runtime-provider-service.test.ts tests/execution/local-agent-host.test.ts`
- `npm run smoke:local-agent`: actual bundled DSH, isolated data, authenticated
  WebSocket, both protocol registrations, restart persistence, unchanged defaults.

Tests use synthetic credentials and make no paid or external inference request.

## Provider and model lifecycle

Model management separates catalog definition from selection policy. Runtime-owned
`llm-pi-ai.modelSelection` records disabled model IDs per provider (including native
providers); it does not erase the adapter catalog or existing session bindings.
`runtime/models/list` and `model/list` exclude disabled entries; the management UI
requests `includeDisabled: true` and receives source/enabled metadata.
`runtime/models/setEnabled` and `runtime/models/delete` take provider, model and
the llm-pi-ai namespace revision. Delete is only for custom definitions, preserves
credentials/history, and requires disabling a provider before deleting its last
model. Built-in definitions cannot be deleted. Existing sessions may continue
their currently bound disabled model, but cannot newly select a disabled model.
The AppServer adapter serializes model/provider/default-setting writes and rejects
disabling/deleting the default or selecting a disabled default. Generic AppServer
mutations of llm-pi-ai must use the domain commands instead. Direct external DSH
writers are outside that adapter queue; this is not a cross-process transaction.


The protocol client carries an immutable hostId for every read/write/probe; it owns no UI state.

Verification additionally uses `tests/execution/model-services.test.ts` and
`scripts/smoke/execution/smoke-model-services.ts` (real UI → isolated AppServer/DSH, with a local
model endpoint). Empty optional `input: []` materialized by DSH is normalized to
omission in the client read projection so round-trip saves keep inherited semantics.

`scripts/patch-dsh-provider-lifecycle.mjs` adds enabled-state support to the pinned DSH pi-ai adapter. Disabled routes remain editable through the domain API but are excluded from runtime resolution. OAuth, unauthenticated inference and failover are not introduced by this surface.

## 新任务的上次模型选择

独立工作台有账号模型authority时，把显式选择的模型和推理强度保存到服务端，按已认证用户及Host隔离，同一用户跨浏览器、新任务和刷新恢复。服务端从真实认证请求确定用户，以revision CAS拒绝过期写入；浏览器只保留可丢弃的查询内存，不导入旧本地模型记忆。匿名不能保存个人默认；无账号authority的独立客户端保留安装偏好。该偏好只保存模型引用与强度，不保存连接或凭据，不改变已有会话绑定；切换Agent时选中的目标模型同样记忆。未做显式选择时仍消费Host声明的默认模型；记忆中的模型失效时提示重新选择，不按目录顺序改用其他模型。

个人选择不调用config/batchWrite，不改共享Host默认。Host默认只作为个人未设置时的回退，显式提供商管理仍属Host配置。嵌入式Host-default入口不读取或写入独立工作台的模型偏好，继续遵循宿主默认。
