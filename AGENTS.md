# 📋 Lightclaw Monorepo - AI Agent 规范

> 本文档是 AI 助手在 **Lightclaw monorepo 根目录**的行为规范和导航指引。
>
> ⚠️ **本文件只承载 monorepo 级别的跨服务约定**（feai 流程、TAPD/MR 规范、Skills、核心原则、MCP 配置）。
> 具体子服务的技术栈、架构、代码细节请阅读对应子目录下的 `AGENTS.md`。
>
> 模板版本: v2.0.0 | 更新时间: 2026-04-22

---

## 一、仓库概览与子服务导航

| 字段           | 内容                              |
| -------------- | --------------------------------- |
| **项目名**     | Lightclaw                         |
| **仓库**       | `git.woa.com/wisp/mono`           |
| **TAPD 项目**  | 10132091                          |
| **默认分支**   | `master`                          |
| **仓库形态**   | monorepo（多语言、多服务）        |
| **包管理（FE）**| pnpm（workspace）                 |

### 子服务导航表

> 🎯 **重要原则**：每个子服务维护**自己的 `AGENTS.md`**。AI 在为某个子服务工作时，**应优先阅读该子服务的 `AGENTS.md`**，本根文件仅提供跨服务通用规范。

| 子目录 | 技术栈 | 类型 | AGENTS.md |
|---|---|---|---|
| `frontend/` | React 19 + TS + Vite + Tailwind + shadcn | 前端（主）| [frontend/AGENTS.md](frontend/AGENTS.md) + [frontend/openspec/](frontend/openspec/) |
| `frontend-ds/` | 前端设计系统 | 前端 | [frontend-ds/AGENTS.md](frontend-ds/AGENTS.md) |
| `nextgen-dashboard/` | 下一代控制台前端 | 前端 | [nextgen-dashboard/AGENTS.md](nextgen-dashboard/AGENTS.md) |
| `gateway-dashboard/` | 网关控制台前端 | 前端 | [gateway-dashboard/AGENTS.md](gateway-dashboard/AGENTS.md) |
| `cloudladdergateway/` | Go + Connect + Gin | 条件代理/Webhook 网关 | [cloudladdergateway/AGENTS.md](cloudladdergateway/AGENTS.md) |
| `ai-gateway/` | Go | 后端服务 | [ai-gateway/AGENTS.md](ai-gateway/AGENTS.md) |
| `service-gateway/` | Go | 后端服务 | [service-gateway/AGENTS.md](service-gateway/AGENTS.md) |
| `admin-gateway/` | Go | 后端服务 | [admin-gateway/AGENTS.md](admin-gateway/AGENTS.md) |
| `ctl/` | Go | 命令行/控制 | [ctl/AGENTS.md](ctl/AGENTS.md) |
| `user/auth/` | Go | 用户认证 | [user/auth/AGENTS.md](user/auth/AGENTS.md) |
| `subscription/` | Go | 订阅服务 | [subscription/AGENTS.md](subscription/AGENTS.md) |
| `payment/` | Go | 支付服务 | [payment/AGENTS.md](payment/AGENTS.md) |
| `shadow/` | Go | 影子账号服务 | [shadow/AGENTS.md](shadow/AGENTS.md) |
| `sandbox/` | Go / 沙箱 | 云主机 Mock | [sandbox/AGENTS.md](sandbox/AGENTS.md) |
| `infra_pulumi/` | Pulumi / IaC | 基础设施 | [infra_pulumi/AGENTS.md](infra_pulumi/AGENTS.md) |

### 统一发布模型

> 全仓库服务（除特殊说明外）均已切换到 **Argo CD** 发布模型：
> - source-facing 真源：`<service>/k8s/base/` + `<service>/k8s/overlays/<env>/`
> - deploy-facing 真源：`argocd/services/<service>/<env>/`
> - 统一镜像构建命令：`python3 .ci/runtime/commands/build_release_image.py --service <service> --env <env> --tag <tag>`

### 当前发布分支模型（P0）

当前这份工作区对应的是：

- 仓库：`git@git.woa.com:wisp/mono2.git`
- 源码分支：`master`
- GitOps 发布分支：`gitops`

执行约束：

- `master`
  - 只负责源码变更和镜像构建
  - 不作为 Argo 的 live 发布真源
- `gitops`
  - 是 Argo 当前实际跟踪的发布分支
  - 只承载 deploy-facing 变更
- `Application.spec.source.targetRevision`
  - 默认应指向 `gitops`

