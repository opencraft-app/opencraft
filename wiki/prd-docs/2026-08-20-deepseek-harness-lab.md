# LightVela 支持 DeepSeek Harness 实验室能力

## 基本信息

- 当前产品：LightVela Agent 控制台
- 需求状态：npm-only 六插件方案已通过本地验证与用户授权 Ubuntu 24.04 主机的首次安装、同快照重装和服务健康复验，等待北京 Hermes Sandbox 共存与 TAT 链路联调
- 创建日期：2026-08-20
- 最后更新时间：2026-08-21
- 需求类型：实验室能力 / 实例侧运行时集成
- 发布范围：国内站与国际站按 Provider 白名单区分
- 优先级：P1
- 关联 TAPD：1010132091137368681（https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091137368681）

## 需求背景

DeepSeek Harness（简称 dsh）是由 DeepSeek 开发的开源智能体框架，采用“一切皆插件”的 Cordis 架构。LightVela 希望在用户当前 Hermes Agent 实例中额外安装 dsh，并让用户从 Agent 控制台完成安装、运行状态查看、模型供应商配置和专属 WebUI 访问。

第一版已经形成“管理 > 实验室 > DeepSeek Harness”入口；本轮已将前端模拟状态替换为真实安装任务，并在已安装页面下方增加模型配置卡片。

WebUI 使用实例专属域名访问：国内站为 `https://${botId}.dsh.lightvela.tech`，国际站为 `https://${botId}.dsh.lightvela.site`。产品页面不展示任何静态 IP 地址；域名代理必须校验当前登录态和实例权限。

## 目标用户与场景

### 目标用户

- 想在现有 LightVela 实例中快速体验 DeepSeek Harness 的用户。
- 需要通过受控模型供应商接入 dsh 的国内站和国际站用户。
- 需要验证 dsh、SkillHub、TAT 访问链路和实例资源影响的产品、研发及测试人员。

### 典型场景

1. 用户在“管理 > 实验室 > DeepSeek Harness”进入能力页。
2. 未安装时，用户阅读简介与公告，点击“即刻安装体验”。
3. 安装期间，页面展示真实任务进度和 1-3 分钟等待提示。
4. 安装完成后，页面展示运行状态、“访问 WebUI”和“重启”。
5. 用户在页面下方选择受支持的模型供应商并填写 API Key；保存后，新配置在 dsh 下一次模型请求时生效。

## 产品目标

- 保持 DeepSeek Harness 为“实验室”下的二级能力，不占用一级导航。
- 将 dsh 以及 SkillHub、QQBot、微信、企业微信、Lark、钉钉六个 Web profile 插件安装到当前 Hermes 实例的同一运行环境中。
- 让用户在 LightVela 内完成受控 Provider 的凭据配置，无需进入 dsh 设置页。
- 保证 API Key 只写、不回显、不进入 URL、日志、TAPD 或前端持久化；通过 `debug/exec` 保存时使用实例一次性 RSA 公钥与 RSA-OAEP/SHA-256 加密，命令只携带密文。
- dsh 只监听实例回环地址，通过 TAT 或受鉴权的代理访问，不开放实例公网端口。

## 范围

### 本轮已实现

- 左侧导航“管理 > 实验室 > DeepSeek Harness”。
- 未安装、安装中、安装失败、已安装及重启状态全部通过现有 `debug/exec` 获取。
- 公告位于 DeepSeek Harness 卡片上方。
- 未安装态展示 Logo、标题后的 `Beta`、简介及简介下方的“即刻安装体验”。
- 安装中态展示实例侧任务进度、百分比和“安装大约需要 1-3 分钟”，刷新后可恢复轮询。
- 已安装态移除简介和静态地址，左侧展示状态，右侧展示“访问 WebUI”和“重启”。

