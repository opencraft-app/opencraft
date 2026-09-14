# LightVela 多 Bot 与 Hermes Profile 产品化

## 基本信息

- 当前产品：LightVela
- 需求状态：分阶段实现，当前发布批次隐藏新建 Bot 入口
- 创建人：LightVela 产品团队
- 创建日期：2026-09-09
- 最后更新时间：2026-09-11
- 需求类型：复杂需求
- 优先级：P0
- 发布范围：国内站 lightvela.com only，本期不上线国际站 lightvela.ai

### 当前发布决策

- 已有 Agent 的“新建 Bot”按钮默认隐藏，可在浏览器 Console 执行 `show()` 后临时显示，刷新页面后恢复隐藏。该开关不绕过多 Bot 功能开关和创建数量限制。保留已创建 Bot 的切换、配置和删除，无实例用户的首次 Agent 创建流程保持可用；面向普通用户开放另行确认。
- Bot 数量按当前套餐限制且包含主 Bot：启航 Launch、启航 Launch AI 每个 Agent 最多 5 个；巡游 Cruise、巡游 Cruise AI 每个 Agent 最多 10 个。达到上限后“新建 Bot”按钮保持可见和原文案，但置灰、不可点击，hover 时提示原因。
- 普通 Bot 删除仅删除该 Profile。主 Bot 删除代表销毁整个 Agent 实例，必须先删除同实例内所有其他 Bot；前后端都校验此条件。
- 本期不实现更换主 Bot，也不实现“更换主 Bot 并删除原主 Bot”。
- 不迁移数据库、不新增 Bot 映射表或套餐配额字段；列表和元信息从 Hermes 官方 `GET /api/profiles` 读取，刷新后以运行时真实 Profile 为准。
- AgentChat 暂时仅主 Bot 可用，普通 Bot 的对话入口禁用，不能回退到主 Bot 会话。

## 需求来源与调研结论

### 需求来源

用户希望开始设计 LightVela 的多 Bot 功能。前置调研已经确认，Hermes 底层 Bot 与 Profile 是同一类隔离单元，ACLI 也已经具备命名 Profile 的基础路由能力；但 LightVela 当前仍是“一台实例对应一个产品 Bot”的数据模型，产品侧尚未完成多 Bot 闭环。

### 调研结论

- Hermes 原生支持多个 Profile，根 Profile 的官方语义是 `default`。
- ACLI LightVela 规格将省略、空值、`default` 和 `main` 都解析到原有 `$HERMES_HOME`，不会创建 `$HERMES_HOME/profiles/main`。
- LightVela 当前对单 Bot 使用 `main` 作为公开选择器最合适；显式传 `--agent 'main'` 仍访问根 Profile，不迁移 Provider、模型、通道、Skills、Memory 或 SOUL 数据。
- LightVela 当前前端拿到的是实例 `botId`，Bot API 没有稳定 `profile_id`，因此不能把实例 ID 直接作为 Hermes `--agent` 参数。
- ACLI 已在多数 Profile 级命令上支持 `--agent`，但不同 capability 和存量实例版本的发布节奏不完全一致，批量技能安装等能力仍需要兼容判断。
- 多 Bot 产品化需要独立设计 Bot 数据模型、Profile 生命周期、命令路由、存量映射、失败补偿和端到端隔离验证。

### 当前差距

- 用户只能在一个实例里使用一个产品 Bot，无法为不同角色、场景或外部渠道建立独立 Agent。
- 人设、Memory、User Profile、Skills、Provider、模型和通道配置被当前单 Bot 体验绑定在一起，缺少清晰的多 Bot 隔离边界。
- 前端功能页以 `botId` 为配置和命令执行维度，缺少 Profile 级选择上下文。
- 后端 Bot 数据没有 `profile_id`，无法稳定表达“同一实例下的多个 Bot”。
- Hermes Profile 创建、克隆、删除失败时，LightVela 还没有产品级补偿和恢复策略。
- 存量单 Bot 用户需要继续留在根 Profile，不应因为多 Bot 功能被自动迁移或复制数据。

## 需求背景

### 当前用户怎么做

用户现在购买或创建一个 LightVela Agent 实例后，在控制台里配置这个 Agent 的模型、Provider、通道、Skills、自动任务、Memory 和人设。若用户想同时维护“个人助理”“客服 Bot”“社群运营 Bot”“代码助手”等不同角色，只能反复修改同一个 Agent，或创建多个实例来绕开隔离问题。

### 当前卡点

- 一个实例只能稳定承载一个产品 Bot，角色切换成本高。
- 不同角色共用同一份 Memory、Skills 和通道配置时，容易产生上下文污染。
- 为了隔离角色而购买多个实例，成本和管理复杂度都更高。
- 渠道配置与 Bot 身份没有解耦，例如一个 Telegram/Slack/QQ Bot 应明确绑定到目标 Agent，而不是隐式依赖当前唯一 Agent。
- 现有界面没有说明底层 Profile 能力，用户也无法理解哪些配置是 Bot 级、哪些是实例级。

### 用户价值

