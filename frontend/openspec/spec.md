# DeepSeek Harness 真实接入 Spec

**最后更新：** 2026-08-27
**状态：** npm-only 六插件方案已通过本地验证与用户授权 Ubuntu 24.04 主机复验；仓库安装器已与 COS 对象逐字节对齐并通过发布一致性门禁；北京 Hermes Sandbox 与 TAT 链路仍待复验

## 1. 统一命令通道

DeepSeek Harness 不新增专用后端接口。页面所有实例操作统一调用现有 `POST /v1/instances/{id}/debug/exec`，由现有 Repository、实例归属和 active pass 校验链路承接。

| 动作 | 固定命令 |
| --- | --- |
| 状态 | `sudo -n systemctl status deepseek-harness.service --no-pager`、`NRestarts` 与三秒 `http://127.0.0.1:3080/` 探测；sudo 或 `curl` 不可用、探测命令异常时整体失败，不回落为未安装或误报服务异常 |
| 安装 | 下发固定 `sudo -n systemd-run` 命令，由实例经 HTTPS 从 COS 全球加速地址下载单文件安装器，校验构建期固定 SHA-256 后执行；任务 ID 由前端生成并校验 |
| 修复 | 用户二次确认后复用安装任务，固定传入 `repair` 操作类型；wrapper 隔离完整旧 Web profile，只保留 `cordis.patch.yml` 作为干净 profile 输入，再调用同一安装器 `install` action；失败时恢复旧 profile 和服务，成功后清理备份 |
| 任务查询 | `sudo -n cat /var/lib/lightvela/dsh/installations/<validated-id>.json` |
| 重启 | `sudo -n systemctl restart deepseek-harness.service`，先校验命令退出码，再查询组合健康状态 |
| 模型供应商列表 | 以 `agentuser` 身份执行前端内联的固定 Provider helper：`providers --region <cn|global>` |
| 模型供应商配置 | 首个命令在实例生成一次性 RSA 密钥并返回公钥；浏览器用 RSA-OAEP/SHA-256 加密 API Key，第二个命令只携带密文并在实例解密到 helper stdin；Provider ID 必须命中固定白名单 |
| 模型供应商删除 | 以 `agentuser` 身份执行同一内联 helper：`remove-provider --provider <allowlisted-id>` |

## 2. COS 单文件安装器

