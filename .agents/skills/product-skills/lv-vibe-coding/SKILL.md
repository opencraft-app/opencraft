---
name: lv-vibe-coding
description: LightVela Vibe Coding / AI Coding 流程指南，适用于需求澄清、issue 建单、/feai-start 开发、评审、提 MR、合并、发布与回归验证等研发协作场景。
---

# LightVela Vibe Coding · Web Coding 完整流程

> **用途**：给在 LightVela 中使用 FE-AI / AI Coding / Vibe Coding 方式完成需求澄清、建单与开发的同学，一份"从提需求到看到线上效果，照着做就不翻车"的 SOP。
>
> **核心承诺**：拿到这一份 skill，你不需要再问任何人"接下来该干什么"——从第一次提需求，到最后在 `lightvela.com`（国内）或 `lightvela.ai`（国际）上看到自己做的功能，每一步该做什么、找谁、命令怎么打，本文档都有。
>
> **不用背，用到再查**。跑通一次流程你就熟了。

---

## 全流程总览（先看这里）

```
【第 1 步】需求定义：提 issue（需求单）
        ↓
【第 2 步】开发：拉最新 master → 开分支 → /feai-start（需求澄清已切到 prd-creator） → 编写代码 → /feai-review
        ↓
【第 3 步】本地/预览环境验证效果
        ↓
【第 4 步】本地代码评审（建议换模型）
        ↓
【第 5 步】/feai-archive 归档 → commit → 拉最新 master 解决冲突 → push
        ↓
【第 6 步】提 MR（target = master，关联 issue 编号）← 一个需求只开一个分支，一个 MR
        ↓
【第 6B 步】（按需）产品/法务 PRD 沉淀到 wiki/prd-docs
        ↓
【第 7 步】Fanny 自动 CR → 人工 CR（@ owner）→ 找方明 第一步合并 → 找审批人批准
        ↓
【第 8 步】分批发布（有周期，攒一批一起发）→ 回归验证
        ↓
【完成！】在 lightvela.com（国内）或 lightvela.ai（国际）看到你的功能上线 ✅
```

> **本文档的每一节末尾都会告诉你"下一步做什么"**。请沿着流程走，不要跳步。

---

## 一、LightVela 是什么？（30 秒版本）

- **产品**：LightVela 轻云平台（AI 时代的云上工作台）。
- **主域名**：`https://lightvela.com`（**国内站**）、`https://lightvela.ai`（**国际站**，**发布后做回归验证用这个**）。
- **代码仓**：`wisp/mono2`（monorepo，主分支 `master` 同时承载国内 + 国际站，编译期 `isCN` / `isGlobal` 分流）。
- **架构大图**：前端 (React 19 + Vite / Next 双栈) → gateway (service-gateway / admin-gateway / cloudagent) → 各业务后端 (Go/Rust)。
- **需求单载体**：工蜂（git.woa.com）的 **Issue**。任何一个功能/Bug/技术需求，第一步永远是先开一个 issue，issue 就是"需求单"。

### 关键链接（收藏夹版）

| 场景                   | 链接                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| 项目仓库               | https://git.woa.com/wisp/mono2/                                                                      |
| 提 Issue 入口          | https://git.woa.com/wisp/mono2/issues                                                                |
| Roadmap                | https://git.woa.com/LightVela_CoDesign/Wiki/blob/master/LightVela%20%E5%8A%9F%E8%83%BD%20Roadmap.md |
| 项目共识 Wiki          | https://git.woa.com/LightVela_CoDesign/Wiki/                                                         |
| **Fanny CR bot**       | https://work.weixin.qq.com/wework_admin/common/openBotProfile/24113cfd2995f7cbb522cec5d1655669a6     |
| **发布后回归验证地址** | 国内 https://lightvela.com ／ 国际 https://lightvela.ai                                              |

### owner 索引（找人合并 / CR / 拍板时用）

- 前端主 owner：**sarahzzhang（张霞辉）** —— 前端代码 CR、合并 master 找她
- 后端主 owner：**skipzhang（张金栋）** —— 后端代码 CR、CI/GitOps 问题找他
- 产品后台改动：**先私聊 `walkercao（walker）` 和 `skipzhang`**，对齐影响范围、联调方式和上线风险后再动
- 设计主 owner：**jacoyang** —— UI/交互方案确认找他

### 协作群 & 发布节奏（必看）

- **Vela 协作群**：团队日常协作、答疑都在「Vela 协作群」。有疑问、找不到人、不确定找谁，**直接在群里问**，别自己憋着。
- **Fanny 是什么**：Fanny 是**研发侧自研的 AI Code Review 机器人**（不是外部工具）。提出 MR 后，先在群里 @Fanny 跑一轮自动初审。
- **第一步合并找 方明**：Fanny 初审完、你觉得改得差不多了，**直接找 方明 进行第一步的合并**最顺。
- **审批人才点头发货**：提了 MR 之后，**记得去找审批人（approver）批准**，批准通过才会进入发布流程。
- **发布是分批的**：发布一般有固定周期，**会攒一批一起发**，不是每合并一个就立刻单独发。合进 master 后通常不会立刻上线，请耐心等同批的发布窗口。

