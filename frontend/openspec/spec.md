# 国际站 V2 多语言首页接入 Spec

**最后更新：** 2026-09-01

**状态：** 已实现并完成用户验收。

## 1. 区域与语言边界

1. `isGlobal === true` 且 locale 为 `en-US`、`zh-SG`、`zh-Hant`、`id-ID`、`es`、`ja-JP`、`ko-KR` 时使用新版首页。
2. 国内站构建继续使用现有 `PublicHomePage`，不得加载新版首页 fragment、CSS 或运行时脚本。
3. `zh-CN` 不选择新版国际站首页；七个已发布 locale 必须读取各自 fragment，避免跨语言内容回退。

## 2. 页面与动效契约

1. 页面结构、布局、图片和动效以已验收 V2 静态首页为来源；七个 locale 使用对应本地化 fragment 和图片。
2. 首页正文必须进入静态导出 HTML，不能用 iframe，也不能依赖客户端 fetch 后才出现。
3. 动效脚本只在新版首页挂载时加载；locale 变化时移除旧脚本并以新 locale 重新加载，页面卸载时不得留下重复脚本标签。
4. 所有 fragment 图片、字体和脚本使用 `/lightvela-intl-home/` 绝对资源路径；资源必须在构建前可解析。
5. 简体与繁体中文使用中文版字体；英文、印尼语、西班牙语、日语、韩语营销标题使用英文版 editorial 字体基准。
6. 印尼语与西班牙语长 Hero 标题桌面端保持一行；印尼语能力区长标题桌面端保持一行；移动端允许自然换行且不得横向溢出。
7. 页脚、用户评价和 DeepSeek Harness 使用本地已确认版本；Hero eyebrow 不使用浅色胶囊。

## 3. 导航契约

1. fragment 中不得保留 `href="#"`、`javascript:`、本地 `index.html` 或 `assets/...` 相对路径。
2. 核心站内落点固定为：`/`、`/subscribe`、`/docs/overview`、`/changelog`、`/about`、`/agents`、`/agents/automations`、`/agents/files`、`/agents/websites/`、`/privacy-policy`、`/terms-of-service`、`/open-source-licenses`。
3. 对比文章落到 `/docs/compare/*` 正式文档路由；通道指引落到 `/docs/configuration/channel-*`。
4. 语言入口复用生产语言切换器；外部 Discord、WhatsApp、X、YouTube、CloudBase、EdgeOne 使用当前正式链接并带 `target="_blank" rel="noreferrer"`。
5. Hero、账号入口、产品 CTA 和试用入口落到对应正式 Agent 或订阅路由，并保留 locale 前缀。

## 4. 验收契约

1. 测试先证明最新 master 尚未接入新版首页，再实现区域选择和资源加载。
2. 运行定向 Vitest、`pnpm check`、`pnpm build:global` 与 `git diff --check`。
3. 本地 global 开发服务在独立端口启动；桌面和移动端检查七个 locale 的首屏、导航、动效、无水平溢出、无破图和无新增页面错误。
4. 国内站负向测试必须证明 `isGlobal === false` 不选择新版首页。
5. 自动化测试必须覆盖 locale fragment、正式链接、资源完整性、动效脚本重绑定、保留模块、长标题与 CTA 本地化。

---

# 首页加载性能优化 Spec

**最后更新：** 2026-08-31

**状态：** 已归档。归档文件：`openspec/changes/2026-08-31-homepage-performance.md`。

## 1. 图片加载契约

1. BrandIcons 1、Feature 跑马灯 18、Cards 12、Process 7、CTA 2，共 40 个唯一折叠下方资源必须使用 `loading="lazy"`。
2. Hero 四张图片与公共 Header 的 LightVela logo 不得在本批改为 lazy。
3. ProcessSection 的数据映射产生 7 个唯一资源；移动端重复实例也必须继承 lazy 属性。
4. width/height 只允许使用图片真实 intrinsic size；已有固定尺寸/比例容器可以作为布局稳定性约束，不得填写猜测值。
5. 最新 master 的真实构建基线为 CN 45、global 46；目标分别降为 5 和 6。CN 剩余 logo + Hero 四图，global 额外保留 Footer wordmark。

## 2. 首页场景依赖契约