环境发布策略：

- `beijing-sandbox`
  - `master` push 后自动构建镜像
  - 自动创建到 `gitops` 的发布 MR
  - 自动合并 MR
- `shprod`
  - 不自动跟随 `master`
  - 必须手动触发 promote
  - 创建到 `gitops` 的发布 MR
  - 由人工合并

当前正式发布入口是：

- `argocd/root/*.yaml`
- `argocd/apps/<env>/`
- `argocd/services/<service>/<env>/`

正式发布判定标准：

1. live app 的 `repoURL` 等于 `git@git.woa.com:wisp/mono2.git`
2. live app 的 `targetRevision` 等于 `gitops`
3. live app 的 `revision` 等于本次合入 `gitops` 的提交
4. Kubernetes 实际 workload image 等于目标 tag
5. live app 达到 `Synced / Healthy`

不要把下面这些当作正式发布完成标准：

- 只看 `master` 已提交
- 只看镜像已经推送成功
- 只看 promote 分支已经创建
- 只看 GitOps MR 已创建但还没合并

前端额外确认：

1. `argocd/services/frontend/<env>/frontend-platform.env` 指向目标镜像 tag
2. 公网 `index.html` 引用的 `/assets/index-*.js` hash 与新镜像内 `/usr/share/nginx/html/index.html` 一致

补充约束：

- 如果页面仍是旧版本，先比较公网 `index.html` 资产 hash 与镜像内 `index.html`；hash 仍旧通常说明新镜像未真正收敛到 live workload，或边缘缓存仍在返回旧 HTML。
- Argo 长时间停在旧 revision 时，可对 app 加 `argocd.argoproj.io/refresh=hard` 强刷后再观察 sync / rollout。
- 上海正式环境前端构建命令固定使用 `cd frontend && pnpm install && pnpm build`，不要用 `pnpm update`。

### Playground 环境创建约束（P0）

创建或修复 `sandbox-bj-N` / `beijing-playground` 环境时，必须先阅读 `.ci/AGENTS.md` 的“Playground 环境创建提示词（P0）”。

特别注意：

- 长期配置必须进入 `gitops` MR；live patch 只能作为诊断和临时解锁。
- 固定入口使用单域名证书；实例 wildcard 入口默认 HTTP-only。
- 不要复用不覆盖目标 host 的 TLS cert。
- SOPS secret 克隆后必须校验 payload 已经指向目标环境，不要只看 metadata、文件名或 namespace。

### 新环境实名 SSM 预置（P0）

创建或发布新的测试/正式环境时，只要环境包含 `lightclaw-auth`，或 `service-gateway` 写路由启用了
`require_realname: true`，AI 必须先确认该环境的 Tencent Cloud SSM secret 已预置实名依赖键：

- `TENCENT_REALNAME_SECRET_ID`
- `TENCENT_REALNAME_SECRET_KEY`
- `TENCENT_REALNAME_ENDPOINT`
- `REALNAME_ENCRYPTION_KEY`

执行约束：

- SSM 命名沿用 `mono-<env>-lightclaw-auth-secrets`，以环境实际 manifest 为准。
- 新环境可以复用腾讯实名 API 的 `SecretId/SecretKey/Endpoint`，但 `REALNAME_ENCRYPTION_KEY` 必须按环境单独生成，不能跨环境复制。
- `REALNAME_ENCRYPTION_KEY` 必须是标准 base64，解码后正好 32 字节，例如 `openssl rand -base64 32`。
- 更新 SSM 后必须用 `scripts/export_ssm_to_sops.py --manifest scripts/ssm_manifest.lightclaw-auth.<env>.yaml --only lightclaw-auth-secrets`
  重新生成 `argocd/secrets/<env>/lightclaw-auth-secrets.sops.yaml`，并运行 `python3 scripts/scan_secrets.py <sops-file>`。
- 验证时只输出键名、存在性、长度/解码字节数；不要打印 Secret 值。
- 如果缺少或格式错误，`lightclaw-auth` 会禁用实名 cipher，`/auth/realname/verify` 返回 `realname_unavailable`，
  进而导致 gateway 已开启实名门禁的写操作被阻断。

---

## 二、核心命令速查

### 🚀 feai 日常开发命令

| 命令            | 说明                                                         |
| --------------- | ------------------------------------------------------------ |
| `/feai-start`   | **启动开发流程** — 从需求分析到创建 MR 的完整链路            |
| `/feai-archive` | **归档沉淀** — 将开发成果沉淀到项目知识库（OpenSpec）         |
| `/feai-init`    | **项目初始化** — AI 分析项目代码，生成 AGENTS.md 深度信息 + openspec 文档 |