> 📌 **这一节你读完之后**：下一步去读"二、仓库导览"，了解代码在哪里；如果已经熟悉结构，可以直接跳到"三、第 1 步·提 issue"开始上手。

---

## 二、仓库导览（`wisp/mono2` 30 秒版本）

```
mono2/
├── frontend/            # 主前端（React 19 + Vite + Tailwind + shadcn）+ next-site（Next.js 文档/营销站）
├── gateway-dashboard/   # 运营后台（Next.js，admin.lightclaw.tech 下）
├── service-gateway/     # 主业务网关（Go）
├── admin-gateway/       # 运营网关（Go）
├── cloudagent/          # Agent 运行时（Rust / Go）
├── ticket/              # 工单/反馈后端（Go）
├── trade/               # 交易/计费（Go）
├── payment/ subscription/ ai-gateway/ workers/ shadow/ sandbox/ ...
├── argocd/              # GitOps 部署配置（Kustomize）——合并进 master 之后就是靠它自动发布
├── .ci/                 # CI runtime（Python 变更目录 guard 派发）
├── .codebuddy/commands/ # feai 三大命令定义（/feai-start /feai-review /feai-archive /feai-init）
├── AGENTS.md            # ← 项目根「宪法」，先读它
└── frontend/AGENTS.md   # ← 前端子服务的补充铁律，做 frontend 之前也读
```

**每次动手前先读**：

1. `mono2/AGENTS.md`（G1–G22 全局铁律）
2. 你要动的子服务的 `AGENTS.md`（如 `frontend/AGENTS.md`、`ticket/AGENTS.md`）
3. `<子服务>/openspec/`（如果有，OpenSpec 是"唯一事实来源"）

> 📌 **读完之后**：**下一步进入"三、第 1 步·提 issue"**——动手写代码之前，先开需求单。

---

## 三、第 1 步 · 需求定义：先开一个 Issue（需求单）

> **这是整条链路的起点，也是最容易漏的一步**。不管你是产品经理、设计师，还是研发自己发现了一个技术债——**动手写代码之前，先有一个 issue**。issue 就是你和团队/AI 之间"要做什么、做完什么样叫完成"的唯一契约。

> ⚠️ **开 issue 必填一项：这个功能/需求是「国内站」还是「国际站」？**
> - 国内站在 `lightvela.com`，国际站在 `lightvela.ai`，**两个站要分开标注**，不能混着写。
> - 如果是**国际站**需求，还要额外注明：**多语种版本和中文版本都要同步做、同步验收**，漏掉哪一边的文案/逻辑都算没做完。

### 3.1 怎么提

直接跟 AI 说人话即可，不需要自己去工蜂网页上一个字段一个字段填：

```
给 mono2 快速提个 issue：给用户加一个产品反馈入口，能提交文字+截图
```

AI 会自动：

1. **反思需求**：判断这是 Bug / 体验优化 / 新功能 / 技术需求，推断复杂度
2. **必要时反问 1-2 个问题**（信息缺到没法写清楚才问，不逐字段问你）
3. **自动填好全部字段**并产出完整草案（元信息表 7 字段 + 背景 + 需求详情 + 验收标准）
4. 附一句 **📌 我的推断**，让你快速 check 它的判断依不依你的预期
5. 你回一句 **"OK"**，AI 就会调用工蜂接口创建 issue，并回填标签，把 **issue 编号（iid）+ 链接** 发给你

### 3.2 一份合格的 issue 长什么样

```markdown
## 需求元信息

| 字段         | 内容               |
| ------------ | ------------------ |
| 需求名称     | 用户反馈入口        |
| 起草人       | <你的 username>     |
| 负责人       | <你的 username>     |
| 当前状态     | 🟡 待评估           |
| 目标上线窗口 | 待定                |
| 标签         | 新功能-复杂度中     |
| 预览地址     | -                   |

## 背景
（1-2 句话：为什么要做）

## 需求详情
### 前端
- ...

## 验收标准
- [ ] 用户能在个人页看到"反馈"入口
- [ ] 提交后能上传截图/文件
- [ ] 后台能看到收到的反馈
```

**记住这份 issue**：后面开分支、写 commit、提 MR，全都会带上这个 issue 编号，方便一路追溯"为什么要做这个改动"。

