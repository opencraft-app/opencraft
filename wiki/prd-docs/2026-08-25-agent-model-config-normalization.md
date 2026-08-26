# 模型配置多源兼容读取与渐进归一化

## 基本信息

- 当前产品：LightVela
- 需求单状态：待评审
- TAPD 需求：[【产品需求】【LightVela】【双站】模型配置多源兼容读取与渐进归一化](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091137484207)
- 创建日期：2026-08-25
- 最后更新时间：2026-08-25
- 发布范围：国内站与国际站双站同步
- 优先级：P0

## 需求背景

LightVela 新模型配置页需要同时兼容 Hermes Agent 官方配置、LightVela 页面新增配置以及历史版本遗留配置。当前页面主要从 `lightvela.model_config.configured_models` 读取已保存模型，再补充 `model` 和 `fallback_providers`。当存量用户的 DeepSeek、MiniMax 等模型只记录在 `providers`、`custom_providers` 或旧字段中时，页面会漏掉这些仍然有效的配置。

Hermes Agent 本身也没有一份等价于“所有已配置模型”的单一清单。其配置分别表达：

- `model`：当前主模型。
- `fallback_providers`：按顺序执行的备用模型链。
- `providers` / `custom_providers`：已保存的 Provider 接入、端点、当前模型、模型目录和凭据引用；`make_default: false` 时可以只保存而不修改主模型。
- `lightvela.model_config.configured_models`：LightVela 已上线版本产生的兼容数据源，不是 Hermes 官方运行真源，但读取时必须长期兼容。

因此，本需求不再选择某一个字段作为唯一读取来源，而是采用“多源兼容读取、统一内存投影、写入 Hermes 官方三层配置”的方案。在保证 Hermes CLI、Dashboard 和 LightVela 页面都能修改配置的前提下，长期收敛新写入结构，避免旧模型消失、重复展示或错误删除凭据。

## 目标用户与场景

### 目标用户

- 已经通过旧页面、Hermes CLI 或手工编辑配置过模型的存量用户。
- 需要在 LightVela 页面统一管理主模型和多个备用模型的用户。
- 同时使用官方 Provider、自定义端点、Coding Plan 或历史 Provider 配置的用户。

### 典型场景

1. 用户过去配置了 DeepSeek 和 MiniMax，但它们只存在于 `providers`，打开新页面后仍能看到并设为主模型或备用模型。
2. 用户通过 LightVela “仅添加”了一个模型，尚未设为主备，后续可以直接切换用途。
3. 用户通过 Hermes CLI 修改了主模型或备用链，刷新 LightVela 页面后能看到最新运行配置。
4. 默认 `custom` 配置存在时，页面保留该配置；信息完整时可直接设置主备，信息不完整时引导补齐模型配置。
5. 用户对历史配置执行一次主备切换后，相关配置按 Hermes 当前标准结构写回，但不重写无关 Provider。

## 目标

### 产品目标

- 所有仍然有效、可被用户继续使用的模型配置在页面中可见。
- 主模型、备用模型、仅保存模型、有效历史模型和默认 `custom` 配置形成一个统一列表。
- 用户可以把任意信息完整且有效的模型设为主模型或备用模型。
- 新增和变更统一写入 Hermes 官方 `providers`、`model`、`fallback_providers`，旧读取来源继续兼容。
- 页面读取不修改配置，不因为打开页面产生配置漂移。

### 成功标准

- 存量 `providers` 中的有效模型不再因 `configured_models` 为空而消失。
- 同一个模型部署不会因多个来源而重复展示。
- Hermes CLI 或官方 Dashboard 修改主备后，LightVela 刷新可正确反映。
- 用户操作只修改目标模型及必要运行字段，未知扩展字段和其他 Provider 保持不变。
- 写入失败时配置和凭据可以回滚，不出现界面成功但实际未生效。

## 范围

### 本次包含

- 模型配置的多源读取与统一投影。
- 主模型、备用模型、Hermes 已保存模型、LightVela 兼容模型、有效历史模型和默认 `custom` 配置的统一展示。
- 模型身份归一化、去重、字段合并和排序。
- 失效闲置记录过滤，运行中异常配置保留展示。
- 设为主模型、设为备用模型、取消备用、仅保存和删除的归一化写回。
- `fallback_model`、`custom_providers`、Provider 旧别名字段等历史配置兼容。
- 国内站和国际站一致的读取、操作与异常处理。
- 单元测试、配置回归测试和真实 Hermes helper smoke 测试。