- 已安装页面下方新增“模型配置”卡片。
- 支持多 Provider 逐个配置、覆盖修改和删除 API Key 配置；空配置时默认选中 DeepSeek。
- 已配置模型供应商持续展示，删除成功后重新进入添加下拉；删除失败时保留确认弹窗并允许重试。
- 国内站和国际站使用不同的 Provider 白名单。
- 安装动作通过 `debug/exec` 启动实例侧异步任务，由实例从 COS 全球加速地址下载完整单文件安装器；依赖快照由脚本在实例内从 npm 解析，不依赖 Hermes 镜像预置安装器或前端 payload。前端继续通过 `debug/exec` 轮询任务状态。
- 实例侧在安装任务开始时从 npm 解析 dsh、SkillHub 与五个渠道插件的 `latest` 精确版本和 integrity，以快照方式安装，并由 `agentuser` 身份长期运行。
- 安装器校验 dsh 与六个 Web profile 插件的快照版本、bundle 声明、配置组合、systemd 服务状态、回环监听和本地 HTTP 健康状态；页面运行态直接以 systemd 状态为准。
- 重启操作通过 `debug/exec` 下发固定的 `sudo systemctl restart deepseek-harness.service`。
- WebUI 使用当前 `botId` 生成分站实例域名；静态演示地址从产品逻辑中移除。

### 本阶段不包含

- 自定义 Provider、Base URL、API 协议或手工模型 ID。
- 环境变量、自定义凭据引用的创建、修改或清除。
- 在 LightVela 中设置具体模型 ID、推理等级、上下文窗口或最大输出长度。
- 安装时间、最近启动时间和完整异常诊断面板。
- “查看诊断”按钮。
- dsh 与 Hermes 之间的 Agent 调度或工具调用集成。
- 服务启动时静默升级依赖；版本解析只发生在用户发起的安装或重装任务中。

## 信息架构

左侧导航保持：

- 管理
  - 实验室
    - DeepSeek Harness

路由保持 `/agents/labs/deepseek-harness`。当当前页为 DeepSeek Harness 时，“实验室”保持展开，二级项保持选中。

## 页面与交互设计

### 公告

两条公告持续位于 DeepSeek Harness 主卡片上方：

- `当前DeepSeek Harness安装后，会与Hermes Agent运行在同一环境`
- `该能力尚处于抢先体验阶段，后续可能会有不兼容更新，敬请知悉`

### 未安装态

- 展示 Logo、`DeepSeek Harness`、紧随标题的 `Beta` 和简介。
- 简介：`DeepSeek Harness（简称：dsh）是由 DeepSeek 开发的一款采用一切皆插件架构的开源智能体框架（Agent Harness）。安装完成后即可通过 LightVela 访问专属 WebUI。`
- 主按钮“即刻安装体验”位于简介下方。
- 点击后创建一次幂等安装任务；重复点击不会创建第二个任务。

### 安装中态

- 保持 Logo、标题、Beta 和简介。
- 简介下方展示进度条、百分比和“请稍等片刻，安装大约需要 1-3 分钟”。
- 进度由实例侧任务阶段映射，不伪装成精确的包下载百分比：环境检查 10%、解析版本 20%、快照生成 28%、runtime 锁文件 35%、runtime 安装 48%、profile 锁文件 56%、六插件安装 68%、候选校验 75%、原子切换 85%、健康检查 95%、清理 99%、完成 100%。同一真实节点停留时，前端每 1.5 秒轮询成功后最多递增 1%，并始终低于下一真实节点；后端进度降低时页面不倒退。
- 安装完成后使用淡出、内容切换、淡入进入已安装态。
- 安装失败时恢复“重新安装”操作并展示简短错误；不增加“查看诊断”入口。

### 已安装态

- 主卡片展示 Logo、标题、Beta 和运行状态，不展示简介、静态地址、安装时间或最近启动时间。
- 右侧展示主按钮“访问 WebUI”和次按钮“重启”。
- “访问 WebUI”新窗口打开后端返回的受控访问地址。
- “重启”只重启系统级 `deepseek-harness.service`；成功后再次通过 systemd 状态命令确认运行状态。

### 模型配置卡片

模型配置卡片位于 DeepSeek Harness 主卡片下方，仅在 dsh 已安装时出现。

#### 空配置

