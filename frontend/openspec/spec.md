# DeepSeek Harness 真实接入 Spec

**最后更新：** 2026-08-21
**状态：** 本地第一版与在线冻结依赖、五插件原子安装增强完成；北京 Sandbox 真实组合冒烟待确认

## 1. 统一命令通道

DeepSeek Harness 不新增专用后端接口。页面所有实例操作统一调用现有 `POST /v1/instances/{id}/debug/exec`，由现有 Repository、实例归属和 active pass 校验链路承接。

| 动作 | 固定命令 |
| --- | --- |
| 状态 | `sudo systemctl status deepseek-harness.service --no-pager`，包装为始终返回 JSON 的条件命令 |
| 安装 | `sudo systemd-run ... /usr/local/libexec/lightvela/install-deepseek-harness install --task-id <validated-id>` |
| 任务查询 | `sudo /usr/local/libexec/lightvela/install-deepseek-harness installation --task-id <validated-id>` |
| 重启 | `sudo systemctl restart deepseek-harness.service`，随后再次查询状态 |
| 模型供应商列表 | `sudo /usr/local/libexec/lightvela/install-deepseek-harness providers --region <cn|global>` |
| 模型供应商配置 | API Key 经 base64 shell 安全编码后写入 helper stdin，Provider ID 必须命中固定白名单 |
| 模型供应商删除 | `sudo /usr/local/libexec/lightvela/install-deepseek-harness remove-provider --provider <allowlisted-id>` |

## 2. 实例安装器

- 固定运行用户 `agentuser`、`DSH_HOME=/home/agentuser/.dsh`、端口 `127.0.0.1:3080`。
- 固定版本 `@deepseek-ai/dsh@0.1.0-rc.7`、`@cocofhu/skillhub@0.2.13`、`deepseek-harness-qqbot@0.1.5`、`deepseek-harness-weixin@0.2.5`、`deepseek-harness-wecom@0.1.5` 和 `deepseek-harness-lark@0.1.5`；不安装 `dsh-auth`。
- 镜像只预置 root-owned 冻结安装清单，不预置 DSH 包体。DSH runtime 与 `web` profile 各自使用固定 `package.json`、`.pnpmfile.cjs` 和 `pnpm-lock.yaml`；hook 将整个 `@deepseek-ai/dsh-*` 依赖族保持在 `rc.7`，避免与后续 RC 混装。实例安装时执行 `pnpm install --frozen-lockfile`，不得解析或写回新版本。
- `web` profile 复用 DSH 官方 `nodeLinker: hoisted`、`autoInstallPeers: false` workspace 约定，只直接安装五个插件；base/web-app bundles 由冻结 runtime 的 profile fallback 提供。
- 四个渠道插件使用固定 COS revision 与 SHA256；SkillHub 和 registry 依赖使用固定版本及 lockfile integrity。下载配置有限重试、连接/总超时，校验失败不得进入安装阶段。
- 固定插件来源如下；完整 SHA256 与 registry integrity 进入 root-owned `manifest.json`，实现不得仅依赖文件名或 URL：

| 插件 | 固定版本 | 固定来源 |
| --- | --- | --- |
| SkillHub | `@cocofhu/skillhub@0.2.13` | npm tarball + `dist.integrity` |
| QQBot | `deepseek-harness-qqbot@0.1.5` | COS revision `691af8ca2ffc9a1d67784d49744565b08d936f5e` + SHA256 |
| 微信 | `deepseek-harness-weixin@0.2.5` | COS revision `361927d701f664074b1ea72096f8e61c121a602d` + SHA256 |
| 企业微信 | `deepseek-harness-wecom@0.1.5` | COS revision `e241355f081c90cddfcc16d0e26020a5db30be25` + SHA256 |
| Lark | `deepseek-harness-lark@0.1.5` | COS revision `b8c6f6ed8eab67a5b99be9b430ef19bea631fd4d` + SHA256 |