**常用参数**：
- `--quick` — 快速修复模式（小 Bug、文案修改）
- `--full` — 完整流程模式（大型需求、新模块）
- `--yes` — 信任模式（减少确认交互）

> ⚠️ **monorepo 使用提示**：执行 `/feai-init`、`/feai-start` 等命令时，**请先进入对应子服务目录**（如 `cd frontend/`），
> 否则生成的 `AGENTS.md` / `openspec/` 会落到仓库根目录，污染跨服务规范文件。

> 📄 **详细说明**：[feai-start.md](.codebuddy/commands/feai-start.md) | [feai-archive.md](.codebuddy/commands/feai-archive.md) | [feai-init.md](.codebuddy/commands/feai-init.md)

---

## 三、规范体系总览

项目配置了 **22+ 个 Skills（按需调用技能）** + **OpenSpec 规范驱动开发系统**。

### 两大系统职责分工

| 系统 | 定位 | 触发命令 |
|------|------|----------|
| **⚡ Superpowers** | 需求分析 & 驱动开发 | `/feai-start` |
| **📐 OpenSpec** | 规范沉淀 & 变更管理 | `/feai-archive` |

### 规范文件清单

```
.codebuddy/               # 跨子服务共享（位于仓库根）
├── skills/
│   ├── superpowers/         # Superpowers 原生 Skills（14 个）
│   └── team-extensions/     # 团队扩展 Skills（11 个）
│       ├── cr-check.md              # 代码审查规范
│       ├── code-writing.md          # 代码撰写规范
│       └── ...
├── commands/
│   ├── feai-start.md        # 启动开发流程
│   ├── feai-archive.md      # 归档沉淀
│   └── feai-init.md         # 项目初始化
└── agents.md                # （历史遗留，与本文件同义）

.skills/                  # 项目内团队共享 Skills（AI 按需读取）
└── gongfeng/
    ├── SKILL.md             # 工蜂 MCP / MR / 分支 / 评论操作说明
    └── DEPENDENCIES.md      # mcporter-internal 依赖说明

AGENTS.md                 # 本文件（monorepo 全局规范）

<service>/AGENTS.md       # 各子服务独立指引（见上方导航表）
<service>/openspec/       # 各子服务独立规格文档（目前仅 frontend/ 落地）
codesign/                # EdgeOne / 子账号 / 权限模型 / 测试发布协作文档
```

> 📌 **OpenSpec 作用域**：monorepo 下 OpenSpec 文档**下沉到各子服务内部**维护，不集中在根目录。当前仅 `frontend/openspec/` 已落地。

### 协作工作区：`codesign/`

`codesign/` 是一个面向**跨角色协作**的工作区，重点沉淀：

- EdgeOne Pages 测试发布流程
- 腾讯云子账号 / CAM 策略 / 权限边界设计
- 实际创建记录、使用说明、排障经验

适合优先阅读它的人包括：

- 新加入的工程 agent
- 需要理解发布边界和权限模型的运维 / 平台 agent
- 新加入协作的产品经理 agent

对产品经理 / 协作型 agent 的引导：

- 如果需求涉及 **EdgeOne 测试发布、测试项目协作、权限模型、EO Pages 子账号管理**，
  先阅读 `codesign/`，再决定是否需要深入到具体服务目录。
- `codesign/README.md` 是入口；
  `edgeone-preview-operator.md` 偏“怎么用”，
  `tencent-cloud-edgeone-preview-account-provisioning.md` 偏“怎么创建与为什么这样设计”。

---

## 四、核心原则（P0 优先级）

### 不可违背原则

| 原则            | 说明                                                    |
| --------------- | ------------------------------------------------------- |
| 🔒 安全第一     | P0 优先级处理 XSS/注入/敏感信息，绝不妥协               |
| 🔧 Lint 驱动质量 | 遵循项目各自的 Lint/格式化配置，代码修改后运行 lint 确保通过 |
| ✅ 证据优于声明 | 验证后再宣布完成，所有「完成」声明必须有测试/截图等证据 |

### 强烈推荐原则