1. 首页 6 个 pack、语言文案、locale 映射与 getter 位于独立 overview 入口，并由全量库复用同一份基础定义。
2. `overview-packs.ts` 不得 import `scenario-packs.ts`；共用 factory、类型和最小字段依赖放入中立 core。
3. 全量 pack 的有序 ID 集合和重复性、首页 6 个 ID/顺序、公开 locale 文案及 `promptBuilder` 行为必须保持不变。
4. 原入口可按调用方兼容需要 re-export；`landing-page.tsx` 必须直接消费 overview 入口。
5. 构建产物必须证明首页链不再包含完整 `scenario-packs` / `FOCUSED_SCENARIO_PACKS`，不能只用源码 import 变化代替。

## 3. i18n Q0 PoC 契约

1. 记录 CN/global 首页脚本、模块 ID、client boundary 和重复字典证据，解释两个约 1006 KiB chunk 的来源。
2. 优先验证共享 chunk 或收窄 client boundary 能否去掉一份重复字典，并记录 before/after。
3. 本批不得改变运行时 i18n 行为；若结论要求改初始化、hydration、locale 注册表或资源外置，必须另起实施计划。

## 4. 验证契约

1. baseline 与改后样本使用同一 commit 基线、设备、Chrome、限速和构建环境。
2. Lighthouse 冷缓存各运行 5 次，比较中位数 LCP/FCP/TBT/CLS。
3. 国内站和国际站分别执行真实 Next 构建；本机失败时前后样本必须统一迁移到同一 CI/构建机，禁止跨环境比较。
4. 必须通过图片/场景定向测试、`pnpm i18n:check`、`pnpm i18n:zh-hant:check`、`pnpm check` 与 `git diff --check`。

---

# 国际站西语端到端上线 Spec
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
- 安装使用 `flock`，状态以 root-owned JSON 原子写入 `/var/lib/lightvela/dsh/installations/`。下载、冻结安装和静态检查先在 root-owned 任务目录完成；已有 profile 的可变插件内容仅以 `agentuser` 身份复制，控制文件通过 no-follow 读取后原子重建。正式切换前先停止旧服务，再比较包含第三方插件编译产物在内的完整旧 profile 指纹，检测到并发修改则恢复旧服务且不覆盖。
- 切换前备份旧 runtime、完整旧 `web` profile、固定 pnpm tooling 和旧 unit；切换后明确 enable、restart，先等待回环 HTTP 200，再确认只监听 `127.0.0.1:3080`。失败时恢复备份并重启旧服务；首次安装失败清理临时目录和半成品。
- 重装或升级时保留原 `web/cordis.patch.yml`；`$DSH_HOME` 下的 credentials、settings、storage 和其他用户数据不参与替换或清理。成功或失败后删除任务工作目录，但保留安装任务 JSON 状态记录。
- 已经收敛到相同 npm 快照、六插件和服务配置时幂等复用 runtime。SkillHub 已安装的第三方插件依赖、bundle、workspace build policy 与编译产物在校验包名、bundle patch 路径和 profile 完整性后保留；旧安装器写入的 `pnpm.onlyBuiltDependencies` 从可变 Web profile 迁移删除，runtime 自身的 native build allowlist 保持不变。
- 用户确认“修复”后，wrapper 隔离完整旧 profile，只将 `web/cordis.patch.yml` 放入干净 profile，再调用安装器；模型凭据、DSH settings 与 storage 保留，用户自行安装的插件及其他 profile 文件移除。任务失败时恢复完整旧 profile 和原服务状态。

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

**最后更新：** 2026-08-24

**区域：** `global`，仅国际站 `lightvela.ai`。

**Locale：** `es`；公开 URL 前缀 `/es`；日语与韩语继续隐藏。

## 1. 区域隔离

1. 国内/国际差异继续由 `isCN` / `isGlobal` 编译期常量决定，不得用 locale 值代替区域判断。
2. 国内站不展示 `es`，不增加 `/es` 本站入口，不改变默认中文、现有跨站跳转或既有选项顺序。
3. 国际站才读取注册表中的 `switcherVisible` locale 生成语言选项。
4. 共享 locale 类型可以包含 `es`，但任何用户可见入口必须同时满足国际站区域条件。
5. `ja-JP`、`ko-KR` 保持 `switcherVisible: false` 和 `translationRequired: false`。

## 2. Locale 注册表与开放门禁