- 下载最多尝试 5 次，单次连接超时 10 秒、单个请求总超时 300 秒，并使用有上限的退避。禁止执行宽泛的 `pnpm approve-builds --all`；构建脚本只允许 `@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`，明确忽略无需运行的 `@google/genai`、`protobufjs` 安装脚本。
- DSH 版本目录 `/opt/lightvela/dsh/releases/0.1.0-rc.7`，当前链接 `/opt/lightvela/dsh/current`。
- 系统服务文件 `/etc/systemd/system/deepseek-harness.service`，通过 `User=agentuser`、`Group=agentuser` 降权运行，设置 `Restart=always`、`RestartSec=5`、`UMask=0077`。
- SkillHub、QQBot、微信、企业微信和 Lark 全部安装到 DSH `web` profile。五个插件必须同时满足准确包名/版本、声明 `dsh.bundle`、进入 `dsh.profile.bundles`、出现在 `dsh plugin --profile web list --depth 0 --json`，且 `dsh --profile web --dump-config` 成功；任一失败都将整个任务判定失败。
- 安装使用 `flock`，状态以 root-owned JSON 原子写入 `/var/lib/lightvela/dsh/installations/`。下载、冻结安装和静态检查先在任务临时目录完成；正式切换前再次比较旧 profile 指纹，检测到并发修改则不覆盖。
- 切换前备份旧 runtime、完整旧 `web` profile 和旧 unit；切换后明确 enable、restart，并验证 systemd active 与回环 HTTP 200。失败时恢复三者并重启旧服务；首次安装失败清理临时目录和半成品。
- 重装或升级时保留原 `web/cordis.patch.yml`；`$DSH_HOME` 下的 credentials、settings、storage 和其他用户数据不参与替换或清理。成功或失败后删除任务工作目录，但保留安装任务 JSON 状态记录。
- 已经收敛到目标 runtime、五插件和服务配置时幂等成功。检测到非 LightVela 管理的额外 profile 依赖或 bundle 时保持原状并失败，不删除未知插件、不放弃冻结保证。

## 3. 模型供应商配置 helper

前端不再直连 DSH 配置 RPC。实例侧 `configure-deepseek-harness.py` 只允许调用 `llm.providers`、`settings.describe`、`credentials.describe`、`settings.mutate`、`credentials.set`、`credentials.unset`，并校验 RPC envelope 与 `result.ok`。非 DeepSeek Provider 在对应 settings path 写入派生的 `<ROUTE>_API_KEY` 引用，DeepSeek 直接写 `DEEPSEEK_API_KEY`。helper 只从 stdin 读取密钥，响应不包含密钥值。

删除遵循 DSH WebUI 的窄范围清理：DeepSeek 只清除可写的 `DEEPSEEK_API_KEY`，凭据已配置但来自不可写环境时明确拒绝删除；其他供应商删除 profile，且仅在 profile 引用 LightVela 派生的 `<ROUTE>_API_KEY` 并确认凭据可写时清除凭据。环境变量密钥、自定义引用与不可识别凭据保持不变。凭据清理和 profile `unset` 均为幂等操作，部分失败允许原位重试。

## 4. 页面状态

- 状态查询 loading、error、未安装、安装中、安装失败、运行中、未运行完整覆盖。
- dsh 已安装即展示模型配置卡片和 WebUI/重启操作；运行状态如实展示，不增加诊断分支。
- 模型配置卡片上方持续展示已配置模型供应商，每行提供编辑和删除；同一时间只展开一个编辑区。
- 配置区始终展示当前站点完整白名单，字段标签使用“模型供应商”；重复保存同一 Provider 通过原固定命令覆盖更新。
- API Key 输入始终为空；编辑时留空表示保留已有密钥。
- 保存请求未完成时，按钮显示“保存中...”并禁用供应商选择、密钥输入和其他配置操作。
- 保存成功或失败通过顶部居中 Toast 反馈并自动消失；成功时保留当前 Provider 选择并清空密钥，失败时保留密钥以便重试。
- 删除前二次确认；成功后刷新列表，失败时保留弹窗并允许重试。
- WebUI 使用同源 Service Worker 前缀和独立 DSH broker identity，目标固定为回环 3080，Hermes 9119 行为保持不变。