### 本次不包含

- Hermes 辅助模型槽位 `auxiliary.*` 的页面管理。
- 模型用量分析、费用统计和历史会话统计。
- 在页面展示内部来源分类、API Key 状态或最近检测时间。
- 修改 Hermes Agent 官方配置协议。
- 一次性全量重写用户的 `config.yaml`。
- 将 Provider `/models` 原始结果不加筛选地全部展示。
- 修改现有 Provider 产品列表及 SDK 内置配置。

### 已知依赖

- 实例 `debug/exec` 能执行内嵌 Python helper。
- Hermes 配置模块能够读取、保存 `config.yaml` 与凭据文件。
- Hermes 新版本提供 Provider schema、fallback helper 和 backend identity 时优先复用；旧版本使用兼容实现。

## 方案决策

### 采用方案

采用“多源兼容读取、统一投影、写入 Hermes 官方机制”。

```text
本地多源配置
    -> 候选模型收集
    -> Provider 信息补全
    -> 模型部署身份合并
    -> 角色与来源计算
    -> 失效过滤与稳定排序
    -> 前端统一 Snapshot

用户执行配置操作
    -> 根据统一身份定位目标
    -> 写入 providers / model / fallback_providers
    -> 定向迁移或清理被操作的旧来源记录
    -> 保存配置与凭据
    -> 重新加载并再次投影
    -> 校验角色和持久化结果
```

### 选择理由

- Hermes 原生运行字段继续作为运行真源，不被 LightVela 扩展字段替代。
- 可以兼容 CLI、Dashboard、手工配置和旧页面共同修改配置。
- `providers.<id>` 原生表达“仅添加”，不需要继续新增 LightVela 私有保存记录。
- 读取无副作用，降低错误迁移和配置损坏风险。
- 写入时逐步归一化，迁移成本随用户真实操作摊销。

### 备选方案与取舍

1. 只读取 `lightvela.model_config.configured_models`：实现简单，但会继续漏掉 CLI、历史 Provider 和默认 `custom` 配置，不采用。
2. 将 `configured_models` 升级为唯一真源或继续双写：可以兼容旧页面，但会长期制造两套保存真源和双向漂移，不采用。
3. 只读取 Hermes 官方 `model` 与 `fallback_providers`：运行状态准确，但无法表达仅保存和有效历史模型，不采用。

## 功能详细描述

### 1. 多源候选收集

Python helper 每次读取以下本地来源，不进行 Provider 网络探测：

1. `model`
2. `fallback_providers`
3. legacy `fallback_model`
4. `lightvela.model_config.configured_models`
5. `providers.*.model`
6. `providers.*.default_model`
7. `providers.*.models`，仅用于补充当前模型的目录信息，不将全部模型自动视为已配置模型
8. legacy `custom_providers`
9. Hermes 默认 `custom` 配置

“获取可用模型”和“检测模型连通性”仍是独立的显式操作，只有用户点击时才访问 Provider。

### 2. 统一模型资产投影

每个候选项归一化为内存中的模型资产：

```ts
interface ModelAsset {
  id: string;
  providerKey: string;
  providerName: string;
  baseUrl: string;
  routeBaseUrl: string;
  apiMode: string;
  keyEnv: string;
  roles: Array<"primary" | "fallback">;
  sources: ModelAssetSource[];
}
```

`roles` 和 `sources` 是读取时动态计算的投影元数据，不写入 `config.yaml`，也不直接展示给用户。来源可能包括：

- `runtime-primary`
- `runtime-fallback`
- `lightvela-saved`
- `provider-model`
- `provider-default`
- `legacy`
- `default-custom`

### 3. 模型部署身份与去重

模型资产使用 `provider + model + endpoint` 判断是否为同一部署：