- 在一个 LightVela 实例中创建多个独立 Bot，用于不同角色和业务场景。
- 每个 Bot 拥有独立的人设、Memory、User Profile、Skills、模型和可多 Bot 连接的外部通道配置。
- 用户可以从存量主 Bot 克隆一个新 Bot，快速复用基础配置后再独立修改。
- 不同 Bot 的配置和会话结果互不污染，降低试错成本。

### 产品价值

- 将 Hermes 多 Profile 基础能力转化为 LightVela 可发现、可管理、可验收的产品能力。
- 提升单实例价值，减少用户为了角色隔离而重复购买实例的挫败感。
- 为后续团队协作、Bot 模板、场景化创建、Bot 市场和跨 Bot 编排建立稳定数据基础。

## 目标用户与场景

### 目标用户

- 个人用户：希望同时维护工作助理、生活助理、学习助理等不同 Agent 身份。
- 开发者与创作者：希望为不同项目配置独立 Skills、Memory 和模型策略。
- 运营与客服用户：希望按渠道、品牌、社群或客户类型拆分 Bot。
- 企业管理员：希望一个实例中承载多个场景 Bot，但仍能清楚查看配置边界和运行状态。

### 典型场景

#### 场景一：从主 Bot 克隆客服 Bot

用户已有一个主 Bot，配置了基础 Provider 和常用 Skills。用户点击“创建 Bot”，选择“从当前 Bot 克隆”，命名为“售前客服”。系统创建新的 Hermes Profile，复制可克隆配置，生成独立 SOUL。用户随后只修改客服话术、渠道和 FAQ Skill，主 Bot 不受影响。

#### 场景二：为不同渠道绑定不同 Bot

用户希望 Telegram 面向社群答疑，企业微信面向内部运营。用户在 Bot 列表中进入“社群助手”，连接 Telegram；再进入“内部运营”，连接企业微信。支持多 Bot 连接的渠道状态、密钥、二维码和回调配置都按 Bot/Profile 隔离。若用户选择微信这类国内站同一实例只支持一个 Bot 连接的渠道，页面需要展示已被哪个 Bot 占用，并引导用户先断开原 Bot 或切换到已连接 Bot 管理。

#### 场景三：试验新模型而不影响主 Bot

用户克隆主 Bot 为“模型实验”，切换到另一个 Provider 和模型，安装实验 Skills 并运行对话。主 Bot 的模型、Skills、Memory、自动任务和通道配置保持原状。

#### 场景四：存量用户升级后继续使用主 Bot

存量用户进入新版控制台后，原来的 Agent 显示为默认主 Bot。它继续映射根 Profile `main`，原有 Provider、模型、通道、Skills、Memory、SOUL、自动任务和会话入口保持可用，不自动创建命名 Profile，也不迁移用户数据。

## 目标

### 产品结果

- 用户可以在一个 LightVela 实例内创建、查看、切换、克隆和删除多个 Bot。
- 每个 Bot 都有稳定 `profile_id`，并映射到一个 Hermes Profile。
- 存量单 Bot 用户无感升级，原 Bot 继续映射 `main`/根 Profile。
- Profile 级配置命令都基于当前 Bot 的 `profile_id` 执行，不再固定使用 `main`。
- 用户能清楚理解 Bot 级配置与实例级能力的边界。

### 业务目标

- 提升单实例可承载的场景数量和用户留存。
- 降低用户因多角色需求重复创建实例的成本。
- 为后续 Bot 模板、场景化创建和团队共享 Bot 建立数据基础。

### 观测目标

- 多 Bot 功能开启后的 Bot 创建率、克隆率、删除率和切换频次。
- 新 Bot 创建成功率、Hermes Profile 创建成功率、失败补偿成功率。
- 创建后 7 日内使用两个及以上 Bot 的用户占比。
- 多 Bot 用户的配置完成率、通道连接率、Skills 安装率和有效会话数。
- 存量用户升级后默认主 Bot 的配置读取失败率和命令执行失败率。

## 范围

### 本次包含

- 一个 LightVela 实例内支持多个产品 Bot。
- 后端 API 返回稳定 `profile_id`，从 Hermes Profile 投影，不新增数据库表。
- 存量 Bot 映射根 Profile，公开选择器为 `main`。
- 新建 Bot 创建命名 Hermes Profile，产品 Bot 由运行时 Profile 投影。
- 前端按当前有效 Pass 的 `bundle_id` 应用 Bot 数量软限制：启航 Launch/Launch AI 为 5，巡游 Cruise/Cruise AI 为 10；主 Bot 占用一个名额。
- 从主 Bot 或任一已有 Bot 克隆新 Bot。
- 删除 Bot 时处理 Hermes Profile 生命周期，并提供失败补偿。
- Bot 列表、当前 Bot 切换、Bot 基本信息编辑和默认 Bot 标识。
- Provider、模型、通道、Gateway、Skills、自动任务、Memory、User Profile、SOUL 等 Profile 级能力按当前 Bot 路由。
- 支持多 Bot 的外部通道可以由每个 Bot 独立连接和管理，包括通道状态、连接凭据、二维码、回调配置和断开操作。
- 不支持多 Bot 的国内站通道按实例级唯一资源处理；微信本期按同一实例同时只支持一个 Bot 连接设计。
- 实例级能力继续按实例执行，不追加 Profile 参数。
- ACLI capability 版本兼容与灰度门槛。
- 国内站上线所需的前端、后端、运行时和文档更新。