---

# 个人助理运行时概览页重构 Spec

**最后更新：** 2026-08-11
**实现形态：** 中文静态概览页，使用内联 HTML / CSS / 原生浏览器脚本，不新增依赖、不调用后端。

## 1. 产品定义

### 1.1 核心定位

LightVela 是：

> **一个跨 IM、跨工具、长期在线的个人助理运行时。**

Hermes 的价值不在于模拟一个可爱角色，而在于持续处理个人信息流：它把散落在聊天、链接、截图、语音、文件与项目中的内容收进 Inbox，形成用户可见、可编辑且可限制范围的记忆；再按可控的主动性等级提醒、建议、起草或执行低风险动作。

### 1.2 叙事顺序

```
跨 IM / 跨工具输入
        ↓
个人 Inbox（自动识别与分流）
        ↓
可控记忆（偏好 / 人际 / 项目 / 知识）
        ↓
分层主动性（记录 → 提醒 → 建议 → 草稿 → 低风险执行）
        ↓
跨工具工作台（结果草稿 / 已授权动作）
```

每个页面段落只能解释该链路中的一个动作；不得重新引入“先部署、再配置模型、再绑定通道”的创建教程。

## 2. 页面结构

### 2.1 全局导航

| 导航项 | 锚点 | 目的 |
| --- | --- | --- |
| Personal Inbox | `#inbox` | 解释信息如何进入系统。 |
| 记忆面板 | `#memory` | 解释记忆可见与可控。 |
| 主动跟进 | `#initiative` | 解释主动性与权限边界。 |
| 跨工具执行 | `#workspace` | 解释用户授权后能得到什么结果。 |

- 顶部保留 LightVela 品牌、定价入口和“创建个人助理” CTA。
- CTA 打开本地说明弹层；确认链接指向现有 `/auth/sign-in`，不伪造创建成功或真实登录态。
- 当前可视段导航项需有视觉选中态；滚动定位使用原生 anchor 与渐进增强，不强制依赖 `IntersectionObserver`。

### 2.2 Hero：定义运行时

**目的：** 在首屏建立可靠、冷静的个人助理心智。

| 元素 | 必须内容 / 行为 |
| --- | --- |
| Eyebrow | `PERSONAL ASSISTANT RUNTIME` 或等价中文说明。 |
| 主标题 | `一个跨 IM、跨工具、长期在线的个人助理运行时`。 |
| 副标题 | 描述从聊天、链接、截图、文件中收集碎片，形成可控记忆，并在授权内执行。 |
| 核心承诺 | `懂我`、`记得我`、`替我盯事`、`可控执行`，以简短系统状态列呈现，不做大卡片。 |
| 运行表面 | 四到六条真实感样例事件，展示输入识别、记忆沉淀、提醒建议和外部动作确认。 |
| CTA | `创建个人助理` 与 `看看它怎么工作`。 |

Hero 后不得直接跳进“部署三步骤”。背景为冷白至浅青连续渐变与极轻系统网格，视觉衔接到 Inbox，而不是硬切色块。

### 2.3 Personal Inbox：把碎片收进一个地方

**Anchor：** `#inbox`
**标题方向：** `所有碎片，先进一个地方`。

#### 可见内容

- 输入来源：微信、Telegram、Discord、WhatsApp、邮件、网页链接、截图、语音、文件。
- 识别类型：待办、资料、联系人、灵感、日程、项目内容。
- 输出去向：待跟进事项、项目记忆、每日摘要、自然语言查询结果、待确认草稿。

#### 交互

- 使用一组 `button[data-runtime-source]` 选择来源；按钮具备 `aria-pressed`、`aria-controls="inbox-detail"`。
- 选择来源后更新 `#inbox-detail`：源内容摘要、识别标签、归档位置、下一步建议；更新一个 `aria-live="polite"` 状态文本。
- 初始选中“微信消息”，不自动轮播。
- 所有样例都是标记为“示例”的前端模拟数据，点击不上传、不存储、不执行外部动作。