> 📌 **issue 创建成功之后**：**下一步进入"四、第 2-3 步·开发 + 本地预览"**。记下 issue 编号（如 `#123`），待会 `/feai-start` 会先调用 `prd-creator` 做需求澄清，再进入 plan / 分支流程。

---

## 四、第 2-3 步 · 开发 + 本地预览（3 命令走天下）

**核心心法**：拿到 issue 之后，一切走 `feai` 三段式，别自己发挥。命令详情不用背，直接触发它会自己教你怎么用。

```
       ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────┐
       │  /feai-start    │───▶│  /feai-review   │───▶│  /feai-archive   │
       │  issue → prd-creator 澄清   │    │  批次门禁 CR    │    │  沉淀 OpenSpec   │
       │   → 分支 → plan.md    │    │  (每 1-3 任务)  │    │  → commit → MR   │
       └─────────────────┘    └─────────────────┘    └──────────────────┘
             ↑                          ↑                       ↓
      (先 cd 到子服务)         (每批编码后都要跑)         (归档 → push → MR)
```

### 4.1 开发前：先拉最新 master

```bash
git checkout master
git pull origin master        # 保证你是在最新代码基础上开分支
```

### 4.2 `/feai-start` — issue → prd-creator 澄清 → 分支 → plan.md

**做什么**（AI 会自己走 8 步，你只用回答问题）：

1. 加载 `openspec/` 上下文
2. 调用 `prd-creator` 做一轮需求澄清 / 产品前置（**这里可以直接把 issue 链接/编号丢给它**）
3. 生成 `openspec/proposal.md` + `openspec/plan.md`
4. **等你确认 plan** ← 这一步不要跳
5. 创建分支（`frontsandbox/<slug>`）
6. 后续进入执行阶段（每批 1-3 任务）

> ⚠️ **现在前端 workflow 里的 `/feai-start`，需求澄清阶段已经切到 `prd-creator`**。所以你看到它先澄清需求、再落 plan / 分支，是正常流程，不是跑偏。

**重要**：**先 `cd frontend/`（或其他子服务）再敲命令**，不然 `AGENTS.md` / `openspec/` 会污染仓库根。

```bash
cd frontend/
/feai-start "用户反馈入口（issue #123）"
```

### 4.3 `/feai-review` — 批次质量门禁

**什么时候用**：每写完 1-3 个任务，**立即**跑一次。

对照 `gate-implementation.md` 逐项自检（lint、tsc、i18n、测试、影响面……）。**不通过就不能提交下一批。**

不用记参数，直接敲 `/feai-review` 就行（不带参 = 自动识别本批未标 `[x]` 的任务）。

### 4.4 本地预览（第 3 步）

- **frontend（Vite）**：`pnpm dev -- -H 127.0.0.1 -p 5174`（记得先注入 `NEXT_PUBLIC_AUTH_API_BASE_URL` 等环境变量，见踩坑清单坑 4）
- **next-site（Next.js 文档/营销站）**：不要用 `pnpm dev -- -H ...`，直接调二进制（见坑 4）：
  ```bash
  node_modules/.bin/next dev -H 127.0.0.1 -p 5175
  ```
- **更省心的替代方案**：直接把分支 push 上去（`frontsandbox/<name>`），2 分钟内自动出预览域名，不用在本地折腾环境变量：
  - 国内：`https://<name>.preview.lightclaw.tech`
  - 国际：`https://intl-<name>.preview.lightclaw.tech`

**预览 OK 的判断标准**：拿 issue 里的"验收标准"逐条对照，全部打勾才算 OK，进入下一步。

> 📌 **预览全部验收标准打勾之后**：**下一步进入"五、第 4-6 步·本地评审 → commit → 提 MR"**。不要一边预览一边直接 push，先走评审再 commit。

---

## 五、第 4-6 步 · 本地评审 → commit → 合并冲突 → 提 MR

### 5.1 第 4 步：预览 OK 后，本地代码评审（建议换一个模型/Agent）

**为什么要换模型**：写代码和审代码用同一个模型，容易"自己骗自己"（同样的思维盲区看不出问题）。

**怎么做**（任选一种）：

- 开一个新对话，换一个模型/Agent，把 `git diff master...HEAD` 的内容贴给它，明确要求"**只审查不改代码**，重点看安全（XSS/注入/密钥硬编码）、AGENTS.md 铁律（禁用 `any`、错误处理）、逻辑漏洞、未用依赖"
- 或者直接跑一次额外的 `/feai-review`（它本身也会做门禁自检，但不能替代"换个视角"的价值）

> 📌 **评审没有发现问题（或问题已修复）之后**：**下一步走第 5 步：归档 → commit**。

### 5.2 第 5 步：完成后 commit → 再拉最新代码 → 本地合并解决冲突

**先归档再 commit**（`/feai-archive` 会生成 OpenSpec 归档产物并入 commit）：