### 本次不包含

- 多实例聚合管理。
- 团队成员权限、Bot 共享、协作编辑和审计。
- Bot 模板市场或公共 Bot 发布。
- 跨 Bot 编排、Bot 群聊、Bot 互相调用。
- 跨实例或跨账号迁移 Bot。
- 把存量根 Profile 自动迁移到命名 Profile。
- 将外部渠道的一个 Bot Token 同时绑定到多个 LightVela Bot。
- 默认共享或复用其他 Bot 的通道凭据。
- 让微信等实例级唯一通道同时连接多个 Bot。
- 后端套餐配额、独立计费套餐、按 Bot 收费或 Bot 数量售卖策略调整。
- 国际站发布与同步。
- Hermes 底层 Profile 语义变更。
- 更换主 Bot，以及更换后删除原主 Bot。

### 优先级

P0：数据模型、存量 `main` 映射、创建/克隆/删除、Profile 级命令路由、配置隔离、灰度与回滚。

P1：Bot 列表体验增强、创建模板、Bot 使用统计。

P2：团队共享、Bot 模板市场、跨 Bot 编排和运营化能力。

### 已知依赖

- Hermes Profile 创建、克隆、删除、列表和选择能力在目标镜像中稳定可用。
- ACLI Profile 级命令完整支持 `--agent`，或具备可检测的兼容降级。
- LightVela 后端实例 API 可以扩展 Bot 数据模型并返回 `profile_id`。
- 前端所有配置页能够接收当前 Bot 上下文，而不是只依赖实例 `botId`。
- 自动任务、通道和 Skills 的实际数据隔离需要端到端验证。

## 功能详细描述

### 1. Bot 数据模型

每个产品 Bot 至少包含：

- `id`：LightVela 产品 Bot ID；命名 Bot 使用 Hermes Profile ID，主 Bot 为兼容存量使用实例 ID。
- `instance_id`：所属 LightVela Agent 实例。
- `profile_id`：Hermes Profile 选择器，存量主 Bot 固定为 `main`，新建 Bot 使用命名 Profile。
- `name`：用户可见 Bot 名称。
- `description`：可选运行时元信息，当前创建表单不提供用途说明字段。
- `avatar`：Bot 头像或系统默认图标。
- `is_default`：是否默认主 Bot。
- `status`：创建中、可用、删除中、异常、Profile 不可用。
- `created_from`：空白创建、从主 Bot 克隆、从指定 Bot 克隆。
- `created_at` / `updated_at`：创建和更新时间。

`profile_id` 是运行时路由字段，不允许前端从 `botId` 推导。后端必须返回真实值，前端只能消费。

上述字段为 API 投影，不要求建立数据库记录。列表与名称从 Hermes 官方 `GET /api/profiles` 读取；展示名与稳定 ID 分离，重命名不改变 Profile 身份。

### 2. 存量 Bot 升级

存量实例首次进入多 Bot 能力后：

- 自动展示一个默认主 Bot。
- 主 Bot 的 `profile_id` 为 `main`。
- 不创建 `$HERMES_HOME/profiles/main`。
- 不迁移、不复制、不清空原有根 Profile 数据。
- 原有 Provider、模型、通道、Skills、Memory、SOUL、自动任务和会话入口继续访问 `$HERMES_HOME`。
- 直接将根 Profile 投影为主 Bot，不补建数据库记录。

### 3. 创建 Bot

无 Bot 用户的首次创建入口保持可用；已有 Agent 的追加创建入口位于 Agent 控制台的 Bot 列表或当前 Bot 切换器中，当前发布批次默认隐藏，仅用于内部验证。

首次创建与追加创建采用不同表单：

- 首次创建：此前没有任何 Bot/Profile，只填写 Bot 名称；不展示创建方式和高级设置。点击“确认创建”后开始创建首个 Bot。
- 追加创建：填写 Bot 名称，并在“复制当前”“复制主 Bot”“空白创建”中选择创建方式；不展示高级设置和初始人设输入。

追加 Bot 的创建方式定义如下：

- 空白创建：创建命名 Hermes Profile，并把主 Bot 当前主模型、该模型对应的单个 Provider 配置及其所需凭据作为一次性快照写入新 Profile。新 Bot 不预装任何用户 Skills；创建完成后页面显示的已安装 Skills 数量为 0，用户可再按需安装。
- 从当前 Bot 克隆：复制可克隆配置，生成独立 Profile 后允许用户继续修改；这是追加创建弹窗的默认推荐选项。
- 从主 Bot 克隆：适合用户基于原有主 Bot 配置创建新角色。

空白创建调用 Hermes no-skills Profile 能力，不复制主 Bot 或当前 Bot 的 Skills，也不播种 LightVela 基础技能或 Hermes bundled skills。Profile 保留 bundled-skills opt-out 状态，后续 Hermes 更新不得自动回填；对此类 Profile，Hermes 为保证运行保留的 `hermes-agent` 内部 Skill 不属于用户可管理 Skills，不在 LightVela 已安装列表中展示或计数。既有 Profile 的列表语义保持不变，用户主动安装 Skills 不受影响。