### 2.4 Memory：记忆面板，不是黑箱

**Anchor：** `#memory`
**标题方向：** `记忆面板，不是黑箱`。

#### 必须展示的四类记忆

| 类别 | 示例 | 作用范围 |
| --- | --- | --- |
| 个人偏好 | 写作语气、常用格式、工作节奏、关注领域 | 全局或单个工作区。 |
| 人际关系 | 联系人关系、称呼、常见沟通方式 | 指定 IM 频道。 |
| 项目记忆 | 项目目标、历史决策、待办、会议结论 | 指定项目。 |
| 长期知识库 | 链接、文件、笔记、截图、聊天摘录 | 私人库或指定项目。 |

#### 必须展示的控制信息

- 记忆是否正在生效。
- 作用范围（全局 / 项目 / 指定频道 / 外部回复禁用）。
- 是否属于敏感信息。
- 用户可执行的“查看、编辑、暂停、删除”说明性控件。
- 明确提示：**敏感信息不会自动用于外部回复。**

#### 交互

- 采用 `button[data-runtime-memory-filter]` 切换“正在生效 / 按范围 / 敏感边界”。
- 每次切换更新单一表格 / 列表面板，不建立一组嵌套卡片。
- “查看、编辑、暂停、删除”在概览页仅打开一个可读的“控制说明”弹层，说明真实控制将进入控制台；不可伪造已删除或已保存。
- 删除类说明按钮需有明确可访问名称，例如 `aria-label="删除示例记忆：写作与回复偏好"`。

### 2.5 Proactivity + Permissions：主动，但永远可控

**Anchor：** `#initiative`
**标题方向：** `主动，但永远可控`。

#### 主动性层级

| 等级 | 名称 | 可做的事 | 用户打扰程度 |
| --- | --- | --- | --- |
| 01 | 安静记录 | 提取、归档、关联上下文，不打扰用户。 | 无。 |
| 02 | 温和提醒 | 到点或条件满足时提醒。 | 低。 |
| 03 | 主动建议 | 发现风险、机会或重复模式时提出建议。 | 中。 |
| 04 | 代办草稿 | 先生成消息、邮件或计划，等待用户确认。 | 中，需确认。 |
| 05 | 低风险自动执行 | 归档、标签、提醒、生成摘要。 | 低风险授权后。 |

#### 高风险确认边界

以下动作必须显示为独立“需要确认”组，不能作为自动执行能力暗示：

- 发消息
- 改日历
- 付款
- 删除文件
- 发邮件
- 外部回复

#### 交互

- 使用 `button[data-runtime-proactivity]` 选择任一层级，并在同一个实时活动表面展示该层级的一条可理解样例。
- 改变层级时同步更新“是否需要确认”的状态和权限说明；使用 `aria-live="polite"` 宣告变化。
- 默认选中“安静记录”，保证页面不把侵入式自动化当默认值。

### 2.6 跨工具工作台：在授权内做出去

**Anchor：** `#workspace`
**标题方向：** `给它一项能力，它就能把工作做完一段`。

#### 能力类别

| 类别 | 示例结果 |
| --- | --- |
| 信息抽取 | 从截图 / 文件提取会议结论、待办和联系人。 |
| 写作与回复 | 按个人语气生成消息、邮件、日报或文章草稿。 |
| 归档与查询 | 将链接、笔记、聊天摘录归到项目，供自然语言查询。 |
| 摘要与跟进 | 每日 / 每周摘要、风险提醒、待办 follow-up。 |
| 低风险自动化 | 已授权后创建提醒、整理标签、生成摘要草稿。 |

#### 必须出现的产品解释

> 给它一项能力，它就能把信息抽取、写作、归档、摘要和低风险自动化接进你的工作流。

#### 交互

- 使用 `button[data-runtime-workflow]` 选择能力类别；`aria-pressed` 与 `aria-controls="workspace-result"` 必须同步。
- `#workspace-result` 展示输入、处理、结果草稿和权限状态；选择“低风险自动化”时显式标注“已授权的低风险动作”。
- 不使用 `SkillHub` 作为页面标题、主视觉或认知入口；可在正文说明“已训练能力”，但不出现品牌导流式页面设计。