```bash
/feai-archive        # 生成 openspec/changes/{date}-{name}.md，更新 spec.md
```

**归档后才 commit**：

```bash
git add -A
git commit -m "feat(frontend): 支持用户反馈入口（issue #123）"
```

**再拉一次最新 master，本地解决冲突**（因为你开发期间 master 可能已经被别人合并了新代码）：

```bash
git fetch origin master
git merge origin/master      # 把 master 最新合进来
# 如果有冲突：
#   1. 打开冲突文件，手动决定保留哪部分（不确定就问 AI 或 owner）
#   2. git add <解决后的文件>
#   3. git merge --continue
```

**冲突解决后，务必重新验证**（防止合并把之前的检查结果搞坏）：

```bash
pnpm check          # tsc -b
pnpm i18n:check     # 如涉及中文文案
```

> 📌 **`pnpm check` 全绿、无冲突之后**：**下一步走第 6 步：push 并提 MR**。

### 5.3 第 6 步：向 master 分支提交 MR

```bash
git push -u origin frontsandbox/<slug>
```

`/feai-archive` 通常会帮你自动创建 MR；如果需要手动创建，用工蜂 MCP：

- 目标分支（target）：**`master`**（直接打 master，不要叠 MR-on-MR，见坑 9）
- 标题：中文为主，如 `支持用户反馈入口`
- 描述：**关联上 issue 编号**（如 `关联 #123`），方便 owner 一眼看出这个 MR 是为了解决什么需求

> 💡 评审导致代码再改怎么办？追加改动 → 再跑一次 `/feai-archive`（增量归档）→ 追加 commit 到同一个 MR。

> 📌 **MR 创建成功、拿到 MR 链接之后**：**下一步进入"六、第 7-8 步·CR → 合并 → 发布 → 回归验证"**。去找 Fanny 机器人触发自动初审，再 @ owner 做人工 CR。

### 5.4 第 6B 步：产品/法务 PRD 沉淀（按需）

**什么时候触发**：产品重大更新、新地域/新语言、法务/合规材料、计费、渠道、AgentChat、SkillHub/skills.sh 等用户可见范围变化，或用户明确说"写 PRD / 沉淀需求文档 / 放到 `wiki/prd-docs`"。

**怎么做**：

1. 读取 `product-skills/prd-creator/SKILL.md` 和 `references/prd-template.md`。
2. 独立验收的目标拆成独立 PRD；关联但目标不同的事项不要硬塞到一个文件。
3. 写入 `wiki/prd-docs/YYYY-MM-DD-<short-title>.md`。
4. PRD 写清发布站点、同步策略、范围/非目标、影响面、验收标准和产物交接。

**提交策略**：

- 跟功能一起评审：把 PRD 加到当前 MR，MR 描述写明新增 PRD。
- 用户说"直接放进去 / 不用提 MR"：从最新 `origin/master` 建干净 worktree，只提交 PRD Markdown 到 `master`；提交前用 `git diff --cached --stat` 确认只包含 `wiki/prd-docs/*.md`。
- 禁止把功能分支 HEAD 直接推 `master`，避免把功能代码和本地调试改动一起带进去。

> 📌 **PRD 沉淀完成之后**：回到当前 MR/发布流程继续推进；如果是直接放到 master，确认远端 `master` 的 `wiki/prd-docs` 已能看到新文件。

---

## 六、第 7-8 步 · CR（Fanny + 人工）→ 合并（方明）→ 审批人批准 → 分批发布 → 回归验证

**这是很多新人容易断片的一段：MR 提出去之后，代码是怎么"变成线上能看到的东西"的？** 完整链路如下：

```
MR 创建（target = master，关联 issue，并注明国内站/国际站）
        │
        ▼
① Fanny 自动初审 —— 在「Vela 协作群」里 @Fanny + 贴 MR 链接
        │  （Fanny 是研发侧自研的 AI CR 机器人，拉取 diff 跑规则，把问题贴回群；不是最终把关）
        ▼
② 人工 CR —— 找对应模块 owner（前端 sarahzzhang / 后端 skipzhang）或直接在群里问
        │  owner 提意见 → 你改代码 → 回到「五、」重新 commit / 追加归档 / push
        ▼
③ 第一步合并找 方明
        │  你觉得改得差不多了，直接找 方明 进行第一步的合并
        ▼
④ 找审批人（approver）批准
        │  批准通过才会进入发布流程（这一步别忘了，不然不会发货）
        ▼
⑤ 分批发布 —— 发布有固定周期，攒一批一起发
        │  合进 master 后通常不会立刻单独上线，等同批的发布窗口到了才会一起部署
        ▼
⑥ 回归验证 —— 去线上地址走一遍你刚做的功能
        国内：https://lightvela.com
        国际：https://lightvela.ai   ← 国际站拿这个做最终验收
        对照 issue 里的「验收标准」逐条复核（国际站记得多语种 + 中文都验一遍）
```