`frontend/src/i18n/locales.json` 是运行时数据真源，`locales.config.ts` 提供静态类型与派生 helper。

西语定义必须满足：

- `code: "es"`
- `urlLang: "es"`
- `htmlLang: "es"`
- `docsSourcePrefix: "es"`
- `docsFallbackPrefixes: ["en", "global"]`，且优先回退英文
- `seoPrefixed: true`
- `requiresFontFallback: true`

开发期间开关保持关闭。下列条件已满足，因此最终发布状态设置为：

- `switcherVisible: true`
- `translationRequired: true`

已完成条件包括：字典 key 集一致、必填翻译清零、结构校验通过、路由/SEO/文档/字体定向测试通过。国际站和国内站构建及浏览器 smoke 仍作为 Task 8 最终验收门禁，失败时回滚西语入口。

## 3. 西语字典与翻译

### 3.1 基线同步

1. 以当前 `zh-CN.json` 与 `zh-to-key.json` 为中文事实源。
2. 西语字典必须删除中文基准已移除的 key，并补入所有新增 key。
3. 新 key 初始为空，随后通过中文原文映射写入西语；不得根据 hash 猜测原文。
4. 日语、韩语只允许做保持 key 集一致所必需的机械同步，不进行翻译或开放。

### 3.2 翻译规则

- 使用自然、简洁的拉美西语；不用西班牙本土特有的 `vosotros` 表达。
- LightVela、Hermes Agent、Agent、Skills、SkillHub、ClawHub、模型名、渠道品牌名、命令和代码标识按产品术语保留。
- 按钮和状态文案优先使用短语；错误文案说明原因与下一步。
- `{{variable}}` 集合必须与中文原文完全一致。
- HTML 标签数量、嵌套意图和换行结构必须保持。
- 仅由字符串拼接需要的前后空白可以保留，并由校验器输出可审计告警。
- 同一中文原文在不同位置共用同一 hash 翻译，不为上下文差异复制新 key。

### 3.3 校验

- `i18n:check`：西语启用后待翻译必须为 0。
- `i18n:validate`：错误必须为 0；告警逐项确认，不用关闭规则隐藏问题。
- 字典测试：key 集与中文基准双向一致。

## 4. 语言切换与路由

1. 国际站语言选项由 `SWITCHER_VISIBLE_LOCALES` / locale definitions 生成，不再维护逐语种常量与三元链。
2. 公开 SEO 路径从其他语言切换到西语时使用 `/es/<bare-path>`。
3. 从 `/es/...` 切换回英文时移除 locale 前缀；切换到其他既有语言沿用其规范前缀。
4. 控制台路径保持当前 URL 结构，只更新 `lw-locale` 并沿用既有 reload 规则。
5. 非法或历史 locale 值必须经注册表白名单解析后回退区域默认语言。
6. URL prefix matcher 按长度降序，避免未来 `es-ES` 被 `es` 抢先匹配。
7. 页头、页脚、法律入口和公开站导航不得通过排除式判断把 `es` 静默映射为英文或中文。

## 5. 文档站

### 5.1 内容范围

- 本次区域固定为 `global`，不修改 `src/content/docs/` 国内站根目录正文。
- 不新增西语正文副本；正文通过 `docsFallbackPrefixes` 回退 `en`。
- 需要西语化的内容仅包括侧栏分组、页面 title/description、搜索索引显示、docs manifest 和页面 metadata。

### 5.2 注册一致性

以下来源必须同时包含 `es` 且互相一致：

- `src/config/docs-sidebar.ts`
- `next-site/docs-route-manifest.ts`
- `scripts/sync-fumadocs-content.mjs`
- docs source / loader 与 localized path helper
- sitemap 和 SEO 数据来源

同一 slug 在西语正文 fallback 后仍必须 canonical 到 `/es/docs/<slug>`，并输出对应语言 alternate。

## 6. SEO 与 metadata

1. 公开页与 docs 页的 title、description、canonical 和 `og:url` 必须指向同一个西语 URL。
2. `html lang` 使用 `es`；Open Graph locale 使用项目验证过的西语 locale 值，不伪造地区版本。
3. `hreflang="es"` 只为真实可访问的西语页面输出。
4. sitemap 必须包含 `/es` 公开页和 `/es/docs/<slug>`；不能为不存在的路径生成条目。
5. 9 个公开 SEO 页面的 `TITLE_BY_LOCALE` / `DESCRIPTION_BY_LOCALE` 继续使用完整 `Record`，补齐自然西语文案，不改成 `Partial`。
6. Open Graph 与 Twitter 图片继续复用稳定的绝对 URL，不因新增 locale 复制资源。
7. 不新增与真实页面内容不一致的 JSON-LD、评分、价格或声明。