- 固定运行用户 `agentuser`、`DSH_HOME=/home/agentuser/.dsh`、端口 `127.0.0.1:3080`。
- DSH、SkillHub 与五个渠道插件均请求 npm `@latest`，这是产品明确接受的跨任务可复现性取舍；安装任务开始时一次性解析并校验精确版本、`dist.integrity` 和 HTTPS tarball，将结果写入 root-owned 安装快照，保证单次任务内部不漂移；不安装 `dsh-auth`。
- Hermes 镜像不预置 DSH 安装器、Provider helper 或冻结清单。安装器固定从 `https://vela-installer-1388575217.cos.accelerate.myqcloud.com/dsh/install-deepseek-harness.sh` 获取；构建时根据仓库内 `images/helpers/install-deepseek-harness.sh` 生成可信 SHA-256，Provider helper 继续使用独立内联资源。
- 用户点击安装后，前端只通过一次 `debug/exec` 请求启动 `systemd-run`。wrapper 使用 HTTPS/TLS 1.2、5 次有限重试、连接和总超时下载脚本到 root 私有临时目录，并依次校验文件大小为 1 KiB 至 1 MiB、Bash shebang、`bash -n` 和可信 SHA-256；全部通过后才执行，不使用 `curl | bash`。校验失败写入 `verify_installer` 失败状态，任务结束自动清理下载目录。
- `.ci/hermes-image.yml` 在构建前调用独立校验器下载 COS 对象，执行 Bash 语法检查并与仓库安装器逐字节比较；内容或 SHA-256 不一致时立即失败。更新仓库安装器后，必须先覆盖 COS 对象并通过该门禁，不能只更新前端生成哈希。
- `systemd-run` wrapper 在下载前原子写入 `pending` 任务 JSON；下载、校验或安装器尚未写终态便退出时原子覆盖为 `failed`，避免轮询只得到文件不存在或永久停在 pending。启动请求结果不确定时，前端通过只读命令对任务文件与 systemd unit 延迟重试对账；对账通道同样不可用时保留 task ID，明确确认任务未启动后向用户返回原始错误。
- DSH runtime 与 `web` profile 根据本次安装快照生成精确版本的 `package.json`、`.pnpmfile.cjs` 和 `pnpm-lock.yaml`；hook 将整个 `@deepseek-ai/dsh-*` 依赖族保持在本次解析出的 DSH 版本，避免安装过程中混装其他版本。候选目录先执行 `--lockfile-only`，再执行 `pnpm install --frozen-lockfile`。
- 若实例全局 pnpm 不存在或不是 `10.33.0`，安装任务先在候选目录引导固定版本，校验通过后原子持久化到 root-owned `/opt/lightvela/dsh/tooling/pnpm-10.33.0`；服务通过固定 PATH 使用该版本，任务目录清理后仍可执行插件管理。不得替换或升级实例全局 pnpm。
- `web` profile 复用 DSH 官方 `nodeLinker: hoisted`、`autoInstallPeers: false` workspace 约定，只直接安装 SkillHub 与五个渠道插件；base/web-app bundles 由快照 runtime 的 profile fallback 提供。
- 六个 profile 插件全部使用 npm registry；解析和安装配置有限重试与总超时。所有包的精确版本、tarball 和 integrity 进入 root-owned `manifest.json`，任一 metadata 或 lockfile integrity 校验失败不得进入切换阶段。
- 插件请求来源如下；“版本”均表示安装任务开始时由 `@latest` 解析出的精确版本：

| 插件 | 请求版本 | 来源与校验 |
| --- | --- | --- |
| SkillHub | `@cocofhu/skillhub@latest` | npm tarball + `dist.integrity` + lockfile integrity |
| QQBot | `deepseek-harness-qqbot@latest` | npm tarball + `dist.integrity` + lockfile integrity |
| 微信 | `deepseek-harness-weixin@latest` | npm tarball + `dist.integrity` + lockfile integrity |
| 企业微信 | `deepseek-harness-wecom@latest` | npm tarball + `dist.integrity` + lockfile integrity |
| Lark | `deepseek-harness-lark@latest` | npm tarball + `dist.integrity` + lockfile integrity |
| 钉钉 | `deepseek-harness-dingtalk@latest` | npm tarball + `dist.integrity` + lockfile integrity |