**关键认知**：

- **Fanny 通过 ≠ 能合并**，**Fanny 挂 = 大概率需要改**——但最终拍板权在人工手里。
- **合并 ≠ 立刻能看到**：发布是**分批**的，有固定周期，合进 master 后等同批窗口到了才一起上线，别一合并就去截图说"怎么还没生效"。
- **审批人是发货闸门**：提了 MR 一定要找审批人批准，没批准就不会进发布。
- **回归验证不是可选项**：哪怕本地预览 100% OK，线上配置（环境变量、CDN 缓存、灰度策略）都可能不同，**必须去对应站点（`lightvela.com` / `lightvela.ai`）亲自走一遍**才算"做完"。国际站要**多语种 + 中文都验**。

> 📌 **在对应站点对照 issue 验收标准全部打勾之后**：**🎉 恭喜，整条链路走完了！** 这个需求正式上线。
>
> 如果你是团队维护规范的人，还有可选的第 9 步（见下一节）。否则到这里就是终点。

---

## 七、第 9 步（可选）· 沉淀到项目共识仓库

如果你是团队里维护开发规范的人（而不是普通提需求/开发的新人），完成一次流程优化之后，记得同步更新到项目共识仓库，让下一个新人也能查到：

- 仓库：https://git.woa.com/LightVela_CoDesign/Wiki/tree/master
- 更新方式：**这个仓库本身也是普通 git 仓库**，走一样的套路——clone → 新分支 → 改文档 → commit → push → 创建 MR → 找人 review → 合并。
- 建议维护的目录：`Skills/lightvela-vibe-coding/`（本文档）、`Skills/lightvela-issue-quick/`、`Skills/lightvela-dev-constitution/`。

> 📌 **Wiki 更新合并之后**：整个流程（包括规范维护）100% 完成。

---

## 八、Fanny CR 机器人（补充说明）

**Fanny 是谁**：**研发侧自研的 AI Code Review 机器人**（不是外部工具），用来对你的 MR 做代码评审。它已经在「Vela 协作群」里，直接用即可，不用自己加。

**接入方式**：

- 机器人主页：https://work.weixin.qq.com/wework_admin/common/openBotProfile/24113cfd2995f7cbb522cec5d1655669a6
- 在「Vela 协作群」里 **@Fanny + 贴 MR 链接**，机器人会自动拉取 diff、跑评审规则、把发现的问题贴回群

**Fanny 会看什么**（经验总结）：

- 代码结构/命名/职责分层
- 是否遵循 AGENTS.md 铁律（`any`、双语分支、错误处理等）
- 安全（XSS/注入/敏感信息硬编码）
- 未使用依赖、注释与实际代码是否一致

---

## 九、AGENTS.md 铁律 · 高频触发条款（记 12 条）

> 完整版见 `mono2/AGENTS.md` 第五章 + `frontend/AGENTS.md` 第二章 + `.workflow/rules/global.md`（G1–G22）。这里只列踩过最多次的。

### P0 · 不可违背

1. **🔒 安全第一**：XSS/注入/敏感信息 P0 优先级，token/密钥**只走 env，不写仓库/日志/MR 描述**。
2. **📐 OpenSpec 唯一事实来源**（G1/G2）：代码修改前必须读 `openspec/` 当前状态。
3. **🎯 plan.md 门禁**（G3）：M/L 需求编码前 `openspec/plan.md` 必须存在未完成 `- [ ]` 任务。
4. **🛑 Stop-and-Ask**（G4）：测试连续失败 3 次 / 遇未记录边界 → **立即停止，问用户**，不许硬猜。
5. **🌿 分支管理**（G8）：
   - **禁止在 `master` 直接开发**
   - 前端分支默认 `frontsandbox/<short-topic>` 前缀（触发自动分支预览）
   - 切分支前若工作区脏，**必须先让用户决定**，禁止自动 `stash` / `commit`。
6. **🚫 禁止 `any`**（TS 项目）：用 `unknown` 或具体类型替代。
7. **💬 中文对话**（G6）：所有讨论/commit message/MR 标题优先中文，英文放后面补充。
8. **⚠️ 不可逆操作确认**：`git commit` / `git push` / `create_merge_request` 之前**必须展示内容**，用户点头才动手。

### P1 · 高频

9. **📝 提交/MR 标题格式**：`调整 X / chore(module): migrate X`（中文在前 + 英文补充在后）。
10. **✅ 证据优于声明**：说"完成了"必须有跑通截图/日志/测试证据。
11. **🚫 禁工具替代工作流**（G19/G21）：禁用 `EnterPlanMode`，规划产物只写 `openspec/`（不许写 `.codebuddy/plans/` 或 `docs/plans/`）。
12. **🔁 未归档变更优先**（G22）：启动新需求前，若上一轮变更还没 `/feai-archive`，**先归档才能开新的**。