## 7. 字体

1. 字体子集采集源必须遍历全部注册字典，补上既有遗漏的 `id-ID`。
2. `áéíóúüÁÉÍÓÚÜ` 若源字体已有字形，必须纳入 subset。
3. `ñÑ¿¡` 在现有标题字体源无字形时，不把它误报为 subset 漏采集；西语 locale 使用可覆盖这些字符的系统拉丁字体回退。
4. 字体回退只按西语 locale 生效，不改变国内站中文标题字体。
5. 构建校验分别报告“源字体缺字”和“subset 漏字”，避免错误修复方向。

## 8. 国际站 UI 覆盖

西语覆盖对象包括：首页、价格、支持、更新日志、页头、页脚、法律入口的 UI 文案，以及登录、账户、订阅和 Agent 控制台宿主自有的通道、自动任务、Soul/人设、Skills、场景任务、通知文案。

明确排除 `@tencent/tea-sdk-lightclaw` 内部渲染文案、Models 模块整体本地化和法务正文内容。

## 9. 错误处理与降级

- 未知 locale：回退国际站英文，不允许回退中文。
- 西语字典 key 缺失：开发/CI 阶段失败；开放后不依赖静默 fallback 掩盖。
- 文档正文缺西语源：稳定回退英文；导航和 metadata 不回退英文。
- 字体源缺字：使用 locale 字体回退；subset 采集遗漏则构建失败。
- 西语入口出现问题：将 `switcherVisible` 设回 `false` 可隐藏入口，不影响其他语言。

## 10. 测试与验证

### 10.1 自动测试

- locale 注册表数据/类型双向一致、前缀排序与白名单解析。
- 西语字典 key 集、必填翻译、占位符、HTML 与换行结构。
- 国际站语言切换器展示西语、路由切换、持久化与 reload 行为。
- 国内站不展示西语的负向测试。
- 公开页导航、页头、页脚及控制台 locale 映射测试。
- docs sidebar、slug、manifest、搜索和 fallback parity 测试。
- sitemap、canonical、hreflang、`html lang` 与 metadata 一致性测试。
- 字体字符覆盖与西语 fallback 测试。

### 10.2 构建门禁

- `pnpm i18n:check`
- `pnpm i18n:validate`
- 相关 Vitest 与最终全量 `pnpm test`
- `pnpm check`
- `NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm build`
- `NEXT_PUBLIC_REGION=cn VITE_REGION=cn pnpm build`
- `git diff --check`

### 10.3 浏览器验收

国际站至少验证 `/es`、`/es/subscribe`、`/es/support`、`/es/changelog`、`/es/docs/overview`，以及一个控制台页面的西语切换与刷新保持。

检查导航、正文关键路径、无缺字、无横向溢出、无错误浮层、canonical/hreflang 和 `html lang`。国内站只做负向 smoke：不出现西语入口，默认中文和既有导航不变。

## 11. 完成定义

1. 西语入口开放，日语和韩语仍隐藏。
2. 西语字典翻译与结构门禁清零。
3. 国际站公开页、控制台宿主、docs 导航/metadata、SEO 和字体验收通过。
4. 国内站自动测试与构建回归通过。
5. 未处理项只允许是本 Spec 明确排除的 SDK、Models、法务正文和文档正文翻译。
6. 输出验收摘要并等待用户确认；确认前不归档、不 commit、不 push、不创建 MR。

## 12. 西语代码可控内容全面收口（增量规范）

本节是 2026-08-24 用户确认的第二阶段增量规范。若本节与前文关于 SDK、Models 或英语 fallback 的排除描述冲突，以本节为准。

### 12.1 内容归属

内容按以下规则分类：

- **必须西语化：** LightVela 仓库或其受控源包中维护的第一方界面文案、metadata、无障碍文本、内置人设、测试题、推荐数据、curated Skills 数据、日期格式和 locale 参数。
- **允许保持源语言：** 用户输入、Agent/实例返回内容、第三方实时目录数据、品牌名、模型名、协议名、代码、命令、路径和文件名。
- **本轮延后：** 图片内烘焙文字和第三方托管页。
- **长期英文正文回退：** Docs 正文和四类法务正文；其页面壳、提示、导航、搜索与 metadata 不属于回退范围。