- 标题：`模型配置`
- 说明：`选择模型供应商并填写 API Key，保存后即可在 DeepSeek Harness 中使用对应模型。`
- 字段一：`模型供应商`，下拉列表默认选中 DeepSeek。
- 字段二：`API Key`，密码输入框，不提供读取或显示已有密钥的能力。
- 主操作：`保存配置`。

#### 已配置

- 卡片上方持续展示已配置的模型供应商列表，每行包含供应商名称、绿色配置状态、编辑和删除操作。
- 同一时间只展开一个供应商的编辑区；编辑区位于对应行下方，API Key 输入框默认留空。
- 留空并保存表示保留原密钥，输入新值表示替换；保存成功后收起编辑区并刷新配置状态。
- 删除前展示确认弹窗，明确将移除该模型供应商在 DeepSeek Harness 中的配置；删除成功后该项从已配置列表移除，但仍保留在配置下拉中，便于重新配置。
- DeepSeek 是内置路由，删除时只清除 LightVela 写入的 `DEEPSEEK_API_KEY`，并回到未配置状态。
- 如果 DeepSeek 凭据来自环境变量或其他不可写来源，删除操作失败并提示“该凭据由运行环境管理，无法在此删除”，不伪装成未配置。
- 其他供应商删除时移除对应 profile，并只清理由 LightVela 派生且可写的 `<ROUTE>_API_KEY`；环境变量密钥、自定义引用和不可识别凭据不删除。
- 修改失败时保留当前输入并通过顶部居中 Toast 展示错误；删除失败时保留确认弹窗并展示轻量错误，允许用户重试。API Key 不回显、不持久化。

#### 配置模型供应商

- 已配置列表下方保留配置区，字段名称统一使用“模型供应商”，不再展示英文 `Provider`。
- 下拉列表始终展示当前站点完整白名单；首次进入默认选中 DeepSeek，已配置供应商仍可再次选择。
- 选择供应商、填写 API Key 后保存；如果该供应商已经配置，本次保存覆盖更新原配置。
- 点击“保存配置”后，按钮展示加载状态，并禁用供应商选择、密钥输入和其他配置操作，直到 `debug/exec` 返回成功或失败。
- 保存成功或失败使用全局顶部居中 Toast 提醒，并约 3 秒自动消失。成功后保留当前供应商并清空 API Key，失败后保留输入以便重试。

#### 第一版做减法

- 不展示“自定义设置”。
- 不允许自定义 Provider。
- 不展示 Base URL、模型目录、协议或推理等级。
- 仅支持白名单模型供应商的添加、API Key 修改和删除，不支持重命名或修改 Provider ID。

## Provider 白名单

### 国内站

| LightVela 标识 | DSH 路由 | 展示名称 | 空状态默认 |
| --- | --- | --- | --- |
| `deepseek` | `deepseek-official` | DeepSeek | 是 |
| `minimax-cn` | `minimax-cn` | MiniMax（中国） | 否 |
| `moonshotai-cn` | `moonshotai-cn` | Moonshot AI（中国） | 否 |
| `qwen-token-plan-cn` | `qwen-token-plan-cn` | Qwen Token Plan（中国） | 否 |
| `openrouter` | `openrouter` | OpenRouter | 否 |

### 国际站

| LightVela 标识 | DSH 路由 | 展示名称 | 空状态默认 |
| --- | --- | --- | --- |
| `deepseek` | `deepseek-official` | DeepSeek | 是 |
| `minimax` | `minimax` | MiniMax | 否 |
| `minimax-cn` | `minimax-cn` | MiniMax（中国） | 否 |
| `moonshotai` | `moonshotai` | Moonshot AI | 否 |
| `moonshotai-cn` | `moonshotai-cn` | Moonshot AI（中国） | 否 |
| `openrouter` | `openrouter` | OpenRouter | 否 |
| `anthropic` | `anthropic` | Anthropic | 否 |
| `groq` | `groq` | Groq | 否 |
| `openai` | `openai` | OpenAI | 否 |

说明：用户给出的清单是 Provider ID。DSH 的默认模型设置需要 `provider + model` 两个值，因此本阶段只配置 Provider 和凭据；“DeepSeek 默认选中”只表示空表单的 Provider 默认值，不自动修改 dsh 的具体默认模型。若产品要求直接选择具体模型，需要增加 `llm.models` 查询、模型 ID 下拉和默认模型写入规则。