---

## 十、踩坑清单（真实事故，都是血泪）

> 按"踩过的频次高低"排序。看到症状对号入座。

### 坑 1：`pnpm-lock.yaml` specifier mismatch 或 merge 后依赖错位

**症状**：CI frontend guard 挂在

```
specifiers in the lockfile don't match specifiers in package.json:
* @tencent/tea-sdk-lightclaw (lockfile: 1.6.1, manifest: 1.9.0)
```

或者 merge master 之后报：

```
2 dependencies were removed: cos-js-sdk-v5@1.10.1, cos-nodejs-sdk-v5@2.15.4
```

**根因 A**：`git rebase` / 解冲突时手动改了 lockfile 的 specifier 版本，`package.json` 和 lockfile 不一致。

**根因 B**：merge master 后，lockfile 被 master 版本覆盖（包含已删除的依赖），但 `package.json` 里这些依赖已经删掉了。

**修法**：

```bash
# 不要手改 lockfile！重新对齐：
cd frontend
pnpm install --no-frozen-lockfile   # 自动对齐 package.json，重新生成 lockfile
pnpm install --frozen-lockfile       # 验证能过
git add pnpm-lock.yaml && git commit -m "fix(lock): 同步 pnpm-lock.yaml"
```

**预防**：**永远别用文本编辑器改 `pnpm-lock.yaml` 的版本号**。冲突用工具，缺什么让 `pnpm install` 自己解。merge master 之后一定要重新跑 `pnpm install --no-frozen-lockfile` 确认 lockfile 干净。

---

### 坑 2：本地跑 guard 复用 `node_modules` 会漏 `install` 步骤（**误判 3 次**）

**症状**：本地按 `frontend/checks/guard.sh` 复现 CI，`pnpm check` / `i18n:check` / `build:cn` / `build:global` 全绿，但 CI 依然 `failure`。

**根因**：为省时间在临时目录里**软链**了现有 `node_modules`：

```bash
ln -s /path/to/mono2/frontend/node_modules $GUARD_ROOT/frontend/node_modules
```

这样 `pnpm install --frozen-lockfile` **实际没跑**（pnpm 看到 node_modules 已存在就快速返回），**跳过了 lockfile 完整性校验**。CI 上是全新 checkout + 全新 install，才会触发坑 1 那种 specifier 校验挂。

**修法**：本地要复现 CI 时，**别软链 `node_modules`**，跑真正的 `pnpm install --frozen-lockfile`。慢就慢一点（几十秒），比误判省一小时。

---

### 坑 3：i18n 新增中文文案没补齐英文 → `i18n:check` 硬阻塞

**症状**：CI frontend guard 挂在

```
[i18n-extract] 待翻译 30 条
[i18n-extract] ❌ check 失败
```

**根因**：新加了 `t("产品反馈")` 调用，`scripts/i18n-extract.mjs` 扫到新的中文文案 hash，`en-US.json` 里对应 key 是空字符串。`i18n:check` 会 `missingEn > 0` 强制 fail，**阻塞 MR**。

**修法**：

```bash
cd frontend
pnpm i18n:extract           # 更新 zh-CN.json / en-US.json / zh-to-key.json
# 打开 src/i18n/generated/en-US.json，把新加的空值 key 补上英文
pnpm i18n:check             # 应该 ✅
git add src/i18n/generated/*.json && git commit -m "fix(i18n): 补齐 XX 英文翻译"
```

**预防**：`/feai-review` 会自动跑 `pnpm i18n:check`，别跳这步。

---

### 坑 4：next-site dev server 启动命令的坑

**症状**：想同时开国内站预览，用 `pnpm dev -- -H 127.0.0.1 -p 5175`，报

```
Invalid project directory: /.../-H
```

**根因**：`frontend/next-site` 的 `pnpm dev` 脚本是

```
node scripts/sync-fumadocs-content.mjs && fumadocs-mdx && next dev
```

pnpm 会把 `--` 后的 `-H` / `-p` 当成 **第一个 `node` 命令的目录位置参数**，不是传给 `next dev`。

**修法**：跳过 pnpm 包装，直接调 `next` 二进制：

```bash
cd frontend
NEXT_PUBLIC_REGION=cn VITE_REGION=cn \
NEXT_PUBLIC_AUTH_API_BASE_URL=https://lightclaw.tech \
VITE_AUTH_API_BASE_URL=https://lightclaw.tech \
node_modules/.bin/next dev -H 127.0.0.1 -p 5175
```

**另一个坑**：同一个 `frontend/` 目录不允许并行两个 `next dev`（共享 `.next` 锁，后者主动退出）。要开两个站，只能起在两个 clone 出的 workspace 里。