### 12.2 产品壳 metadata

1. `/agents`、`/account`、`/account/orders`、`/plans/select` 及其他无 locale 前缀产品页必须根据当前有效 locale 设置浏览器标题。
2. `es` 标题必须为自然西语；未知 locale 回退国际站英文，国内站继续使用中文默认值。
3. 客户端标题 helper 与 Next 静态 metadata 不得互相覆盖成中文；切换语言或恢复持久化 locale 后标题必须同步更新。

### 12.3 内置人设与测试数据

1. 第一方 Soul/persona 名称、说明、标签、测试题、答案和结果必须有显式 `es` 数据集。
2. 西语不得通过 `es -> en` 选择英文池；缺少任一必填字段应由测试失败暴露。
3. 人设 slug、内部标识、文件内容和用户自定义内容保持原样，不因显示语言变化而改写。

### 12.4 Skills 与第三方动态数据

1. curated Skills 的分类、受众、问题、能力、摘要和第一方说明必须有显式 `es` 数据。
2. SkillHub 等第三方接口返回的名称、作者、仓库信息和动态描述按源数据展示；本地搜索、筛选、分页、安装、空状态和错误文案必须为西语。
3. 若上游接口公开支持 `es` locale，请传递 `es`；不支持时不得伪造西语数据，也不得把第三方英文结果计入第一方残留失败。

### 12.5 AgentChat、SDK 与内嵌面板

1. 宿主必须把当前 `es` locale 通过消费包公开的 locale contract 传入 AgentChat/内嵌面板。
2. 若受控源包缺少 `es` contract 或语言资源，修复必须发生在真实源包与 public/barrel export，并按仓库 pin 流程更新消费版本；禁止修改 `node_modules` 作为最终实现。
3. 不允许在 `agent-settings-page.tsx` 等宿主页面复制 provider、模型或通道内部配置来伪造本地化。
4. 第三方 iframe 或外部托管页面不在本轮；其宿主标题、加载态、错误态和返回操作仍必须为西语。

### 12.6 Locale 格式化与 `html lang`

1. 日期、时间和数字格式 helper 必须将 `es` 映射到标准西语 locale，不得把所有非中文语言统一映射为 `en-US`。
2. `/es` 开发态、SSR/静态页面和构建后 HTML 均必须为 `html lang="es"`。
3. `/es` 的 canonical、hreflang、Open Graph locale 和 sitemap 继续沿用前文既有规范。

### 12.7 残留审计

1. 自动审计覆盖第一方可见字符串来源，不以“西语字典完整”替代页面与结构化数据检查。
2. 审计 allowlist 只能包含本节明确允许保持源语言的类别，并记录文件、字段和原因。
3. 中文/CJK 残留必须为 0；英语残留按归属分类，第一方残留必须为 0。
4. 浏览器矩阵至少覆盖 `/es`、`/es/about`、`/es/changelog`、`/es/support`、`/es/subscribe`、`/plans/select`、`/account`、`/agents` 及可到达的 Agent 分区。

### 12.8 区域隔离与验证

1. 本轮所有用户可见差异只在 `isGlobal` 且 locale 为 `es` 时生效；共享 helper 不得改变国内站默认输出。
2. 每个行为修改必须遵循 RED -> GREEN -> REFACTOR，并保留预期失败与通过证据。
3. 最终门禁包括相关 Vitest、`pnpm check`、`pnpm i18n:check`、`pnpm i18n:validate`、`pnpm build:global`、`pnpm build:cn` 和 `git diff --check`。
4. Docs/法务正文、图片烘焙文字、第三方托管页和第三方动态数据不得被误报为本轮未完成。

## 13. 国际站西语 Docs 正文