### 2.7 结尾 CTA

- 标题收束为“让 Hermes 替你记住碎片，也替你盯住结果”或等价句。
- CTA 与首屏保持一致，进入现有认证入口；不承诺不存在的自动创建或立即执行。

## 3. 视觉系统

### 3.1 Token

| Token | 目标 |
| --- | --- |
| 页面底色 | 冷白 `#F6FBFB` 附近，允许极轻青色过渡。 |
| 主文字 | 深青黑，文本对比度达到 WCAG AA（普通文本至少 4.5:1）。 |
| 辅助文字 | 可读灰青，不能因“高级感”降到不可读。 |
| 强调色 | 低饱和蓝青，用于状态、焦点和已选项；不大面积铺色。 |
| 分割线 | 浅青灰细线，作为连续系统界面组织方式。 |
| 阴影 / 模糊 | 仅用于层级和焦点，不形成毛玻璃卡片墙。 |

### 3.2 排版与布局

- Hero 主标题：桌面最大约 64px，移动端 40px；后续段落标题小于 Hero，避免大字报。
- 正文最大行宽约 36 个中文字符；容器最大宽度约 1180px。
- 大段落用 1px 分割线、两列系统表面和留白组织；不以圆角块反复嵌套。
- 不以 Bot / 娃娃作为内容主角；如果有品牌符号，只能作为小状态标记，不可在多个段落重复出现。

### 3.3 动效

- 支持的动效：选中项下划线、状态点切换、结果文本淡入、焦点轮廓过渡。
- 禁止的动效：自动轮播、无语义旋转、全屏粒子、闪烁星星、大光束、强 blur 漂移。
- `@media (prefers-reduced-motion: reduce)` 中关闭所有非必要 transform / transition / animation。

## 4. 前端实现边界

### 4.1 文件职责

| 文件 | 职责 |
| --- | --- |
| `frontend/public/lightvela-overview.html` | 唯一的静态页面模板：语义 HTML、内联 CSS、样例数据和原生交互脚本。 |
| `frontend/src/pages/marketing/__tests__/overview-experience.test.tsx` | 从 `public/` 读取静态 HTML，断言产品心智、必需 section、交互钩子和可访问性约束。 |

`overview-experience.css` 不是本轮实现入口；页面应继续保持单一静态 HTML 可独立预览的性质，避免外部样式文件漂移。

### 4.2 状态模型

本页是静态演示，状态仅存于当前页面内存：

```ts
type RuntimeDemoState = {
  selectedSource: "wechat" | "telegram" | "discord" | "link" | "voice";
  selectedMemoryView: "active" | "scope" | "sensitive";
  selectedProactivity: "capture" | "remind" | "suggest" | "draft" | "auto";
  selectedWorkflow: "extract" | "write" | "organize" | "summarize" | "automate";
};
```

- 页面刷新时回到确定性初始状态：`wechat / active / capture / extract`。
- 禁止 localStorage、Cookie、网络请求和分析追踪。
- 按钮 `data-*` 属性与状态 key 对应，用于测试和可访问性检查：`data-runtime-source`、`data-runtime-memory-filter`、`data-runtime-proactivity`、`data-runtime-workflow`。

### 4.3 事件与焦点管理

- 所有展示状态的切换控制均为原生 `<button type="button">`，不得以 `<div>` 模拟按钮。
- 选中项更新 `aria-pressed`；关联内容容器带稳定 `id` 并由 `aria-controls` 引用。
- 脚本以事件委托或明确绑定方式更新文本，避免内联 `onclick`。
- CTA 弹层使用 `role="dialog"`、`aria-modal="true"`、可见标题和关闭按钮；打开后焦点进入弹层，关闭后返回触发 CTA；支持 Escape 关闭。
- 使用 `aria-live="polite"` 为 source、memory、proactivity、workspace 的状态变化提供简短说明；不在页面加载时朗读整段内容。

## 5. 样例数据与文案真实性