**替代方案（推荐）**：**别在本地折腾**，直接推 `frontsandbox/<name>` 分支，2 分钟后自动出预览：

- 国内：`https://<name>.preview.lightclaw.tech`
- 国际：`https://intl-<name>.preview.lightclaw.tech`

---

### 坑 5：gongfeng `commit_check_state` 缓存陈旧

**症状**：你 push 修复了几分钟，MCP 或页面查 `!MR`，`commit_check_state` 依然是 `failure`。

**根因**：gongfeng 的 MR 元数据是**异步更新**的，`commit_check_state` 依赖 CI webhook 回写。push 之后：

- 前 1-2 分钟：`commit_check_state` 可能是**旧值**（上一轮结果）
- 3-5 分钟：变成 `pending`（CI 开始跑）
- 5-15 分钟：变成 `success` / `failure`（CI 结果）

**判别方法**：看 `source_commit` 有没有变。如果 `source_commit` 已经是你新 push 的 SHA，但 `commit_check_state` 还没动，就是缓存陈旧，等就行。

**另一层**：MCP `get_merge_request` 单条查询接口有时候 404（原因不明），改用 `list_merge_requests` 拉列表 filter 出目标 iid 更稳。

---

### 坑 6：`git push --force-with-lease` 因过期 remote ref 拒绝

**症状**：本地 rebase 完，`git push --force-with-lease origin <branch>` 报 "stale info"。

**根因**：`--force-with-lease` 用本地缓存的 `origin/<branch>` 做安全检查。如果你**在 rebase 之前很久没 `git fetch`**，本地 `origin/<branch>` 是老快照，跟远端最新不一致，`--force-with-lease` 觉得"你的信息过期，可能会覆盖别人的 commit"，拒绝。

**修法**：先 `git fetch` 更新 remote ref，再 `--force-with-lease`。如果确认远端就是自己刚 push 的（没有别人写入），可以直接 `--force`（但**只对个人分支这么做**，`master` 永远不许 `--force`）。

```bash
git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>
git push --force-with-lease origin <branch>
```

---

### 坑 7：MR target 分支被合掉之后下游 MR 变孤儿

**症状**：你的 MR target 是另一个分支（而不是 master），那个上游分支合入 master 后被自动删除，你的 MR 也被自动关闭。

**修法**：上游 MR 合入 master 前后，把你的 MR target 改成 master，然后 **rebase 去掉已经进入 master 的重复 commit**。

**预防**：**尽量别做叠加式 MR**（MR-on-MR）。如果非要做，动手前先想清楚"上游 MR 合了之后我怎么办"。

---

### 坑 8：CI 挂了先看**根因日志**，别看 fallback 判定语句

**症状**：CI 日志尾部一堆

```
变更目录约束：存在非 .ci/** 变更，禁止 fallback，保持失败。
```

新人容易以为这就是错因。**不是**。这句是 `.ci/mr-placeholder.yml` 里"trusted guard 失败之后要不要走 fallback 修复"的**判定语句**，只是在解释"为什么本次不能自愈"，真正的错因在这句上面的 `Guard 执行失败：xxx exit_code=1`，甚至更上面的 `pnpm i18n:check` / `pnpm install --frozen-lockfile` 的具体报错。

**修法**：在 CI 日志里**向上滚**，找第一个 `exit_code=非0` 或 `❌` / `error:` / `failed:`。

---

### 坑 9：一个需求开了多个分支 / 绕过分叉新建 round2 分支

**症状**：本地分支和远端历史分叉（两边各自有不同的 commit），push 被拒。为了绕过冲突，新建了 `feat/xxx-round2`，结果变成两个分支两个 MR，改一次要 push 两遍，还容易漏。

**根因**：遇到分叉时，错误地"新建分支绕过"而不是"直接在原分支上 merge/rebase 解决分叉"。

**修法**：**一个需求只用一个分支，一个 MR**。分叉了就在原分支上直接解：

```bash
# 方式 A：从目标分支（master 或其他）最新状态重新 merge 一次
git checkout <你的功能分支>
git merge origin/master     # 把最新 master 合进来，手动解冲突
git push origin <你的功能分支>

# 方式 B：目标分支分叉严重时，cherry-pick 你的有效 commit 到新的干净基点
# （这是最后手段，日常够用的是方式 A）
```

**预防**：
- 开发前先 `git pull origin master` 拉最新
- 提 MR 前先 `git merge origin/master` 把目标分支纳入
- **绝对不要**因为"push 被拒"就新开一个 `xxx-round2` 分支

---

### 坑 10：merge master 之后 `zh-to-key.json` 冲突——i18n key 被意外删除

**症状**：merge master 后，`frontend/src/i18n/generated/zh-to-key.json` 出现冲突。解完冲突后 CI 过了，但线上某个功能的文案消失了（空字符串或 key not found）。