1. 国际站 61 篇英文 Docs 必须在 `src/content/docs/es/**` 有同路径西语源；最终构建不得使用英文或中文正文 fallback。
2. 译文采用自然拉美西语，保持标题层级、步骤顺序、表格、代码块、链接目标、事实、警告、限制和失败处理语义一致。
3. 产品名、渠道名、模型名、协议名、文件名、命令、代码和 URL 保持原样。
4. `src/content/docs/images/**` 与 `public/docs-images/**` 图片资源不得变化；Markdown/HTML 图片目标与英文源一致，alt 文本翻译为西语。
5. 不修改 `en/**`、`global/**` 或国内站根目录正文，不借本任务修订其他语言内容。
6. 三批范围固定为：工具型 28 篇、Use Cases 16 篇、Compare 与 Hermes Agent Deep Dive 17 篇。
7. 自动门禁必须校验路径集合、`source_path`、图片目标、代码块、标题层级、表格结构、内部链接、last-updated 与 61 个西语 slug。

---

# 国内建站临时分享码 Spec

**最后更新：** 2026-08-27
**状态：** Redis TTL 后端已实现；前端管理 UI 已撤出本分支并移交前端同学

## 1. Redis 状态与安全不变量

本功能不新增 MySQL column 或 migration。Redis key 是临时分享状态的唯一真源：

```text
website:share:access:{site_id}
```

Value 为 JSON：

```json
{
  "code_hash": "<bcrypt digest>",
  "generation": "<crypto-random opaque id>",
  "expires_at": "<RFC3339 UTC>"
}
```

- Redis key TTL 只允许 1、7、30 天；`expires_at` 与 TTL 使用同一个服务端 UTC 基准计算。
- 分享码由 `crypto/rand` 从 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` 中生成 6 位大写字符串。
- Redis 只保存 bcrypt hash，不保存明文；明文只在开启或重置响应中返回一次。
- `generation` 使用独立的加密随机值，不对用户接口暴露，用于废除旧分享 Cookie。
- key 缺失、过期、JSON 损坏、hash/generation/expires_at 缺失或 `expires_at <= now` 均按 `owner_only`。
- Redis 状态读取异常时，分享管理和验证返回不可用；站点元数据读取降级为 `owner_only`，不得破坏 Owner OIDC。

## 2. CTL 契约

所有者接口继续位于现有 `websiteInstanceAuthMiddleware` 后：

```http
PUT /v1/websites/{site_id}/access
{"mode":"share_code","duration_days":7}

PUT /v1/websites/{site_id}/access
{"mode":"owner_only"}