## 模型配置实现设计

### 采用方案

页面复用 `BotRepository.execDebugCommand`，调用实例侧固定 Provider helper。前端不直接访问 DSH 配置 RPC；helper 在 `agentuser` 环境中访问 `127.0.0.1:3080`，只开放固定 RPC：

- `llm.providers`：校验 Provider 是否由当前固定版本的 dsh 提供。
- `settings.describe`：获取脱敏 Provider 配置和 revision。
- `credentials.describe`：只读取 `configured/source/writable`，不读取值。
- `settings.mutate`：写入白名单 Provider profile，并携带 `expectedRevision`。
- `credentials.set`：将 API Key 写入独立凭据存储。
- `credentials.unset`：删除时仅清理能够确认由 LightVela 创建且当前可写的凭据。

helper 固定使用本地 `Host` 和 `Origin`，目标端口固定为 3080。保存时先经 `debug/exec` 在 `agentuser` 私有目录生成一次性 RSA-4096 密钥并返回公钥，前端使用 RSA-OAEP/SHA-256 加密 API Key；后续命令只携带密文，在实例内通过 OpenSSL 解密并管道写入 helper stdin。一次性私钥在命令退出时删除，超过 15 分钟的遗留私钥在下一次保存前清理。前端不得将 API Key 写入埋点、缓存、localStorage 或错误详情。

### 写入顺序

1. 校验站点白名单与 DSH Provider 目录。
2. DeepSeek 原生路由只写 `DEEPSEEK_API_KEY` 凭据，不重复创建 Provider profile。
3. 其他目录 Provider 先通过 `settings.mutate` 创建或更新 profile，并记录派生的 `<ROUTE>_API_KEY` 引用。
4. profile 写入成功后调用 `credentials.set` 写入密钥。
5. 重新调用 describe 接口，确认 Provider active 且凭据 configured。
6. `settings-conflict` 时刷新 revision 并提示用户重试，不覆盖并发变更。

### 删除顺序

1. 再次读取 Provider profile、credential reference、configured/source/writable 与 settings revision。
2. DeepSeek 仅对可写的 `DEEPSEEK_API_KEY` 调用 `credentials.unset`，不删除内置路由；凭据已配置但不可写时返回明确错误。
3. 其他供应商仅当 profile 使用 LightVela 派生的 `<ROUTE>_API_KEY` 且凭据可写时，先调用 `credentials.unset`；环境变量、自定义引用和不可识别凭据保持不变。
4. 对其他供应商通过 `settings.mutate` 的 `unset` 操作删除完整 profile，并携带 `expectedRevision`。
5. 两步均为幂等操作；部分失败时保持删除确认弹窗，重新读取状态后允许重试。

DSH 官方实现将密钥以只写方式保存到 `$DSH_HOME/.credentials.yaml`，设置文件只保存凭据引用。模型配置在下一次请求时生效，不需要重启 dsh。

### 未采用方案

- 新增 DSH 专用 ctl 接口：类型明确，但重复现有 `debug/exec` 通道并扩大后端维护面，不采用。
- 通过命令直接改写 YAML：容易覆盖 DSH 并发配置，不采用；实例 helper 仍调用 DSH 官方 RPC。
- 只引导用户进入 DSH WebUI 配置：开发量小，但无法满足 LightVela 页面内直接配置，不采用。

## 安装方案

### 调研基线