空白创建只继承让新 Bot 能立即调用模型所需的最小集合：当前主模型 ID、匹配的单个 Provider 配置、Base URL / 协议，以及该 Provider 明确引用的凭据或配置环境变量。它不复制备用模型、其他已配置模型或 Provider、完整 `.env`、人设、Memory、User Profile、用户 Skills、通道、会话、定时任务和运行状态。该动作是创建时快照，不建立持续同步关系；创建后主 Bot 与新 Bot 的模型、Provider 和凭据可以分别修改，互不覆盖。若主 Bot 的 Provider 未提供所需凭据，新 Profile 不从其他 Provider 猜测或补抄 Key，模型页应显示待配置状态。

新建 Bot 不做未告知的完整 Profile 复制。`default`/`main` 只作为存量主 Bot、用户显式选择的克隆来源，以及空白创建的主模型最小基线；不得把它当作复制完整配置或完整 `.env` 的隐式来源。创建方式提示区统一按“继承”和“不继承”展示：空白创建明确写明“继承主 Bot 当前主模型及其 Provider 凭据”，同时写明不继承备用模型、其他已配置模型、人设、记忆、Skills、通道和定时任务。

Bot 名称输入框默认留空，使用“请输入 Bot 名称”占位提示；去除首尾空白后为 1 至 60 个 Unicode 码点，前端显示计数，后端创建和重命名均校验。当前 Bot 就是主 Bot 时，合并重复来源选项为“复制当前（主 Bot）”和“空白创建”。弹窗主按钮为“确认创建”，与“取消”并排放在右下角。

创建成功后，页面先刷新共享 Bot 列表并切换到新 Bot，再进入其设置页；不得停留在初始化状态并要求用户手动刷新。

#### 套餐数量限制

- 数量口径是“单个 Agent 内当前可枚举的 Hermes Profile 总数”，包含根 Profile 对应的主 Bot。
- 启航 Launch、启航 Launch AI：每个 Agent 最多 5 个 Bot；已有主 Bot 时最多再创建 4 个普通 Bot。
- 巡游 Cruise、巡游 Cruise AI：每个 Agent 最多 10 个 Bot；已有主 Bot 时最多再创建 9 个普通 Bot。
- `agent_quota` 继续表示用户可拥有的 Agent 实例席位，不得复用为 Bot 数量上限；本期不新增后端 Bot 配额字段。
- 前端使用当前有效 Pass 已有的 `bundle_id` 固定映射上限；仅在首次成功获取 Pass 列表后，免费套餐、未知套餐或无有效 Pass 才按最多 1 个 Bot 处理。首次请求未完成或失败且没有成功快照时，前端暂不以默认值阻止创建；后续刷新失败则保留最近一次成功结果。
- 达到上限后，“新建 Bot”按钮保持可见并继续显示原文案，按钮置灰且不可点击；hover 时提示当前套餐上限、主 Bot 计数口径及删除或升级建议。
- 创建中、删除中和套餐上限提示均使用前端国际化字典；即使多 Bot 入口尚未在国际站开放，共用空状态也不得显示中文原文。
- `provisioning` 和 `deleting` 状态暂时计入数量；创建或删除完成并刷新 Bot 列表后，前端重新计算按钮状态。
- 创建确认动作再次使用当前前端 Bot 列表校验，避免弹窗打开后数量变化仍继续提交。
- 当前限制只用于前端操作体验，不是安全或计费边界；直接调用创建接口、旧客户端或并发请求可能绕过，本期接受该限制。
- 套餐从启航升配到巡游后上限变为 10。若未来套餐降级导致已有 Bot 数大于新上限，不删除、不隐藏已有 Bot，只阻止继续创建，直到数量低于当前上限。
- Console `show()` 只改变入口可见性，达到上限时按钮仍保持置灰；它不提供后端强制配额能力。

### 4. 克隆边界

克隆不是复制历史会话，也不是共享同一份运行时状态。

默认可克隆：

- Provider 和模型配置。
- SOUL 基础内容，但新 Bot 可重新生成或编辑。
- 长期记忆和用户偏好，作为新 Profile 的初始快照。
- Skills 目录，作为新 Profile 的独立副本。

默认不克隆：

- 会话历史。
- 当前对话上下文（短时记忆）。
- 通道连接凭据和 Home channel。
- 定时任务定义和 Cron 运行历史。
- 本地 state 数据库。
- 备份目录。
- 运行中任务状态。
- 明确不能复用或权限敏感的外部 OAuth 授权。

通道密钥和 OAuth 是否可克隆必须按 capability 与安全策略逐项确认；不能默认声明所有认证都会复制。

### 5. Bot 切换与页面结构

`/agents` 是多 Bot 的主入口，页面必须具备 Bot 切换能力。Agent 控制台顶部提供当前 Bot 切换器，并在 `/agents` 及其分区页面保持同一个当前 Bot 上下文：

- 显示当前 Bot 名称、状态和默认标识。
- 支持切换和进入管理；直接展示可用 Bot 列表，不提供搜索框，列表超出高度时可滚动。当前发布默认隐藏新建入口。切换器使用浮层下拉框，不挤压下方布局。
- 切换 Bot 后，配置、Skills、Memory、自动任务、通道和模型刷新到目标 Bot；AgentChat 仅主 Bot 可用，普通 Bot 不得串用主 Bot 对话。
- 在 `/agents/channels`、`/agents/models`、`/agents/skills`、`/agents/persona`、`/agents/automations`、`/agents/memory`、`/agents/chat` 等分区内切换或刷新页面时，当前 Bot 上下文必须保持一致。
- 实例级页面保留实例维度状态，例如运行时健康、升级、重装、资源使用和实例 WebUI。