- 下载最多尝试 5 次，单次连接超时 10 秒、单个请求总超时 300 秒，并使用有上限的退避。禁止执行宽泛的 `pnpm approve-builds --all`；构建脚本只允许 `@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`，明确忽略无需运行的 `@google/genai`、`protobufjs` 安装脚本。
- DSH 版本目录 `/opt/lightvela/dsh/releases/<snapshot-id>-<task-prefix>`，当前链接 `/opt/lightvela/dsh/current`；相同快照复用已有 runtime，成功后仅保留当前与一个上一版本。
- 系统服务文件 `/etc/systemd/system/deepseek-harness.service`，通过 `User=agentuser`、`Group=agentuser` 降权运行，启动命令固定为 `dsh web --host 127.0.0.1 --port 3080`，设置 `Restart=always`、`RestartSec=5`、`UMask=0077`。
- SkillHub、QQBot、微信、企业微信、Lark 和钉钉全部安装到 DSH `web` profile。六个插件必须同时满足快照包名/版本、声明 `dsh.bundle`、进入 `dsh.profile.bundles`、出现在 `dsh plugin --profile web list --depth 0 --json`，且 `dsh --profile web --dump-config` 成功；任一失败都将整个任务判定失败。
- 安装使用 `flock`，状态以 root-owned JSON 原子写入 `/var/lib/lightvela/dsh/installations/`。下载、冻结安装和静态检查先在任务临时目录完成；正式切换前再次比较旧 profile 指纹，检测到并发修改则不覆盖。
- 取得全局安装锁后，安装器清理严格位于 LightVela 受管根目录且名称匹配 `dshi-[0-9a-f]{32}` 的遗留 runtime/profile/tooling/work staging、profile/unit backup 与 unit candidate；非受管名称和目录保持不变。
- 切换前备份旧 runtime、完整旧 `web` profile、固定 pnpm tooling 和旧 unit；切换后明确 enable、restart，先等待回环 HTTP 200，再确认只监听 `127.0.0.1:3080`。失败时恢复备份并重启旧服务；首次安装失败清理临时目录和半成品。
- 重装或升级时保留原 `web/cordis.patch.yml`；`$DSH_HOME` 下的 credentials、settings、storage 和其他用户数据不参与替换或清理。成功或失败后删除任务工作目录，但保留安装任务 JSON 状态记录。
- 已经收敛到相同 npm 快照、六插件和服务配置时幂等复用 runtime。普通安装保留现有 profile、额外依赖、bundle 和自定义文件。用户确认“修复”后，wrapper 隔离完整旧 profile，只将 `web/cordis.patch.yml` 放入干净 profile，再调用安装器；模型凭据、DSH settings 与 storage 保留，用户自行安装的插件及其他 profile 文件移除。任务失败时恢复完整旧 profile 和原服务状态。

## 3. 模型供应商配置 helper

前端不再直连 DSH 配置 RPC。`configure-deepseek-harness.py` 在构建时编码为固定前端资源，每次操作经 `debug/exec` 以内联 Python 脚本实时执行，不落到实例公共路径。helper 只允许调用 `llm.providers`、`settings.describe`、`credentials.describe`、`settings.mutate`、`credentials.set`、`credentials.unset`，并校验 RPC envelope 与 `result.ok`。非 DeepSeek Provider 在对应 settings path 写入派生的 `<ROUTE>_API_KEY` 引用，DeepSeek 直接写 `DEEPSEEK_API_KEY`。helper 只从 stdin 读取密钥，响应不包含密钥值。

保存密钥分两次调用同一 `debug/exec`：第一次在 `agentuser` 私有目录生成一次性 RSA-4096 密钥并仅返回 DER 公钥，同时通过 `sudo -n systemd-run --on-active=15m` 建立一次性清理 timer；timer 创建失败则首条命令立即删除私钥并失败。浏览器使用 RSA-OAEP/SHA-256 加密用户输入；第二次命令只携带 base64 密文，由 OpenSSL 在实例内解密并通过管道写入 helper stdin。私钥权限为 0600，第二次命令退出时主动删除；浏览器中断时最迟由 timer 清理，旧版本遗留且已满 15 分钟的私钥在下一次保存前再次清理。API Key 明文不会进入命令正文、进程参数、响应或浏览器持久化。

删除遵循 DSH WebUI 的窄范围清理：DeepSeek 只清除可写的 `DEEPSEEK_API_KEY`，凭据已配置但来自不可写环境时明确拒绝删除；其他供应商删除 profile，且仅在 profile 引用 LightVela 派生的 `<ROUTE>_API_KEY` 并确认凭据可写时清除凭据。环境变量密钥、自定义引用与不可识别凭据保持不变。凭据清理和 profile `unset` 均为幂等操作，部分失败允许原位重试。

## 4. 页面状态