- DSH 官方启动命令为 `npx @deepseek-ai/dsh web`，默认监听 `127.0.0.1:3080`；本方案请求 `@deepseek-ai/dsh@latest`，但在单次安装任务内固定任务开始时解析出的精确版本。
- DSH runtime 与 `web` profile 在任务开始时通过 npm registry 解析 `version`、`dist.integrity` 与 HTTPS tarball，并生成 schema v3 快照。实例安装使用固定的 `pnpm@10.33.0`，先生成 lockfile、再执行 `--frozen-lockfile`；若实例全局 pnpm 缺失或版本不符，先在候选目录引导固定版本，校验后原子持久化到 root-owned `/opt/lightvela/dsh/tooling/pnpm-10.33.0` 并写入服务 PATH。两份 `.pnpmfile.cjs` 将整个 `@deepseek-ai/dsh-*` 依赖族保持在本次解析出的 DSH 版本。
- `web` profile 采用 DSH 官方 `nodeLinker: hoisted`、`autoInstallPeers: false` workspace 约定，只直接安装 SkillHub 与五个渠道插件；base/web-app bundles 由 runtime fallback 提供，不在 profile 中重复安装整套 DSH peer 依赖。
- DSH `web` profile 请求 `@cocofhu/skillhub@latest`、`deepseek-harness-qqbot@latest`、`deepseek-harness-weixin@latest`、`deepseek-harness-wecom@latest`、`deepseek-harness-lark@latest`、`deepseek-harness-dingtalk@latest`；六个插件全量成功才算安装完成。
- 六个 profile 插件全部从 npm registry 获取，精确版本、tarball 和 integrity 进入任务快照并通过 lockfile integrity 复核；实例安装不再依赖 GitHub，不安装 `dsh-auth`。
- npm/pnpm 解析与安装配置有限重试和单次总超时 300 秒；不执行 `pnpm approve-builds --all`。构建脚本只允许 `@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`，明确忽略无需运行的 `@google/genai`、`protobufjs` 安装脚本。
- Hermes CVM 镜像使用 `agentuser` 和 Node 22；系统服务通过 `User=agentuser` 降权运行，不依赖 user linger。
- 最小 Ubuntu 安装 dsh 的原生依赖可能需要 `build-essential`，安装前必须检查。

### 方案比较

1. **COS 单文件脚本 + npm 快照 + 独立版本目录 + systemd 系统服务（采用）**：前端经 `debug/exec` 启动实例下载并校验 COS 上的完整安装脚本，安装器解析一次 `latest` 后将精确快照安装到 `/opt/lightvela/dsh/releases/<snapshot-id>-<task-prefix>`，通过 `/opt/lightvela/dsh/current` 切换；系统服务使用 `User=agentuser`。支持存量实例直接安装、版本审计、同快照复用和快速回滚，DSH 依赖不写入 Hermes runtime 包树。
2. **镜像内离线预置 runtime 与插件包体**：实例激活最稳定，但每次 DSH 升级都要求重建镜像；首版先不采用。
3. **独立 COS 离线 runtime bundle**：可以进一步减少 npm 网络依赖，但需要额外的包体构建和发布链路；首版不采用。
4. **systemd 每次直接运行未固定版本的 npx**：会把启动稳定性绑定到 npm 网络和 `latest`，不采用。

### 实例目录与服务

- 运行用户：`agentuser`，与 Hermes 位于同一 OS 用户环境。
- DSH_HOME：`/home/agentuser/.dsh`，目录权限 `0700`。
- 安装目录：`/opt/lightvela/dsh/releases/<snapshot-id>-<task-prefix>`。
- 当前版本链接：`/opt/lightvela/dsh/current`。
- 系统服务：`/etc/systemd/system/deepseek-harness.service`，运行身份为 `agentuser:agentuser`。
- 工作目录：`/home/agentuser`。
- 启动参数：`dsh web --host 127.0.0.1 --port 3080`。当前固定版本不支持 `--no-open`。
- 服务策略：`Restart=always`、`RestartSec=5`、`UMask=0077`，输出进入 journald。
- 网络策略：只监听回环地址，不监听 `0.0.0.0`，实例安全组不开放 3080。

### 安装任务

不新增 DeepSeek Harness 专用后端接口。状态、安装、任务查询、重启和 Provider 配置均复用 `POST /v1/instances/{id}/debug/exec`。前端只生成固定模板命令，任务 ID 与 Provider 均在前端和实例 helper 两侧校验。