Bot 管理页包含：

- Bot 列表。
- Bot 基本信息。
- 创建方式和来源。
- Profile 状态。
- 删除操作。
- 异常修复入口。

### 6. Profile 级命令路由

所有 Profile 级命令必须使用当前 Bot 的 `profile_id`：

- Provider save/list/delete。
- Model switch/probe。
- Channel status/connect/delete。
- Gateway status/restart/qr-url。
- Skills install/uninstall/list。
- 自动任务 list/create/update/delete/run。
- Memory、User Profile 和 SOUL 读取写入。

通道连接默认按 Bot/Profile 级配置处理，但是否允许多个 Bot 同时连接同一类通道，必须由通道 capability 决定。Telegram、Slack、QQ、企微等支持多 Bot 的通道在 Bot A 连接时，只影响 Bot A 对应的 Hermes Profile；切换到 Bot B 后，通道状态、二维码、Token、回调和断开操作都必须读取和写入 Bot B 的 Profile。

微信等国内站实例级唯一通道不能照搬“每个 Bot 独立连接”的规则。本期微信按同一实例同时只支持一个 Bot 连接处理：若 Bot A 已连接微信，Bot B 的微信入口展示占用状态、占用 Bot 名称和管理入口，不允许直接覆盖或静默复用 Bot A 的微信凭据。产品不得把某个外部平台的同一 Bot Token 默认复制、共享或同时绑定到多个 LightVela Bot；如后续需要复用外部认证，必须按平台能力和安全策略单独设计。

Home channel 按 Bot/Profile 和平台分配，不设计成整个实例唯一的全局 home channel。每个 Bot 维护自己的 `home_channels` 映射，例如 Bot A 可以有自己的企微 home channel 和 Telegram home channel，Bot B 可以有另一组同平台或不同平台的 home channel。定时任务、通知投递和 `deliver=<platform>` 这类省略具体 chat 的发送逻辑，都必须在当前 Bot 的 Profile scope 内解析 home channel。

通道连接成功后的 home channel 分配策略：

- 支持多 Bot 的通道：连接或扫码成功后，为当前 Bot/Profile 设置该平台的 home channel；用户可在该 Bot 的通道设置里查看或重新设置。
- 实例级唯一通道：由占用该通道的 Bot 持有唯一 home channel；其他 Bot 展示占用态，不能设置自己的同平台 home channel。
- 用户显式从某个外部会话执行 `/sethome` 时，写入消息实际路由到的 Bot/Profile；不能写入全局实例配置。
- 创建或克隆 Bot 时不默认复制 home channel，除非某个通道后续被产品和安全策略明确允许克隆。

实例级命令继续只使用实例 `botId` 或实例上下文：

- ACLI 安装和 bootstrap。
- backend runtime-check。
- upgrade/reset/reinstall。
- 实例健康检查。
- 实例域名、资源、账单和套餐能力。

对公开 spec 未声明 `--agent` 的命令，前端或后端命令生成器必须先做 capability 检测；不支持时禁用对应 Bot 级操作或回退到明确安全的旧行为，不能静默写入错误 Profile。

### 7. 删除 Bot

删除 Bot 是高风险操作，需要二次确认。

删除策略：

- 普通 Bot：调用 Hermes Profile 删除能力，仅删除该 Bot 的配置和本地状态；成功后刷新真实列表，失败提供友好错误和重试。
- 主 Bot 且同实例还有其他 Bot：禁用删除入口，提示“请先删除其他 Bot，再删除整个 Agent”。
- 只剩主 Bot：入口和确认弹窗明确标注“删除整个 Agent”，输入主 Bot 名称后才能确认；执行现有实例销毁流程。
- 后端在条件式实例删除前重新读取 Profile 列表；仍有其他 Bot 时拒绝删除并返回可识别错误，不能仅信任页面缓存。
- Hermes `default` 不作为普通 Profile 单独删除；本期不更换主 Bot、不迁移根 Profile。

普通 Bot 删除确认文案必须说明：

- 会删除该 Bot 的 Profile 级配置和本地状态。
- 不会删除所属实例。
- 不会影响其他 Bot。
- 是否保留备份取决于运行时能力和后端策略。

普通 Bot 删除弹窗不展示“已购买的套餐不受影响”等套餐说明，避免在 Profile 删除流程中引入无关信息。

主 Bot 删除确认必须说明将销毁整个 Agent 及其主 Bot 数据，按钮为“确认删除 Agent”，不能沿用“不会删除所属实例”的普通 Bot 提示。

### 8. 异常和恢复

需要覆盖以下异常：

- Hermes Profile 列表读取失败或页面缓存与运行时列表不一致。
- Profile 创建或克隆清理失败；不得将本地临时状态当作创建成功。
- `--agent` capability 不支持。
- 切换 Bot 后部分配置读取失败。
- 删除 Profile 失败或超时。
- 存量主 Bot 的根 Profile 配置读取失败。