POST /v1/websites/{site_id}/share-code/reset
```

- `duration_days` 仅接受 `1|7|30`；`share_code` 缺失或非法时返回参数错误。
- 开启分享生成新 code/hash/generation，以选择的天数重置 TTL，并返回 `mode`、一次性 `code`、`expires_at`。
- `owner_only` 删除分享 key；key 已不存在时保持幂等。
- 重置只允许当前有效分享：生成新 code/hash/generation，使用旧状态的绝对 `expires_at` 计算剩余 TTL，不延长有效期。
- 用户站点列表和详情只返回派生的 `AccessMode`、`ShareExpiresAt`；不得返回 hash 或 generation。
- `GetSiteInternal` 返回 gateway 所需的 `access_mode`、`share_generation`、`share_expires_at`；Redis 异常时返回 owner-only 空状态。

内部接口复用 constant-time 校验的 `X-Internal-Token`：

```http
POST /internal/ctl/websites/sites/{site_id}/share-code/verify
X-Site-Client-IP: <trusted-client-ip-or-empty>
{"code":"7KQ9XM"}
```

成功返回 `verified=true`、`share_generation`、`share_expires_at`。错误码统一返回 403，不区分未分享、过期、状态损坏或摘要不匹配；命中限流返回 429；Redis 不可用返回 503。响应和日志均不得包含 code/hash。

## 3. 分布式尝试限制

CTL 在读取分享状态和执行 bcrypt 前通过 Redis Lua 原子预留尝试：

- `website:share:attempts:site:{siteID}`：10 分钟 50 次。
- 客户端 IP 非空时再使用 `website:share:attempts:site:{siteID}:ip:{sha256(ip)}`：10 分钟 5 次。
- 成功验证后删除本次站点/IP 计数；失败保留到 TTL。
- Redis client 为空或脚本失败时 fail-closed，不执行 bcrypt。

IP 不进入 Redis key 明文、不写业务日志。只有 `SITE_GATEWAY_TRUST_PROXY_HEADERS=true` 时才读取受控入口追加的 `X-Forwarded-For` 首个合法地址；未显式信任时不发送客户端 IP，只保留站点全局上限。

## 4. site-gateway 访问流程

`sitemeta.Site` 使用 `access_mode`、`share_generation` 与 `share_expires_at`。gateway 不读取 hash，也不直接连接 Redis。

- `public`：保持现有直接回源，不读取分享 Cookie、不展示分享页。
- `required + owner_only`：保持现有 owner Cookie + OIDC 流程。
- `required + active share_code`：有效 owner Cookie或 generation 匹配且未过期的分享 Cookie 放行；否则跳转同源分享页。
- 元数据中的分享状态过期、缺失或未知时按 owner-only；自动到期使用本地 `expires_at` 判断，不等待 30 秒元数据缓存清除。

分享页只接受 GET/HEAD 与 POST。POST 校验成功后写 `__Host-lv_site_share`，固定 `Secure; HttpOnly; SameSite=Lax; Path=/`、无 Domain，Cookie Max-Age 和 token exp 均为 `share_expires_at - now`，不得超过分享剩余有效期。

`ShareSessionClaims` 为 `{SiteID, SiteHost, Generation, Nonce}`。站点 ID、Host、generation 不匹配或 token 到期均视为无效；重置/停止后的主动废除受现有 30 秒站点元数据缓存影响，自动到期不受该缓存延长。

## 5. 前端交接边界

- 本分支保持前端基线不变：不开放国内 `/agents/websites` 路由，不增加工作台分享按钮或 Dialog，不修改 Sarah 原工作台样式。
- 后续前端交互应先选择“使用分享码访问”，再出现 1 天、7 天、30 天选项；不得在 owner-only 初始态提前展示时长。
- 开启或重置后只提供一个“复制分享信息”按钮，不分别复制地址和分享码。建议复制内容为：`Hi，我使用 LightVela 给你分享了一个网站：\n<URL>\n分享码：<CODE>\n有效期至：<TIME>`。
- 分享码明文仍只在开启或重置后展示一次；重置不延长到期时间，停止分享调用 owner-only 接口。

## 6. 验证

- CTL：1/7/30 天 TTL、非法时长、无 DB 字段/migration、只存 bcrypt、随机 generation、重置保留到期、停止删除、过期/损坏/Redis 异常、内部路由与限流。
- site-gateway：owner-only/public 回归、分享页、动态 Cookie TTL、generation 失效、自动到期、错误/429/503、return_to 安全和受信代理头。
- 前端：不在本分支验证，交由后续前端实现补充交互测试、类型检查、i18n 与浏览器验收。
- 门禁：目标 Go 包测试、site-gateway `go test ./...`、`git diff --check`。

---

# 国际站日语完整本地化 Spec

**区域：** `global`，仅国际站 `lightvela.ai`。

**Locale：** `ja-JP`；公开 URL 前缀 `/ja-jp`。

## 1. 发布契约

日语路由、切换器、SEO、Docs 与字体只从 locale 注册表的发布状态派生。完成前保持 `switcherVisible=false`、`translationRequired=false`；自动门禁、母语抽检和法务审阅通过后同时开启。

## 2. 字典与结构化内容

`ja-JP.json` 必须与中文基准 key 集一致、全部非空，且占位符、HTML 标签和换行结构一致。Soul、Buddy、Skills、Experts 与场景任务使用显式日语数据源；发布状态下核心内容不得回退中文或西语。

## 3. Docs

`src/content/docs/ja/**` 与英文/西语发布文档保持 61 个文件同集合。图片目标、代码块、标题层级、表格、事实、能力边界和链接意图保持一致；内链指向 `/ja-jp/docs/**`。日语搜索与 manifest 必须覆盖全部发布 slug。

## 4. 法务

隐私、Cookie 与服务条款提供完整日语译文并声明英文版本优先。开源许可证正文保持英文，只翻译页面结构与说明。

## 5. SEO 与字体

日语 URL 使用 self-canonical、`hreflang=ja-JP`、`og:locale=ja_JP`、`html lang=ja-JP`。只有真实 200 路径进入 sitemap。字体使用 Hiragino Sans / Yu Gothic / Noto Sans JP / system-ui，不将完整日文字形加入 HY 字体子集。

## 6. 排除

国内站、Models、Tea SDK 内部语言包、自动语言识别、账号级语言同步、日韩市场支付与登录能力均不在本次范围。