点击安装后，前端通过 `debug/exec` 启动 `sudo systemd-run`，由实例从 `https://vela-installer-1388575217.cos.accelerate.myqcloud.com/dsh/install-deepseek-harness.sh` 下载完整单文件安装器。wrapper 使用 HTTPS/TLS 1.2、5 次有限重试和有界超时，下载到 root 私有临时目录后检查 1 KiB 至 1 MiB 的文件大小、Bash shebang 与 `bash -n`，通过后再执行，不使用 `curl | bash`。wrapper 在下载前原子写入 `pending`，准备失败或安装器未写终态便退出时原子覆盖为 `failed`；启动响应不确定时使用只读命令延迟检查任务文件和 systemd unit。临时下载目录在任务结束后自动清理。包坐标、目录、用户和端口由安装器固定，精确版本由每次任务开始时的 npm metadata 决定：

1. 使用 `flock` 获取实例安装锁，拒绝同实例并发安装。
2. 检查实例归属、运行状态、架构、磁盘、Node >=22、固定 pnpm、编译工具和 3080 端口占用；必要时在候选目录引导固定 pnpm。
3. 在任务临时目录按有限重试策略解析 DSH、SkillHub 和五渠道 npm `latest` 元数据，校验版本、HTTPS tarball 与 `dist.integrity`，生成不含时间漂移的内容快照 ID。
4. 分别为 DSH runtime 和 `web` profile 写入精确版本 package，先生成 lockfile、再执行 `pnpm install --frozen-lockfile`；要求每个 npm integrity 都出现在对应 lockfile，缺失或不匹配立即失败。
5. 校验六个插件准确包名/快照版本与 `dsh.bundle` 声明，确认全部进入 `dsh.profile.bundles`；执行 `dsh plugin --profile web list --depth 0 --json` 和 `dsh --profile web --dump-config`。
6. 正式切换前比较旧 profile 指纹；出现并发修改或非 LightVela 管理插件时保持原状并失败。
7. 备份旧 runtime、完整 `web` profile 和旧 unit 后原子切换，执行 daemon-reload、enable 和明确 restart。
8. 校验 dsh 版本、六插件版本和服务 active，等待回环 HTTP 200 后再确认只监听 `127.0.0.1:3080`；任何失败恢复 runtime、完整 profile、固定 pnpm tooling、unit 和旧服务，首次安装失败清理临时目录及半成品。原 `web/cordis.patch.yml` 以及 `$DSH_HOME` 下 credentials、settings、storage 均保留。

### 为什么不照搬参考机公网配置

参考机已经验证 systemd、回环监听和 Caddy 代理可以运行。参考机的代理通过改写 `Host/Origin` 访问 DSH 的受限配置 API；如果外层缺少可靠鉴权，该方式会扩大文件读写和命令执行面的暴露范围。LightVela 方案只复用“回环服务 + 进程守护”的事实，不复用公网 IP、路径口令或无鉴权的配置 API 暴露方式。

## WebUI 访问设计

- 前端从现有 `GET /v1/instances` 结果取得当前 `Bot.id`，无需新增 WebUI URL 查询接口。
- 国内站“访问 WebUI”跳转 `https://${botId}.dsh.lightvela.tech`；国际站跳转 `https://${botId}.dsh.lightvela.site`，均在新标签页打开且不展示 URL 文本。
- 域名代理必须校验 LightVela 登录态、实例归属和短期访问会话，再访问实例回环端口 `127.0.0.1:3080`。
- 代理不得把腾讯云长期凭据、TAT 会话凭据或实例内部端口暴露给未授权用户。

## 状态定义

| 状态 | 页面表达 | 主要操作 |
| --- | --- | --- |
| 未安装 | 安装引导卡片 | 即刻安装体验 |
| 安装中 | 真实阶段映射进度与 1-3 分钟提示 | 禁止重复提交 |
| 安装失败 | 简短错误并恢复安装入口 | 重新安装 |
| 已安装 / 运行中 | 运行卡片 + 模型配置卡片 | 访问 WebUI、重启、配置 Provider |
| 已安装 / 未运行 | 状态提示 + 模型配置卡片 | 访问 WebUI、重启、配置 Provider |
| 重启中 | 保持卡片尺寸，按钮 loading | 禁止重复重启 |