- 状态查询 loading、error、未安装、安装中、安装失败、运行中、运行异常、未运行完整覆盖。systemd active 但存在自动重启记录或回环 HTTP 不可达时为运行异常。
- dsh 已安装即展示模型配置卡片和 WebUI/重启操作；运行状态如实展示，不增加诊断分支。
- 已安装卡片在“重启”右侧展示“修复”。点击后显示 `修复 DeepSeek Harness` 确认弹窗并准确说明 WebUI 暂时不可用、数据保留范围和插件重置范围；取消、关闭或 Esc 均不启动任务。
- 确认修复后显示 `正在修复 DeepSeek Harness` 和现有任务进度。任务类型与 task ID 一并持久化，刷新后优先恢复修复轮询；修复失败且安装器已回滚时重新读取真实状态，旧服务可用则保留已安装页面并展示错误。
- 模型配置卡片上方持续展示已配置模型供应商，每行提供编辑和删除；同一时间只展开一个编辑区。
- 配置区始终展示当前站点完整白名单，字段标签使用“模型供应商”；重复保存同一 Provider 通过原固定命令覆盖更新。
- API Key 输入始终为空；编辑时留空表示保留已有密钥。
- 保存请求未完成时，按钮显示“保存中...”并禁用供应商选择、密钥输入和其他配置操作；同步 ref 锁在 React 状态提交前即占位，连续点击只允许一条保存命令进入执行链路。
- 保存成功或失败通过顶部居中 Toast 反馈并自动消失；成功时保留当前 Provider 选择并清空密钥，失败时保留密钥以便重试。
- 删除前二次确认；成功后刷新列表，失败时保留弹窗并允许重试。
- WebUI 使用当前 `Bot.id` 生成实例专属外链：国内站 `https://${botId}.dsh.lightvela.tech`，国际站 `https://${botId}.dsh.lightvela.site`；链接在新标签页打开，不展示静态 IP。
- 主卡片 Logo 使用仓库内 `/assets/deepseek-harness-logo.svg`，不依赖外部图片域名。

---

# Agent 人设 Markdown 上传 Spec

**最后更新：** 2026-08-23
**实现形态：** 国内站前端本地文件读取与编辑，复用现有 Hermes `SOUL.md` 写入链路。

## 1. 用户流程

1. 用户进入已有 Agent 的 `/agents/persona/` 页面。
2. 用户点击“上传人设文件”，先打开初始上传弹窗，不直接唤起系统文件选择器。
3. 用户在弹窗内点击“选择文件”，再选择一个本地 `.md` 文件。
4. 浏览器读取原始字节并执行硬校验；失败时在弹窗内展示原因，不进入可注入状态。
5. 校验通过后在同一弹窗切换到编辑态，展示文件名、实际 UTF-8 字节数、可编辑 Markdown 和软结构提示。
6. 用户点击“注入人设”时再次校验编辑文本；若当前已有 `SOUL.md`，先确认覆盖，否则直接注入。
7. 前端标准化元数据并通过现有 Agent 执行通道写入 `SOUL.md`。
8. 成功后展示“已注入：自定义人设 · <名称>”，并提示发送 `/new`；失败时保留编辑内容以便重试。
9. 自定义人设状态后提供编辑和下载图标；两者按需读取当前 Agent 实际 `SOUL.md`，分别用于安全修改或直接下载。

## 2. 文件校验

### 2.1 硬校验

| 规则 | 定义 | 失败结果 |
| --- | --- | --- |
| 扩展名 | 文件名最后一个扩展名大小写不敏感等于 `.md` | 阻止进入编辑态。 |
| 大小 | 原始文件与编辑后文本均不超过 `20 * 1024` UTF-8 字节 | 阻止注入。 |
| 编码 | 使用 `TextDecoder("utf-8", { fatal: true })` 解码 | 无效字节序列阻止。 |
| 读取 | 浏览器 `arrayBuffer()` 成功返回 | 读取失败提示重新选择。 |
| 空内容 | 去除 UTF-8 BOM 后，`trim()` 不能为空 | 阻止注入。 |
| 控制字符 | 允许制表、换行、回车；拒绝 NUL 与其他 C0/C1 控制字符 | 阻止注入。 |