**根因**：`pnpm i18n:extract` 会根据当前源码重新扫描并**删掉扫不到的 key**。如果你在 feature 分支上跑过 `i18n:extract`，可能把 master 上其他功能还在用的 key 从 `zh-to-key.json` 里删掉了。merge 时这些删除 vs master 上的保留就发生冲突。

**修法**：merge 冲突时 `zh-to-key.json` **以 master 版本为主**——master 有的 key 无论如何都要保留：

```bash
# 冲突时，对 zh-to-key.json 取 master 版本
git checkout --theirs frontend/src/i18n/generated/zh-to-key.json
# 再手动补上自己新增的 key（不要用 pnpm i18n:extract 覆盖！）
git add frontend/src/i18n/generated/zh-to-key.json
```

**预防**：只在"最后准备 commit 之前"跑一次 `pnpm i18n:extract`，不要在开发中途频繁跑。merge master 之后不要再跑 `extract`（会重新删 key），只跑 `pnpm i18n:check` 验证。

---

### 坑 11：已合并的 MR 分支不要再 push

**症状**：某个 MR 已经合并，但你在它的源分支上又 push 了新 commit（修 CR / 修 bug），结果改动没进目标分支，CI 也不再跑，白做了。

**根因**：MR 合并之后，它的源分支就"完成使命了"。再往里 push 的内容**不会自动进任何地方**，也不会触发新的 CI 或部署。

**修法**：确认一个 MR 已合并后：
1. 立刻在脑子里把这个源分支划掉——**以后不再动它**
2. 后续的修改都在**目标分支（或新分支）**上做，对应那个分支的 MR 上提交

---

### 坑 12：PRD 写在功能分支，`master/wiki/prd-docs` 看不到

**症状**：你已经新增了 PRD 文件，但用户打开工蜂 `master` 下的 `wiki/prd-docs` 说"没有"。

**根因**：PRD 只提交在功能分支/MR 分支里，尚未进入 `master`；或者为了"直接放进去"误把功能分支 HEAD 推向 `master`，导致 PRD 和功能代码混在一起。

**修法**：

- PRD 跟功能一起走评审：保持在当前 MR，MR 描述里说明新增 PRD，等 MR 合并后再让用户看 `master`。
- 用户明确说"直接放进去 / 不用提 MR"：从最新 `origin/master` 建干净 worktree，只提交 `wiki/prd-docs/*.md`，提交前用 `git diff --cached --stat` 和 `git diff --cached --check` 复核。
- 禁止从功能分支直接 `git push origin HEAD:master`。

**预防**：写 PRD 前先确认交付方式是"随当前 MR"还是"直接进 master"；直接进 master 时，工作区必须只包含 PRD Markdown。

---

## 十一、第一次跑 Vibe Coding 流程 · 建议动作清单

- [ ] Clone `wisp/mono2`，`cd mono2 && cat AGENTS.md | less`（读完）
- [ ] 读你要动的子服务的 `AGENTS.md`（比如 `frontend/AGENTS.md`）
- [ ] 收藏 Fanny 机器人，加进你的 dev 群
- [ ] 加前端 owner（sarahzzhang）和后端 owner（skipzhang）好友
- [ ] **完整跑一遍全流程练手**（哪怕是个玩具需求）：
  1. 对 AI 说"给 mono2 快速提个 issue：在个人页面加一个 Hello 世界横幅"，确认 issue 创建成功
  2. `/feai-start` 带上 issue → `prd-creator` 澄清 → 拉分支 → 开发 → `/feai-review`
  3. 本地/预览环境看效果
  4. `/feai-archive` → commit → 拉最新 master 解决冲突（如果有）→ push → 提 MR
  5. @Fanny 触发 CR（当作练手，不用真找 owner 合并，体验一下流程即可）
- [ ] 把本 skill 加个书签，遇到症状先来这里对号入座

> 📌 **清单全部打勾之后**：你已经跑通了完整链路，以后遇到具体问题直接翻"踩坑清单"对号入座即可。

---

## 十二、遇到解决不了的问题？

1. **技术 blocker**：企微 @ 前端 owner sarahzzhang / 后端 owner skipzhang
2. **产品需求疑问**：Wiki（LightVela_CoDesign）看日会进展对齐
3. **CI 挂了看不懂**：先按坑 8 找错误行，再来对照踩坑清单；实在不行 @ skipzhang（他管 CI runtime 和 GitOps）
4. **UI/设计问题**：@ jacoyang（设计主 owner）
5. **合并了但线上没生效**：先等 5-15 分钟（CI/CD 部署窗口，见第六节），依然没生效再 @ skipzhang

---

**祝新人不翻车。翻车了不丢人，重要的是别翻第二次。**