安装超过 3 分钟时继续展示当前阶段和“安装时间可能因网络环境延长”，不自动判定失败；实例侧任务由 systemd 托管。

## 方案风险检查

1. **Provider 与具体模型不是同一配置对象。** 当前清单只能确定 Provider。直接修改 dsh 默认模型还缺少具体 model ID，需求确认前不能据此实现“默认模型”。
2. **通用 Ubuntu 冒烟不能替代 Hermes Sandbox 联调。** 已验证 SkillHub 加五个渠道插件的 npm-only 组合、systemd、回环 HTTP、同快照重装、服务重启和 release 保留；Hermes 共存资源占用、TAT 实时下发及实例域名代理仍需在北京 Sandbox 验证。
3. **pnpm 必须保持一致且跨任务存活。** 冻结清单以 `pnpm@10.33.0` 生成和安装；实例版本不符时使用 root-owned 固定 tooling，不得临时升级全局 pnpm，也不得依赖会随任务清理的临时 PATH。
4. **目标镜像前置条件必须满足。** 安装器要求实例已存在 `agentuser` 与 Node >=22；通用全新 Ubuntu 验证时需先补齐这些 Hermes 镜像前置条件。
5. **DSH 配置 API 属于高权限面。** 前端不直接暴露该能力；实例 helper 仅调用固定的 Provider 与凭据 RPC，WebUI 域名代理必须在访问回环服务前验证实例归属。
6. **冻结清单与用户自装插件存在边界。** 安装器在切换前比较 profile 指纹，并对未知依赖或 bundle 安全失败；只有确认未发生并发修改后才允许以完整备份执行原子回滚。

自检结论：交互、命令通道和安装架构已完成本地验证；npm-only 六插件方案已在通用 Ubuntu 24.04 主机完成首次安装与同快照重装。远端现存未知插件 `dsh-remote` 时安装器会在修改服务前安全失败，清理并备份测试 profile 后完成受管组合验证；因此本轮不等同于对任意用户自装插件的无损迁移证明。北京 Hermes Sandbox 共存与 TAT 链路仍待验证。

## 安全与非功能要求

- API Key 只能从用户输入流向 DSH `credentials.set`，响应和状态中不包含密钥值；删除只调用窄范围的 `credentials.unset`。
- `$DSH_HOME/.credentials.yaml`、settings 和 storage 文件权限保持 `0600`，DSH_HOME 为 `0700`。
- `debug/exec` 命令不得接受前端传入的包名、版本、路径、用户、端口或任意 shell 片段；Provider 必须命中固定白名单。
- 安装与重启操作必须校验当前用户拥有目标实例。
- dsh 与 Hermes 共享 OS 用户和主机资源，因此 dsh 具备读取用户工作区和执行命令的能力；公告必须持续展示这一事实。
- 记录安装阶段、版本、耗时、退出码和健康检查结果；日志不得记录模型配置命令正文、请求体或凭据。
- 安装任务可重复执行并收敛到相同版本、插件和服务配置。
- 页面需适配桌面端和移动端，进度、表单、模型供应商行和按钮不重叠、不溢出。
- 国内站和国际站均走 i18n；Provider ID 不翻译，展示名称可本地化。

## 验收标准