恢复策略：

- 对可重试操作提供重试。
- 对能力不支持的实例展示升级提示或灰度不可用提示。
- 对数据不一致提供只读保护，避免继续写入错误 Profile。
- 对存量 `main` 读取失败，回到单 Bot 兼容提示，不影响实例级操作。

### 9. Demo / 页面结构说明

默认需要 Demo 或交互评审稿，因为本需求新增 Bot 列表、切换器、创建弹窗、删除确认、异常状态和跨页面上下文切换。

推荐页面结构：

- `/agents` Agent 控制台顶部：实例名称、当前 Bot 切换器、实例状态。
- Bot 切换器弹层：Bot 列表、默认主 Bot 标识、异常状态，不显示搜索框。
- Bot 管理页：Bot 列表、创建入口、基本信息、Profile 状态、删除。
- 创建 Bot 弹窗：首次创建仅展示名称；追加创建展示名称和创建方式，克隆提示按“继承 / 不继承”结构化展示；不提供高级设置或初始人设输入，追加入口当前隐藏。
- 删除确认弹窗：区分普通 Bot 删除与整个 Agent 销毁，主 Bot 存在其他 Bot 时禁止提交。
- 配置页：在标题或上下文区展示当前 Bot，所有 Bot 级配置随切换刷新。

### 10. 数据埋点需求

建议埋点：

- `multi_bot_entry_view`：用户看到 Bot 切换或管理入口。
- `bot_create_start`：开始创建 Bot。
- `bot_create_submit`：提交创建。
- `bot_create_success` / `bot_create_failed`：创建结果，包含创建方式和失败阶段。
- `bot_switch`：切换 Bot。
- `bot_clone_start` / `bot_clone_success` / `bot_clone_failed`：克隆链路。
- `bot_delete_start` / `bot_delete_success` / `bot_delete_failed`：删除链路。
- `profile_route_command_failed`：Profile 级命令路由失败。
- `profile_capability_unsupported`：目标实例不支持所需 Profile capability。

埋点不得记录密钥、Token、原始 SOUL、Memory、User Profile 或通道敏感字段。

## 发布站点与同步策略

- 发布范围：国内站 lightvela.com only。
- 国内站是否同步：是，本期只上线国内站。
- 国际站是否同步：否，国际站 lightvela.ai 本期不发布，后续单独评估。
- 差异化原因：多 Bot 涉及 Hermes Profile capability、存量实例版本、国内渠道配置和中文文档说明，本期先在国内站完成灰度与端到端验证。
- 路由与内容影响：Agent 控制台、Bot 管理入口、设置页、Skills、自动任务、Memory、通道、文档、i18n 文案。
- 上线顺序：本批次隐藏已有 Agent 的新建 Bot 入口，交付存量管理和删除规则；Profile 创建链路验证通过并另行确认后再开放。国际站不进入本期发布计划。

## LightVela 影响面

- 前端页面/路由：Agent 控制台、当前 Bot 切换器、Bot 管理页、设置页、模型配置、Provider 配置、通道配置、Skills、自动任务、Memory、SOUL、人设配置。
- Hermes/OpenClaw/运行时：Hermes Profile 创建、克隆、删除、选择、命令路由和 capability 检测；OpenClaw 不进入本次范围。
- SkillHub/MCP/工具：Skills 安装、卸载、列表和专家技能包需要按 `profile_id` 执行；MCP 工具如具备 Profile 级状态，也需要后续确认。
- SDK/文档/运营：LightVela 本地命令生成器需要消费 `profile_id`；产品文档需要解释多 Bot、Profile 隔离、克隆边界和删除风险；运营材料需要避免承诺团队协作或跨 Bot 编排。
- 权限/安全/数据：Bot 级权限、敏感凭据克隆、Profile 删除、数据不一致保护、埋点脱敏、存量用户兼容。

## 非功能性需求

- 性能指标：Bot 列表接口在常见 Bot 数量下保持可感知即时返回；Bot 切换后配置页加载失败需有明确错误状态。
- 兼容性：沿用现有 LightVela 前端浏览器兼容性要求；移动端至少保证 Bot 切换、查看和基础管理可用。
- 安全与权限：用户只能查看和操作自己有权限的实例与 Bot；不得通过手写 `profile_id` 越权访问其他 Profile。
- 国际化 / 无障碍：本期面向国内站，中文文案必须完整；如改动通用组件仍需保持 i18n key 结构可扩展；切换器、弹窗和删除确认需要键盘可达。
- 数据安全：任何日志、埋点和错误提示不得输出 API Key、OAuth Token、通道密钥、Memory 原文或 SOUL 原文。

## 产物交接

- 产品：确认一期范围、站点策略、现有四个套餐的 5/10 Bot 数量上限、默认主 Bot 命名、克隆边界和删除语义。
- 设计：输出 Bot 切换器、Bot 管理页、创建弹窗、删除确认、异常状态和配置页上下文方案。
- 前端：改造当前 Bot 上下文、Profile 级命令调用点、页面刷新与异常态。
- 后端：扩展 Bot 数据模型、实例内 Bot API、权限校验、Profile 生命周期补偿和灰度开关。
- Hermes/运行时：确认 Profile capability 矩阵、存量镜像版本门槛、删除/克隆行为、认证复制边界。
- QA：覆盖存量主 Bot、新建空白 Bot、克隆 Bot、删除 Bot、能力不支持、命令路由隔离和回滚。
- 文档/运营：准备国内站使用说明、风险说明和 FAQ；国际站材料不进入本期交付。