- Provider、模型 ID 和 URL 比较时忽略大小写。
- URL 去除末尾 `/` 后比较。
- 同 Provider、同模型且一侧未显式配置 URL时，未配置侧继承 Provider 默认端点，视为同一部署。
- 同 Provider、同模型但两侧均配置不同 URL 时，视为两个部署。
- 非官方 Provider 别名在模型与显式 URL 相同时可以合并。
- 两个不同官方 Provider 即使模型 ID 和 URL 相同，也保留为不同部署。
- Hermes 当前版本提供 `BackendIdentity` / `same_deployment` 时优先复用官方语义。

### 4. 字段合并优先级

同一模型资产从多个来源出现时，字段按以下优先级补全：

```text
model / fallback 中的显式运行路由
    > providers 中的 Provider 定义
    > lightvela configured_models
    > legacy custom_providers
    > 安全默认值
```

角色不按字段优先级覆盖，而是独立计算：

- 出现在 `model`：主模型。
- 出现在 `fallback_providers`：备用模型。
- 两者均未出现：未参与运行。
- 同一部署意外同时位于主备时，统一投影以主模型为准；下一次相关写操作从备用链移除重复项。

### 5. 展示与过滤规则

统一列表按以下顺序展示：

1. 主模型。
2. 备用模型，保持 `fallback_providers` 顺序。
3. `providers.<id>.model` 中已保存但未参与运行的模型。
4. `lightvela.configured_models` 等兼容来源中的有效历史模型。
5. 默认 `custom` 配置。

过滤规则：

- 当前主模型和备用模型始终展示；配置异常时保留记录，避免隐藏实际运行故障。
- 未参与运行的历史模型在凭据缺失且无 OAuth/凭据池、Provider `enabled: false` 或模型已从配置与可用目录移除时隐藏。
- 临时探测失败不作为隐藏条件，避免网络波动导致列表闪烁。
- 默认 `custom` 是保留展示的例外；如果缺少具体模型身份，作为待补全配置展示，补齐前不能直接写入主备槽位。
- 不在页面展示来源、API Key 状态、最近检测时间等内部信息。

### 6. 主备与闲置操作

#### 设为主模型

- 写入 Hermes `model.provider`、`model.default`、必要的 `base_url` 与 `api_mode`。
- 从备用链中移除同一运行部署。
- 确保目标模型在 `providers.<id>` 中存在；如果它只来自 LightVela 兼容列表，则先定向迁移该模型，不再回写新的私有保存记录。
- 仅影响新会话；已有会话保持原模型，页面成功提示需说明这一点。

#### 设为备用模型

- 主模型与备用模型不能解析为同一运行部署。
- 追加到 `fallback_providers` 尾部并保持现有顺序。
- 支持多个备用模型。
- 对备用链进行身份去重，但保留未触碰条目的未知扩展字段。

#### 取消备用

- 只移除目标备用角色。
- 模型仍保留在统一列表中，变为未参与运行状态。
- 不删除 Provider 或凭据。

#### 仅保存

- 按 Hermes Custom Endpoint 保存机制写入 `providers.<id>`，包括端点、当前模型、模型目录、`key_env` 和模型发现策略。
- 使用等价于 `make_default: false` 的语义，不修改主模型或备用链。
- 不再新增或同步写入 `lightvela.model_config.configured_models`。

### 7. 删除语义

- 当前主模型禁止直接删除，用户必须先设置新的主模型。
- 删除备用模型时，先从备用链移除。
- 删除来自 LightVela 兼容列表的模型时，从 `configured_models` 定向移除对应旧记录，避免兼容读取后重新出现。
- 仅当目标模型属于 LightVela 管理的 Provider、已没有主备引用且 Provider 下还有其他模型时，才从该 Provider 的 `models` 中移除目标模型。
- 仅当 LightVela 管理的 Provider 已没有模型、没有主备引用、没有其他配置引用时，才删除 Provider 条目。
- 仅当凭据引用不再被任何 Provider 或模型使用时，才删除对应凭据。
- 对仅从外部 Hermes/手工 Provider 配置导入的历史模型，页面删除不应破坏未知来源配置；本期默认只移除 LightVela 管理记录和角色。若仍能从外部来源重新投影，则不提供破坏性清理，后续可单独设计“隐藏记录”能力。

### 8. Hermes 官方机制归一化写回