| 原则                    | 说明                                                     |
| ----------------------- | -------------------------------------------------------- |
| 🧪 TDD 测试驱动         | 推荐先写测试再写代码；测试不通过不能合入                 |
| 📐 OpenSpec 双重角色    | 开发前提供项目上下文，开发后归档沉淀功能规范文档         |
| ⚡ Superpowers 分析需求 | 用 Superpowers 分析需求、驱动开发、交付代码               |
| 🚫 禁止 any（TS 项目）  | 使用 `unknown` 或具体类型替代                            |

---

## 五、流程保持协议（铁律）

> **本章节确保 AI 在整个开发周期内保持流程意识，无论对话进行到哪一轮。**

### 阶段感知

通过 `/feai-start` 启动开发流程后，AI 必须在整个开发周期内保持以下意识：

1. **阶段追踪**：每次回复前，先判断当前处于哪个开发阶段（需求分析 / 开发实现 / 自检提交）
2. **流程连续性**：后续对话中的需求补充、澄清、变更，都在当前流程上下文中处理，不脱离已建立的开发流程
3. **增量优先**：需求变更时，在已有成果基础上增量修改，而非推倒重来

### 质量门禁（不可跳过）

无论对话进行到哪一轮，以下门禁始终生效：

| 门禁 | 说明 | 时机 |
|------|------|------|
| **Lint 通过** | 运行项目 lint 命令，确保无错误 | 每次代码修改后 |
| **测试通过** | 运行项目测试命令（如有） | 提交前 |
| **类型检查** | 运行项目类型检查命令（如有） | 提交前 |

> 💡 具体命令请查看**对应子服务的 `AGENTS.md`** 或该子目录下的 `package.json` / `Makefile`。

### FE-AI 标记（不可遗漏）

| 标记位置 | 格式 | 说明 |
|----------|------|------|
| Commit message | `[FE-AI] feat(xxx): ...` | 用于提效数据统计 |
| MR 标题 | `[FE-AI] feat: xxx` | 用于提效数据统计 |
| MR 标签 | `FE-AI` | 用于提效数据统计 |
| TAPD 需求标签 | `FE-AI` | 自动添加，标记 AI 辅助开发 |

### 不可逆操作确认

以下操作无论是否开启信任模式，都**必须先展示内容，征得用户确认后才能执行**：

- `git commit` / `git push` — 展示提交内容
- `create_merge_request` — 展示 MR 信息

---

## 六、开发流程概览

### 流程选择矩阵

| 模式 | 适用场景 | 执行阶段 |
|:----:|----------|----------|
| 🟢 **快速修复**（`--quick`） | 小 Bug、文案修改、样式调整 | 1 → 4 → 5 |
| 🟡 **标准开发**（默认） | 中等功能需求、组件开发 | 0 → 1 → 2 → 3 → 4 → 4B → 5 |
| 🔴 **完整流程**（`--full`） | 大型需求、新模块、跨页面功能 | 0 → 1 → 2 → 2B → 3 → 4 → 4B → 5 → 6 |

### 标准开发流程

```
📐 OpenSpec 上下文加载（子服务下沉维护）
        ↓
📋 获取 TAPD 需求 + 🏷️ 自动添加 FE-AI 标签
        ↓
🧠 苏格拉底式提问 → 生成需求确认文档
        ↓
⏸️ 等待用户确认
        ↓
💬 对话式需求澄清（如需要）
        ↓
🌿 创建开发分支
        ↓
📝 任务拆分 → 🧪 TDD 开发（推荐） → 💻 代码实现
        ↓
📦 代码提交 ([FE-AI] 前缀) → 🔗 关联 TAPD
        ↓
✅ 自检（运行对应子服务 lint/test 确保通过） → 🔍 创建 MR (FE-AI 标签)
        ↓
📐 提示运行 /feai-archive 归档沉淀
```

> 📄 **详细流程说明**：[.codebuddy/commands/feai-start.md](.codebuddy/commands/feai-start.md)

### 动态项目配置

项目配置采用「自动探测 + 本地缓存 + 手动补充」的三层策略：

| 优先级 | 来源 | 说明 |
|:------:|------|------|
| 1️⃣ | `.codebuddy/project.local.json` | 本地项目配置（不提交到仓库） |
| 2️⃣ | 自动探测 | 从 `git remote` 获取 projectId，从 `git branch` 获取 defaultBranch |
| 3️⃣ | TAPD 链接解析 | 从用户输入的 TAPD 链接中解析 workspace_id |
| 4️⃣ | 提示用户 | 关键信息缺失且无法自动获取时，提示用户填写 |

### TAPD ID 转换规则

| ID类型 | 位数 | 说明 |
|--------|:----:|------|
| 完整ID | 19位 | API使用：`10{workspace_id}{shortID}` |
| 短ID | 8-9位 | 界面显示 |

