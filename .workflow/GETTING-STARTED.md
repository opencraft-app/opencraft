# feai 工作流新手指引

> 本文件随 `feai install` 落地到你的项目 `.workflow/GETTING-STARTED.md`。
> 目标：3 分钟看懂日常怎么用、目录是什么、AI 会读哪些上下文。

---

## 1. 一句话理解

feai 把「需求 → 编码 → 验证 → 归档」做成一个可控状态机，用三个斜杠命令驱动：

```
/feai-start   规划：澄清需求 → 产出 openspec/plan.md（任务清单）
   ↓  每批 ≤3 个任务：inline quick + batch complete
/feai-review  验证：M/L 最终一次独立只读审核（S 按需）
   ↓  验收通过
/feai-archive 归档：沉淀变更记录到 openspec/changes/，清理工作区
```

日常只需记住这条主链路，其余细节 AI 会按规则自动处理。

---

## 2. 目录含义

| 目录 | 定位 | 你要不要动 |
|---|---|---|
| `.workflow/` | 流程资产：rules（规则）、agents（角色）、checklists（门禁）、project.yaml（配置） | 团队共享，建议入库；工具升级会同步 |
| `openspec/` | 业务资产：plan / proposal / spec（当前需求，本地草稿）、changes（历史归档，入库）、current_state（低频项目地图，不记录需求历史） | plan 是你和 AI 的执行事实源 |
| `.codebuddy/` | IDE 适配资产：commands、agents、team skills、mcp 示例等 | 共享资产建议入库；本机状态按 `.gitignore` 排除 |
| `.agents/skills/` | Codex repo-scoped skills（官方技能发现路径） | 团队共享，建议入库；工具升级会同步 |

> `openspec/plan.md`、`proposal.md`、`spec.md` 是**本地过程稿**（`.gitignore` 已排除），首次由 `*.template.md` 初始化；
> 归档后的事实源是 `openspec/changes/*.md`（入库、可复用）。
>
> `.codebuddy/commands/`、`.codebuddy/agents/`、`.codebuddy/skills/team-extensions/` 和 `.agents/skills/` 是团队 AI IDE 入口，
> 不应整体加入 `.gitignore`。只忽略 `.codebuddy/project.local.json`、`.codebuddy/mcp.json`、
> `.codebuddy/.cache/`、`.codebuddy/.baseline/` 等本机配置或运行时缓存。

---

## 3. AI 会读哪些上下文（P0-Min）

严格流程默认只读最小集合，避免上下文过大：

1. `AGENTS.md`（薄入口 + 硬纪律）
2. `.workflow/rules/global.md`（全局短规则）
3. 事实源：**规划阶段**读 `openspec/plan.md`；**实现阶段**读 `.workflow/runtime/current-task.summary.md`（当前批次 active slice，≤3 任务），完整 plan 仅按需校准。

其余规则（成本分层、调查、终端输出、团队协作等）都是**按需读取**，不默认加载。

---

## 4. 几条会影响体验的纪律

- **成本分层**：小任务（S）走轻流程，不会被拖入最重门禁；中大任务（M/L）才逐项跑门禁。见 `.workflow/rules/flow-cost.md`。
- **每批只做 ≤3 个任务**：完成一批 → inline quick → `batch complete` 统一刷新状态；M/L 最终再独立 review。
- **早停（Stop-and-Ask）**：重复同一失败假设且没有新证据，或缺少外部事实导致无法继续复现时，AI 会停下来问你；仓库内仍有安全证据时会继续调查。
- **未归档提醒是非阻断的**：有未归档变更时 AI 会提醒并让你选择，不会硬性拦住你开新需求。
- **用量审计默认非阻塞**：usage-context 只写本地 cache、失败静默，不影响业务流程。

---

## 5. 常见问题

- **plan.md 空了怎么办？** 运行 `/feai-start` 会重新生成；本地草稿可从 `openspec/plan.template.md` 恢复。
- **上下文太大 / 会话变慢？** 运行 `/feai-context-doctor` 体检 P0 预算与 summary 新鲜度。
- **想了解全部功能？** 见仓库 `docs/GUIDE.md`。

---

> feai 不追求"让 AI 多跑命令"，而是让 AI 进入团队真实交付闭环——流程可控、上下文可省、知识可沉淀。