样例数据必须表现真实可理解的个人助理输入与结果，但不宣称已经连接真实账户或已经完成真实操作。

| 场景 | 输入 | 识别 / 结果 |
| --- | --- | --- |
| 微信 | “三天后提醒我再看那篇关于 AI employee 的文章。” | 待办 + 资料链接，归入 Inbox，三天后温和提醒。 |
| Telegram | 项目讨论中的一句“周五前确认发布节奏”。 | 项目待办，关联到项目记忆。 |
| 截图 | 会议白板截图。 | 提取决策、负责人和截止时间，生成待确认摘要。 |
| 语音 | “记一下我喜欢先结论后细节的周报。” | 更新待确认的写作偏好，不自动用于外部回复。 |
| 文档 | 竞品研究 PDF。 | 提取要点、引用链接和后续研究问题。 |

禁止使用假装已发送邮件、已扣款、已改日历、已删除文件等未经确认的结果文案。

## 6. 响应式与兼容性

### 6.1 桌面（≥ 1024px）

- Hero 采用文字与运行表面双列；后续系统面板可采用内容说明 + 交互面板双列。
- 表格式信息保持可扫描列，但不出现横向压缩到不可读的窄列。

### 6.2 平板（640px–1023px）

- Hero 改为单列；运行表面在标题后完整呈现。
- Memory / Proactivity / Workspace 的说明在前，交互面板在后；必要时列表可横向滚动但有可见提示。

### 6.3 手机（< 640px）

- 顶部导航折叠为可横向滚动的锚点链接或一枚可访问菜单，不能让链接覆盖品牌 / CTA。
- 标题、正文和按钮采用单列；最小点击目标 44px。
- 数据面板按单列堆叠，保证 scope、状态、控制信息不被裁切；不把关键状态只靠颜色传达。
- 动画默认减少；无 hover 才能理解的内容。

## 7. 边界、空态与错误态

| 区域 | 状态 | 行为 |
| --- | --- | --- |
| Inbox | 无新内容 | 显示“暂无新素材，转发一条消息、链接或截图即可开始整理。”；不显示空白大卡。 |
| Memory | 筛选无结果 | 显示“当前筛选下没有记忆”，保留筛选控件与恢复入口。 |
| Proactivity | 高风险动作 | 始终显示“需要确认”，不允许 demo 文案暗示自动完成。 |
| Workspace | 未选能力 | 初始默认展示信息抽取示例；不会存在无内容状态。 |
| 弹层 | 无脚本 / 脚本失败 | CTA 链接仍可通过正常 href 进入 `/auth/sign-in`，不能成为死按钮。 |

## 8. 测试与验证

### 自动化

- 静态单测断言：定位句、五个 anchor、Memory 可控边界、主动性高风险动作、跨工具能力句、浅青 token、reduced-motion、dialog、可访问交互钩子。
- 测试不能依赖视觉 class 名以外的偶然布局；应聚焦用户可感知内容和稳定语义结构。
- 执行：

```bash
cd frontend
pnpm exec vitest run src/pages/marketing/__tests__/overview-experience.test.tsx
pnpm check
```

### 浏览器验收

1. 1440px：逐段确认 Hero → Inbox → Memory → Proactivity → Workspace 的叙事连续；无硬切深色背景、无卡片墙、无大娃娃。
2. 390px：确认导航、CTA、列表和每组选择器可见、可触达、无横向截断。
3. 键盘：Tab 到每个 selector，Space / Enter 可切换；焦点可见；弹层可 Escape 关闭并回到触发按钮。
4. reduced-motion：系统偏好开启时不播放自动动画，信息仍完整可读。
5. 手动检查：所有正文、次级正文、交互状态均达到可读对比，不以低对比“高级感”牺牲信息。

## 9. 验收边界

- 本轮的“可直接用”指页面作为可交互的产品概览可被浏览和理解，而非已接入真实 IM、记忆系统或执行器。
- 真实账户接入、记忆编辑持久化、任务执行和权限策略属于后续控制台 / 后端需求，需独立 API、安全与审计设计后再启动。