- 大小判断不得使用 JavaScript 字符长度代替 UTF-8 字节数。
- 选择文件时校验原始 `ArrayBuffer.byteLength`；编辑时用 `TextEncoder` 重新计算。
- BOM 允许存在，但进入编辑器和最终写入时移除。

### 2.2 软结构提示

缺少 `Name:`、身份/角色说明、语气/表达方式、工作原则/优先级、行为边界/禁止事项，或内容少于 100 个 Unicode 字符时，仅显示改进提示，不阻止注入。提示区顶部统一显示“人设内容建议”，每条建议不重复附加“仍可继续注入”。

## 3. 标准化规则

### 3.1 内部身份

- 自定义上传使用固定内部 slug：`custom-upload`。
- 展示名优先取首个单行 `Name:` 值；去除前后空白并限制为单行、最多 80 个 UTF-8 字节，不截断 Unicode 字符。
- 缺少或值为空时使用原文件名去除 `.md` 的结果；仍为空时使用“自定义人设”。

### 3.2 输出 Markdown

若输入已包含 `# Soul` 和 `## Content`：

- 保留正文和用户自定义章节；
- 在 `# Soul` 与首个二级标题之间替换或补齐 `Slug: custom-upload`；
- 将有效 `Name:` 规范化为大小写和缩进固定的 `Name: <值>`，缺失时补齐回退名称。

若输入不是标准 Soul 结构，则包装为：

```markdown
# Soul
Slug: custom-upload
Name: <解析或回退后的名称>

## Content
<用户 Markdown 原文>
```

最终用户编辑文本必须先通过字节、空内容和控制字符硬校验；补入固定 Soul 元数据后，最终写入的 `SOUL.md` 还必须再次校验且不超过 20 KB，保证注入后的文件仍可在线编辑和下载。展示名上限避免元数据重复放大，写命令还必须在执行前防御性检查小于现有 32 KB 调试命令上限。不另外保存原始上传文件。

## 4. UI 与状态

### 4.1 入口

- 页面入口与初始上传态标题为“上传人设文件”；合法文件读取成功后的编辑态标题为“编辑人设文件”。
- 只在 `isCN` / `!isGlobal` 条件下渲染。
- 操作顺序为“随机抽取人设 → 答题测试人设 → 上传人设文件”；只有选中推荐人设后才在末尾渲染“注入”。
- 使用隐藏 `input[type=file]`，`accept=".md,text/markdown"`；入口按钮只打开弹窗，由弹窗内的“选择文件”触发文件选择器，实际判断仍由校验函数完成。

### 4.1.1 抽卡结果直接注入

- 抽卡揭晓卡片同时提供左侧“注入此人设”和右侧“添加，暂不注入”，两侧按钮使用较小字号。
- “添加，暂不注入”保持原行为，只将卡片加入或替换到人设盘。
- “注入此人设”直接复用推荐人设安全写入链路；只有 Agent `SOUL.md` 写入成功后，才将卡片加入或替换到人设盘、设为当前选中并标记“已注入”。
- 注入失败或仅降级下载 `soul.md` 时，不加入卡片、不关闭抽卡结果，用户可以重试或改用“添加，暂不注入”。
- 注入处理中禁止重复触发两个结果操作，并保持抽卡结果不可关闭，避免异步完成后落入不可见状态。

### 4.2 初始上传态