1. 原有“管理 > 实验室 > DeepSeek Harness”入口和三态布局保持不变。
2. 安装动作使用真实异步任务，同实例重复点击不会创建并发安装。
3. 安装完成后 dsh 与 SkillHub、QQBot、微信、企业微信、Lark、钉钉六个插件均等于任务快照版本并进入 `web` profile；配置组合检查通过，系统级 `deepseek-harness.service` active，`127.0.0.1:3080` 返回 HTTP 200。
4. 实例公网不监听 3080，安全组不新增 3080 入站规则。
5. 已安装页面下方出现模型配置卡片；无配置时 DeepSeek 默认选中。
6. 国内站只展示 `deepseek`、`minimax-cn`、`moonshotai-cn`、`qwen-token-plan-cn`、`openrouter`。
7. 国际站只展示 `deepseek`、`minimax`、`minimax-cn`、`moonshotai`、`moonshotai-cn`、`openrouter`、`anthropic`、`groq`、`openai`。
8. 用户可以配置多个白名单模型供应商；下拉始终展示完整白名单，重复保存同一供应商会覆盖更新；已配置项持续展示，并支持展开修改 API Key。
9. 删除操作有二次确认；DeepSeek 只清理 LightVela 写入的密钥，其他供应商删除 profile，并且只清理由 LightVela 派生且可写的凭据；环境管理的 DeepSeek 凭据拒绝删除并说明原因。
10. 删除成功后供应商从已配置列表移除，但仍保留在配置下拉；部分失败可原位重试。
11. API Key 不回显，不进入日志、URL、浏览器持久化或 TAPD；`debug/exec` 命令只携带 RSA-OAEP/SHA-256 密文，实例内解密后通过 stdin 交给 helper。
12. 模型供应商配置在下一次 dsh 模型请求生效，无需重启服务。
13. “访问 WebUI”使用受当前登录态和实例权限保护的地址，页面不展示静态 IP。
14. 安装失败只展示轻量错误和重新安装，不增加“查看诊断”按钮。
15. 保存配置期间展示加载状态并锁定配置交互；成功或失败通过顶部居中、自动消失的 Toast 提醒，成功清空密钥，失败保留输入。

## 发布与观测

- 联调不要求先刷新 Hermes CVM 镜像；安装器由存量实例直接从 COS 获取，Provider helper 随当前前端版本实时下发，因此可直接进入北京 Sandbox 验证。本需求没有新增 ctl 或 service-gateway 路由。
- 先在北京 Sandbox 选择少量实例验证安装、重装、重启、Provider 配置和 WebUI 访问。
- 观测安装成功率、各阶段耗时、服务存活率、回环 HTTP 健康、重启次数、Provider 保存成功率和 TAT 错误码。
- 国内站验证通过后再开放国际站白名单。
- dsh 与插件仅在用户发起安装或重装时解析 npm `latest`；服务启动不会自动升级。发布新 npm 版本前仍需完成组合兼容性测试。
- 回滚时关闭实验室真实安装开关；已安装实例可保留服务，也可通过独立卸载方案处理，本需求不自动删除用户数据。

## 事实来源

- DeepSeek Harness：`https://github.com/deepseek-ai/deepseek-harness`
- DSH Provider 配置：`https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md`
- DSH 模型设置实现：`https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-settings-models`
- SkillHub：`https://www.npmjs.com/package/@cocofhu/skillhub`
- 目标机只读检查：Ubuntu 24.04、Node 24、DSH 0.1.0-rc.6、systemd 守护、回环 3080、Caddy 代理；未修改服务或配置。

## 已确认决策

1. 本轮“模型选择”按 Provider + API Key 实现，不提供具体 model ID 选择。
2. DeepSeek 产品标识 `deepseek` 映射到 DSH 原生路由 `deepseek-official`。
3. DSH、SkillHub 与五个渠道插件采用 npm `@latest` 入口，并在每次安装任务开始时冻结为精确版本和 integrity；真实开放前完成完整组合冒烟。
4. 第一批真实安装只开放北京 Sandbox；国内站和国际站代码及 Provider 白名单同时完成，正式环境暂不开放真实安装。
5. “访问 WebUI”使用当前 `Bot.id` 生成分站域名：国内站 `https://${botId}.dsh.lightvela.tech`，国际站 `https://${botId}.dsh.lightvela.site`。
6. 安装、状态、重启和模型配置全部复用现有 `debug/exec`，不新增 DeepSeek Harness 专用后端接口。
7. 模型配置采用“已配置列表 + 单项展开编辑区 + 完整白名单配置区”；支持覆盖修改和删除，删除语义遵循 DSH WebUI 的窄范围凭据清理原则。
8. 配置结果复用全局顶部居中 Toast；保存期间等待 `debug/exec` 返回并锁定配置交互。
9. DSH runtime 与六个 profile 插件采用 npm 在线快照安装，有限重试耗尽或任一插件验证失败时整体失败并恢复旧版本；实例安装不依赖 GitHub，不安装 `dsh-auth`。