### 信任模式（`--yes`）

启用后，仅保留关键确认点，其余自动执行：

| 确认点 | 默认模式 | 信任模式 |
|--------|:--------:|:--------:|
| 需求确认文档 | ⏸️ 必须确认 | ⏸️ 必须确认 |
| 分支创建 | ⏸️ 询问确认 | ✅ 自动执行 |
| TAPD 分支关联 | ⏸️ 询问确认 | ✅ 自动执行 |
| 代码提交 | ⏸️ 必须确认 | ⏸️ **必须确认** |
| 创建 MR | ⏸️ 必须确认 | ⏸️ **必须确认** |

### MCP 错误恢复策略

| MCP 操作 | 关键性 | 失败策略 |
|----------|:------:|----------|
| `stories_get` / `bugs_get` | 🔴 关键 | 阻塞，提示用户检查 ID 或 Token |
| `stories_update`（添加标签） | 🟡 非关键 | ⚠️ 警告后继续 |
| `create_branch` | 🔴 关键 | 阻塞，提示用户检查权限 |
| `add_git_branch_to_object` | 🟡 非关键 | ⚠️ 警告后跳过 |
| `create_merge_request` | 🔴 关键 | 阻塞，提示用户检查分支/权限 |

---

## 七、对话式开发

### 需求澄清阶段

AI 生成需求确认文档后，用户可能需要进一步澄清或调整需求。此时 AI 应：

1. **主动提问**：对模糊的需求点提出具体问题，提供 2-3 个选项供用户选择
2. **增量更新**：根据用户反馈增量修改需求确认文档，而非重新生成
3. **对齐确认**：每轮澄清后，简要总结变更点，确认双方理解一致

### 开发过程中的需求变更

开发过程中用户可能补充或调整需求，AI 应：

1. **评估影响**：分析变更对已完成工作的影响范围
2. **增量调整**：在已有代码基础上增量修改，而非推倒重来
3. **同步更新**：同步更新需求确认文档和实现计划

### 对话式开发原则

| 原则 | 说明 |
|------|------|
| 📝 增量优先 | 在已有成果基础上增量修改，避免重复劳动 |
| 🔄 及时同步 | 需求变更后及时同步文档和计划 |
| ⏸️ 适时确认 | 重大变更前暂停确认，小调整直接执行 |
| 🧠 上下文保持 | 保持对话上下文连贯，不丢失之前的讨论结论 |

---

## 八、MCP 服务配置

### 已接入的 MCP 服务

| 服务             | 用途                                 |
| ---------------- | ------------------------------------ |
| **TAPD MCP**     | 需求获取、任务管理、分支关联         |
| **Gongfeng MCP** | 分支管理、MR 创建、文件操作、CR 评审 |

### 工蜂 Skill 读取约定

当任务需要工蜂能力时（包括但不限于分支管理、MR 创建/查询/合并、MR 评论、代码审查、文件操作），AI 必须先读取 `.skills/gongfeng/SKILL.md`，并按其中的工具调用方式执行。

---

## 九、参考链接

- [OpenSpec](https://github.com/openspec) — 规范驱动开发系统
- [Superpowers GitHub](https://github.com/obra/superpowers) — AI 开发工作流
- [TAPD](https://tapd.woa.com) — 需求管理
- [Gongfeng](https://git.woa.com) — 代码仓库

---

<!--
模板变量说明（供 init-project.sh 使用）:

| 变量                  | 说明               | 示例                                          |
| --------------------- | ------------------ | --------------------------------------------- |
| 我的项目      | 项目名称           | 私有域解析 Private DNS 控制台（pvtdns-console）|
| React + TypeScript        | 技术栈             | React 18 + TypeScript                         |
| @tencent/tea-component           | UI 组件库          | @tencent/tea-component                        |
| react-router-dom           | 路由方案           | react-router-dom（Hash 路由）                 |
| Jest 29   | 测试框架           | Jest 29 / Vitest                              |
| git.woa.com/wisp/mono   | Gongfeng 仓库路径  | lightcloud-fe/httpdns/httpdns-console-tea2     |
| 10132091| TAPD 项目 ID       | 10132091                                      |
| master   | 默认分支           | master                                        |
| 2026-04-21     | 生成时间           | 2026-03-23                                    |

深度信息章节（二~六）由 /feai-init 命令自动填充，
init-project.sh 只负责替换上述基础变量。
-->