- 点击页面入口后立即打开标题为“上传人设文件”的弹窗，不直接唤起系统文件选择器。
- 弹窗中央展示上传图标、文案“选择 Markdown 人设文件，将其内容填入 SOUL.md”、限制说明“仅支持 Markdown 文件，文件名不限，扩展名须为 .md，大小不超过 20 KB。”，以及“选择文件”按钮；不展示空编辑框和注入按钮。
- 非 UTF-8 文件显示“文件编码需为 UTF-8，请转换后重新上传。”，编码要求不在初始限制说明中重复展示。
- 点击“选择文件”后才唤起隐藏文件选择器；用户取消系统文件选择时保持初始上传态，不显示错误。
- 文件读取期间在同一弹窗显示加载状态；硬校验失败时在弹窗内展示具体原因，并提供“重新上传文件”操作。
- 文件校验成功后，同一弹窗切换到编辑态，不关闭或重新打开弹窗。

### 4.3 编辑弹窗

- 复用 `@/components/ui/dialog`，具备可见标题、描述、关闭按钮、Escape、焦点管理和移动端可用布局。
- 编辑态标题显示“编辑人设文件”。
- 初始上传态与编辑态不显示可见说明行，但保留与当前状态对应的隐藏无障碍描述；覆盖确认态标题显示“覆盖当前人设？”，可见说明仅保留“旧人设会自动备份，然后注入新人设。”。
- 文本区有明确 label；显示 `当前字节 / 20 KB`，超限时使用错误状态。
- 文本区视觉参考“添加自动任务”的“任务说明”：使用细灰边框、`rounded-md`、聚焦时仅加深边框，不显示额外聚焦外圈；“人设内容”与编辑框间距为 6px。
- 硬错误出现在 `aria-live` 区域；软提示与硬错误在视觉和语义上分开。
- 软提示区标题显示“人设内容建议”，不带冒号；下方建议条目保持非阻断语义。
- 四条专业建议显示为“建议补充角色定位（Identity）”“建议补充沟通风格（Communication Style）”“建议补充工作原则（Working Principles）”“建议补充行为边界（Behavioral Boundaries）”。
- 结构识别支持建议对应的中英文标题；行为边界同时兼容 `Behavior Boundaries` 与 `Behavioral Boundaries`，原有短标题保持兼容。
- 文件读取期间保持弹窗打开并显示加载状态；读取、关闭和组件卸载使用请求序号丢弃迟到结果。
- 注入期间禁用关闭、文件重选和重复提交，按钮显示加载状态。
- 编辑态“重新上传文件”和“注入人设”、覆盖确认态“返回编辑”和“覆盖并注入”均置于弹窗右下角，次操作在左、主操作在右，按钮间距为 8px。

### 4.4 覆盖确认

- 只有读取到当前 Agent 存在非空 `SOUL.md` 时才显示。
- 标题为“覆盖当前人设？”，说明为“旧人设会自动备份，然后注入新人设。”，不再嵌套重复提示框。
- 取消后回到编辑态且内容不丢失；确认后才执行写入。

### 4.5 已注入状态

- 推荐人设继续使用卡片上的单一 `appliedSlug` 徽章。
- 自定义人设不加入 `drawnSouls`，单独显示 `已注入：自定义人设 · {{name}}`。
- 注入自定义人设后清空推荐徽章；注入推荐人设后清空自定义状态。
- 切换 `botId` 时清空瞬时上传状态，并用请求序号丢弃旧 Agent 的读取/写入结果。

### 4.6 当前自定义人设文件操作

- 仅当真实身份为 `Slug: custom-upload` 时，在状态文字后显示“编辑自定义人设”和“下载自定义人设”两个图标按钮；状态文字本身不可点击。
- 编辑图标按需读取当前 Agent 实际 `SOUL.md`，成功后打开“编辑人设文件”弹窗；弹窗显示 `SOUL.md`、纯文本编辑区、实时字节数，以及右下角“取消”“保存修改”。
- 内容未修改、为空、含非法控制字符或超过 20 KB 时不得保存。保存前继续标准化 `Slug` 和 `Name`，并复用备份、临时文件和原子替换写入链路。
- 保存失败保留编辑内容；保存成功刷新真实名称并提示“人设已更新，请发送 /new 开始新会话以生效”。
- 下载图标直接把读取到的原始内容下载为 `soul.md`，不打开编辑弹窗，不标准化或改写正文，并在触发后清理对象 URL。
- 全文读取期间两个图标同时禁用。文件缺失、超过 20 KB、协议/编码异常和网络失败均显示明确错误，不打开空编辑器或生成空文件。