## 方案决策

### 采用方案

采用“单实例多 Profile”的方案：一个 LightVela 实例内可以创建多个产品 Bot，每个产品 Bot 对应一个 Hermes Profile。存量单 Bot 映射根 Profile `main`，新建 Bot 使用命名 `profile_id`。

数量限制采用前端固定映射：读取当前有效 Pass 已有的 `bundle_id`，将启航 Launch/Launch AI 映射为 5，将巡游 Cruise/Cruise AI 映射为 10。该方案不新增数据库字段或后端拦截，直接调用接口仍可绕过。

### 选择理由

- 与 Hermes “Bot is Profile”的底层能力一致。
- 用户不需要为了多个角色重复购买实例。
- Profile 天然适合承载人设、Memory、Skills、模型和通道等隔离状态。
- 存量用户可通过 `main` 保持原路径，不需要迁移数据。
- 数量限制保持为小范围前端逻辑，不改变 Agent 实例席位或 Hermes Profile 数据模型。
- 为后续模板、团队共享和跨 Bot 能力留下稳定产品数据模型。

### 备选方案与取舍

#### 备选一：多实例多 Bot

- 解决路径：每个产品 Bot 对应一个 LightVela 实例。
- 收益：数据隔离最简单，复用现有单实例模型。
- 代价：用户成本高，实例管理复杂，不能体现 Hermes 多 Profile 能力。
- 结论：不作为一期推荐方案。

#### 备选二：前端虚拟 Bot

- 解决路径：前端维护多个名称、人设和 Skills 组合，但底层仍写入同一个根 Profile。
- 收益：实现较快。
- 代价：Memory、Provider、通道和任务无法真正隔离，容易造成数据污染。
- 结论：不采用。

#### 备选三：单实例多 Profile

- 解决路径：LightVela Bot 数据模型增加 `profile_id`，所有 Profile 级能力按当前 Bot 路由。
- 收益：隔离真实、成本适中、与 Hermes 能力一致。
- 代价：需要后端数据模型、前端上下文、命令路由和运行时 capability 联动。
- 结论：采用。

### 延后或不做

- 团队协作和 Bot 共享。
- Bot 模板市场。
- 跨 Bot 工作流编排。
- 后端配额、按 Bot 单独计费或新增 Bot 数量包；本期只落现有套餐的前端固定上限。
- 国际站发布与同步。

## 验收标准

1. 存量用户进入新版控制台后，默认主 Bot 显示正常，`profile_id` 为 `main`，原有 Provider、模型、通道、Skills、Memory、SOUL 和自动任务读取与写入均访问根 Profile。
2. 用户可以在一个实例内追加空白 Bot，系统生成命名 Hermes Profile，后端保存稳定 `profile_id`；新 Profile 只获得主 Bot 当前主模型、匹配的单个 Provider 配置及其所需凭据，不获得备用模型、其他已配置模型、完整 `.env` 或其他 Profile 数据。创建完成后页面显示的已安装 Skills 数量为 0，后续可按需安装，Hermes 更新不会自动回填 bundled Skills，运行必需的内部 Skill 不展示、不计数。
3. 用户可以从默认主 Bot 或任一普通 Bot 克隆新 Bot；可克隆配置形成独立副本，不继承会话历史、定时任务、通道连接和运行状态。
4. 追加创建弹窗默认推荐“复制当前”，但不得静默完整复制 `default`/`main`；用户必须能看到创建方式，以及结构化的“继承 / 不继承”范围，并能切换为“复制主 Bot”或“空白创建”。空白创建提示必须明确：继承主 Bot 当前主模型及其 Provider 凭据；不继承备用模型、其他已配置模型、人设、记忆、Skills、通道和定时任务。
5. Bot 切换后，Provider、模型、通道、Skills、自动任务、Memory、User Profile 和 SOUL 页面显示目标 Bot 的数据，不串读、不串写。
6. `/agents` 页面及 `/agents/<section>` 分区页面都具备当前 Bot 切换能力，切换后 URL 分区保持不变，页面数据刷新到目标 Bot。
7. 支持多 Bot 的通道可以由每个 Bot 独立连接、查看、刷新二维码、断开和重连；Bot A 的通道凭据和连接状态不得在 Bot B 中默认显示、复用或被修改。
8. 微信等实例级唯一通道同一实例同时只能被一个 Bot 连接；其他 Bot 看到占用态和管理入口，不允许直接覆盖、静默复用或同时连接。
9. 每个 Bot/Profile 按平台维护自己的 home channel；定时任务、通知投递和省略 chat 的发送逻辑必须解析到当前 Bot 的 home channel，不得落到实例全局或其他 Bot。
10. 删除普通 Bot 需要二次确认；删除成功后不影响其他 Bot 和实例级能力；删除失败时进入可恢复异常状态。
11. 主 Bot 存在同实例其他 Bot 时禁止删除；只剩主 Bot 时，经明确二次确认销毁整个 Agent，后端重新检查 Profile 数量。不支持更换主 Bot，也不自动迁移根 Profile。
12. 对不支持所需 `--agent` capability 的实例，产品入口被灰度或降级保护，不能静默执行到错误 Profile。
13. 所有 Profile 级命令均使用后端返回的 `profile_id`，前端不得由实例 `botId` 推导 Hermes Profile。
14. 日志和埋点不记录密钥、Token、Memory、User Profile 或 SOUL 原文。
15. 国内站灰度期间，创建、克隆、切换、删除、配置读取、配置写入、通道连接、home channel 解析、Skills 安装、自动任务创建和回滚路径均通过端到端验证。
16. 当前发布的已有 Agent 页面默认不展示“新建 Bot”入口；执行 `show()` 后在功能开关开启时显示，刷新后重新隐藏。达到数量上限时按钮保持“新建 Bot”文案和可见性，但置灰、不可点击，并在 hover 时提示原因。存量 Bot 切换与删除、无实例用户首次创建 Agent 不受此入口隐藏影响。
17. Bot 名称默认留空并显示“请输入 Bot 名称”，最多 60 个 Unicode 码点；首次创建只显示名称，追加创建不显示用途说明、高级设置或初始人设，主 Bot 创建来源选项不重复。
18. 普通 Bot 的 AgentChat 入口禁用；Bot 列表刷新后仍以 Hermes 官方接口返回的 Profile 为准，无需数据库迁移。
19. 启航 Launch、启航 Launch AI 每个 Agent 最多拥有 5 个 Bot，巡游 Cruise、巡游 Cruise AI 每个 Agent 最多拥有 10 个 Bot；主 Bot 计入数量。
20. 达到套餐上限后，前端“新建 Bot”按钮置灰、不可点击，hover 提示当前上限；创建确认动作也再次做前端数量校验。
21. 该数量限制不修改后台，直接调用创建接口、旧客户端或并发请求可能绕过；本期不承诺后端强一致。
22. 套餐升配并刷新当前 Pass 后按新上限允许继续创建；已有数量超过当前上限时保留全部 Bot 的查看、切换、配置和删除能力，只在前端禁止继续创建。