页面打开和普通刷新保持只读。读取始终兼容所有已上线来源，但新增和变更只写 Hermes 官方三层配置：

- “仅添加”写入 `providers.<id>`，默认不修改主模型。
- “设为主模型”写入 `model.provider` 与 `model.default`，并保留必要端点路由字段。
- “设为备用模型”写入 `fallback_providers`，保留顺序并按身份去重。
- legacy `fallback_model` 在相关写操作中合并到 `fallback_providers`。
- Provider 使用 Hermes 当前可识别字段，包括端点、当前模型、模型目录、`key_env`、协议和发现策略。
- Provider 旧别名 `base_url`、`url`、`api_mode`、`api_key_env` 仅在当前被管理条目上迁移。
- API Key 不写入模型 Snapshot、日志或 `config.yaml`，配置中只保留 `key_env`。
- 不相关 Provider 的未知字段、TLS、请求覆盖、扩展 header 和凭据引用保持不变。
- `lightvela.model_config.configured_models` 继续参与读取，但新操作不再双写；当旧记录被明确迁移或删除时，只定向清理对应项。
- 保存后重新加载配置、再次统一投影，并验证目标角色与记录确实生效。
- 配置或凭据任一步失败时恢复原始配置与原凭据状态。

### 9. 默认 custom 配置

- `custom` 配置包含 Provider、模型与端点时，作为普通模型资产参与身份合并、主备判断和操作。
- `custom` 只有模板字段但没有模型 ID 时，保留为待补全配置，不伪造模型 ID。
- 用户补齐 API Key、探测模型并选择模型后，写入标准 `providers.<id>`；是否同步主模型由用户选择用途决定。
- 如果补齐后的命名 Provider 与原 `custom` 指向同一部署，统一投影只展示一条记录。

## 异常与边界处理

- 单个来源结构损坏：跳过该候选并继续读取其他来源，不让整个页面白屏。
- `config.yaml` 根节点不是对象：读取失败并显示通用配置错误，不尝试写入。
- 同 Provider、同模型存在多个明确不同端点：均展示；操作必须携带路由 URL 消除歧义。
- 模型身份无法唯一定位：拒绝写入并提示刷新配置，不能猜测目标。
- 主备角色冲突：在凭据保存和配置写入前拒绝。
- Provider 探测失败：保留已有模型列表和配置，不清空用户选择。
- Hermes 版本不支持 Provider schema：在保存凭据前失败关闭，避免留下孤立密钥。
- 保存后重新读取不符合预期：操作判定失败并回滚。

## 发布站点与同步策略

- 发布范围：双站同步。
- 国内站是否同步：是。
- 国际站是否同步：是。
- 差异化原因：两站使用相同 Hermes 配置语义和实例操作链路，仅文案与 Provider 产品配置存在现有地区差异。
- 路由影响：国内站和国际站 `/agents/models/`。
- 内容影响：四语言模型配置文案、错误信息与测试资源按现有站点能力维护。
- 上线顺序：分支预览完成双站验收后同步进入发布流程。

## LightVela 影响面

- 前端页面/路由：`/agents/models/` 模型配置页。
- Hermes/OpenClaw/运行时：`config.yaml`、凭据文件、Provider schema、主模型和备用链。
- SkillHub/MCP/工具：无直接影响。
- SDK/文档/运营：不修改 SDK Provider 产品配置；需要同步模型配置帮助文档时另行评估。
- 权限/安全/数据：继续使用 RSA 一次性凭据传输和 Hermes 凭据生命周期，不在前端或日志暴露 API Key。

## 非功能性需求

### 性能

- 普通页面读取不得主动探测所有 Provider。
- 候选收集与归一化只处理本地配置规模，不能因失效自定义端点阻塞页面。
- Provider 网络访问仅由用户主动点击获取模型或检测连通性触发。

### 兼容性

- 兼容 Hermes 当前 `providers` schema。
- 兼容 `custom_providers`、`fallback_model` 和 Provider 旧字段。
- 沿用现有桌面端与移动端浏览器要求。

### 安全

- API Key 不进入命令参数明文、Snapshot、页面日志、测试快照或 TAPD 描述。
- 错误信息统一脱敏。
- 删除凭据前必须确认没有其他配置引用。