## 5. Hermes 命令

### 5.1 写入

`buildHermesSoulWriteCommand(base64, timestamp)` 必须：

1. 使用 `HERMES_HOME`，缺失时回退 `$HOME/.hermes`。
2. 创建根目录和 `.soul-backups`。
3. 若目标文件非空，以时间戳复制备份。
4. 在 `SOUL.md` 同目录创建唯一临时文件并注册 `trap` 清理。
5. base64 解码到临时文件并要求非空。
6. 使用 `mv` 替换目标文件，成功后取消 trap。
7. 执行前检查完整 UTF-8 命令严格小于 32 KB，超限时不得调用 Agent。

命令失败时不得先截断或删除原 `SOUL.md`。

### 5.2 读取

`buildHermesSoulReadCommand()` 只输出：

```text
Exists: yes
Slug: <首个值，可为空>
Name: <首个值，可为空>
```

目标不存在或为空时输出 `Exists: no`，不得输出完整 Markdown。

前端解析函数返回：

```ts
type HermesSoulIdentity = {
  exists: boolean;
  slug: string | null;
  name: string | null;
};
```

未知输出按“不存在或身份未知”处理；读取请求失败时保留当前界面状态，避免抖动。

`buildHermesSoulContentReadCommand()` 是独立的按需全文读取命令，不改变上述轻量身份协议。它对非空且不超过 20 KB 的文件输出 `Exists: yes`、实际 `ByteLength` 和单行 `ContentBase64`；文件缺失或为空输出 `Exists: no`；超限时输出 `TooLarge: yes` 和实际字节数但不输出正文。解析器必须严格校验 Base64、fatal UTF-8、声明字节数和实际字节数。

## 6. 错误与并发

- 文件校验错误不得调用 Agent 命令。
- 文件读取异常必须转为可恢复错误；读取中禁止重复触发，关闭或卸载后迟到结果不得重新打开弹窗。
- 当前文件编辑/下载读取与保存使用请求序号和 `botId` 双重校验；旧 Agent 的迟到结果不得打开弹窗、触发下载或覆盖新 Agent 状态。
- 注入失败展示可理解的统一错误；弹窗保留编辑内容，允许修正或重试。
- `botId` 变化时，旧 Agent 的延迟成功或失败结果不得更新新 Agent 的状态或弹窗。
- 组件卸载后不得提交状态更新。

## 7. 区域与 i18n

- 国内站是本次唯一范围；国际站不渲染入口。
- 中文源文案通过 `useT` 接入现有翻译体系。
- 运行 `pnpm i18n:extract` 后补齐英文、印尼语并生成繁体中文，`pnpm i18n:check` 必须通过。

## 8. 测试与验证

- 纯函数：扩展名、ASCII/中文 20 KB 边界、无效 UTF-8、BOM、空内容、控制字符、名称截断/回退、六类软提示和标准化。
- 命令：临时文件、`trap`、非空校验、`mv`、真实解码失败时旧文件保护、32 KB 上限、身份读取、全文 Base64 读取/严格解析和超时。
- 组件：国内站入口、编辑字节、软提示、直接注入、覆盖确认、当前文件编辑/下载、失败重试、成功状态、刷新恢复和 Agent 切换竞态。
- 区域：国际站入口缺失且既有推荐人设路径不回归。
- 门禁：定向 Vitest、`pnpm check`、`pnpm i18n:check`、`pnpm build:cn`、必要的 global 回归、`git diff --check` 和本地浏览器冒烟。