## 发布与观测

- 灰度/开关：使用运行时配置和后端 capability 双重开关；仅对通过镜像版本与 `--agent` capability 检测的实例开放。
- 日志/埋点/指标：重点观测创建成功率、Profile 创建失败率、切换错误率、命令路由失败率、能力不支持率和存量主 Bot 读取失败率。
- 回滚：关闭多 Bot 入口后，存量默认主 Bot 继续按 `main` 使用；已创建的命名 Profile 不自动删除，前端可临时隐藏普通 Bot 并保留后端恢复入口。
- 发布验证：至少选择一个存量单 Bot 实例、一个新建多 Bot 实例、一个旧 ACLI capability 实例和一个当前 spec 实例验证。

## 产品原型说明

- 目标页面/入口：`/agents` Agent 控制台当前 Bot 切换器、Bot 管理页、创建 Bot 弹窗、删除确认弹窗、配置页上下文区。
- 用户主路径：进入 Agent 控制台，打开 Bot 切换器，创建或克隆 Bot，切换到新 Bot，配置模型/Skills/通道，发起测试会话。
- 页面结构：实例级顶部信息保持稳定；Bot 切换器成为 Bot 级配置的上下文入口；Bot 管理页承载增删改查和异常修复。
- 关键组件：Bot 切换器、Bot 列表、创建方式选择、来源 Bot 选择、Profile 状态标识、删除确认、异常提示。
- 状态：加载、空态、创建中、可用、删除中、Profile 不可用、capability 不支持、权限不足。
- 主要操作：创建、克隆、切换、编辑名称与说明、删除、重试失败操作。
- 需要设计确认：Bot 切换器与实例信息的层级、默认主 Bot 命名、异常状态呈现、删除风险文案。
- 需要前端确认：所有配置页是否能稳定消费当前 Bot 上下文，切换时是否需要统一取消或刷新请求。

## 待确认问题

- 国内站灰度是否要求只开放给内部账号或白名单用户。
- 通道认证与 home channel 是否允许克隆，需要按 QQ、企微、Telegram、Slack、Discord 等渠道逐项确认；微信本期已按实例级唯一通道处理。
- 命名 `profile_id` 的生成规则是否由后端统一生成，是否允许用户重命名。
- 删除 Bot 时是否保留 Profile 备份，以及备份保留时长。

## 诊断中心补充（2026-09-10）

- 日志查询与导出属于当前 Bot，必须指定对应 Profile，导出文件名包含 Bot 名称。
- 模型重置暂仅支持只有主 Bot 的 Agent。存在其他 Bot 时禁用；后端无法确认完整 Profile 列表时同样拒绝，不能先轮换实例密钥。
- 重装、备份恢复属于整个 Agent，仅主 Bot 展示入口，确认文案明确影响所有 Bot。
- 维护进度、控制台和操作锁按实例共享；切换 Bot 不得使正在执行的任务重新变成可发起。
- 恢复固定到根数据目录，包含多 Profile 的备份须做隔离环境恢复验收。
- 本次不开放新建 Bot 入口，不实现主 Bot 更换，也不自动执行线上维护操作。