### 国际化与无障碍

- 沿用现有四语言资源完整性门禁。
- 主备操作按钮、禁用态和 Tooltip 支持键盘焦点与屏幕阅读器语义。

## 测试与验收

### 常规路径

1. `configured_models` 为空，但 `providers` 中存在有效 DeepSeek、MiniMax 模型时，两者正常展示。
2. `model`、fallback、LightVela 保存列表和 Provider 目录同时包含同一部署时，只展示一条并正确标记角色。
3. 多个备用模型按原顺序展示，新增备用追加到尾部。
4. 有效历史模型可以设为主模型、设为备用模型或保持未参与运行。
5. 默认 `custom` 配置正常展示；配置完整时可设置主备，配置不完整时进入补全流程。
6. Hermes CLI 修改主模型或备用链后，页面刷新反映新状态。
7. 用户操作旧配置后，目标记录迁移到 Hermes 官方字段，不再新增 LightVela 私有保存记录。

### 异常路径

1. 闲置模型凭据缺失、Provider 禁用或模型已失效时不展示。
2. 当前主模型或备用模型即使凭据缺失仍展示，并标记配置异常。
3. 临时探测失败不移除已有模型。
4. 同 Provider、同模型、不同显式 URL 保留为两个资产，操作不会误改另一个。
5. 不同官方 Provider 提供同名模型时不误合并。
6. 主模型不能被设置为自身备用部署。
7. 删除一个模型不会删除仍被其他模型引用的 Provider 或凭据。
8. 配置保存失败、凭据保存失败或保存后校验失败时完整回滚。
9. 旧 Hermes 不支持 Provider schema 时不写入凭据。
10. 配置中未知扩展字段、fallback route 凭据引用和请求覆盖字段保持不变。

### 验收标准

- [ ] 主模型、备用模型、仅保存模型、有效历史模型和默认 `custom` 配置均按规则进入统一列表。
- [ ] 失效闲置记录被过滤，运行中异常记录仍可见。
- [ ] 同一运行部署不重复展示，不同部署不误合并。
- [ ] 任意有效且信息完整的模型均可设置主模型或备用模型。
- [ ] 读取配置不产生任何写操作或网络模型探测。
- [ ] 用户写操作只写入 Hermes 官方三层配置并定向处理目标旧记录，不破坏未知字段和无关配置。
- [ ] API Key 在传输、日志、响应和配置写入中满足既有安全要求。
- [ ] 国内站与国际站预览完成存量配置、主备切换、异常回滚和刷新一致性验证。

## 发布与观测

- 灰度/开关：沿用分支预览和现有前端发布流程，不新增运行时开关。
- 日志：记录结构化操作类型和脱敏错误，不记录 API Key、header 或凭据变量值。
- 埋点：本期不新增产品埋点。
- 回滚：前端回滚至上一版本不会删除已按 Hermes 标准字段写入的主备和 Provider 配置；读取兼容层继续识别存量 `configured_models`。

## 产品原型说明

- 目标页面：`/agents/models/`。
- 页面结构：沿用当前“已配置模型”与“选择模型”两张卡片，不新增页面层级。
- 用户主路径：查看统一模型列表 -> 设置主备或添加模型 -> 保存后刷新确认。
- 关键状态：主模型、备用模型、未参与运行、配置异常、待补全 custom。
- 跳过新原型原因：本需求不改变已确认的页面布局和主要交互，仅修正数据来源、兼容策略和配置写回语义。

## 产物交接

- 产品：确认统一展示范围、失效过滤和删除语义。
- 前端：实现统一 Snapshot 类型、列表状态和主备操作反馈。
- Hermes 配置适配：实现 Python helper 多源投影、渐进迁移、回滚和保存后校验。
- QA：覆盖存量配置矩阵、双站页面走查和真实实例配置回归。
- 文档：如用户帮助文档描述“已配置模型”来源，随功能发布更新。

## 待确认问题

- 无阻塞项。外部 Hermes/手工 Provider 历史记录的破坏性删除不在本期范围；如果后续需要允许用户隐藏此类记录，应单独设计可逆的忽略列表，而不是直接删除未知配置。
