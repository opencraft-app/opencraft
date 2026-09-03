# feai native 新手指引

> 本文件随 `feai install` 落地到 `.codebuddy/skills/feai-native/GETTING-STARTED.md`（codex / cursor profile 会同步到对应 skills 目录）。
> 目标：3 分钟看懂日常怎么用、文件都在哪、AI 在每个阶段做什么。

---

## 1. 一句话理解

feai native 把「需求 → 实现 → 验证 → 归档」做成一个引擎驱动的状态机，日常主链路：

```
/feai-start <需求>     启动：AI 读 feai-native skill，进入 shape 澄清需求
   ↓  shape：写 brief.md → 你批准
   ↓  build：按 brief 实现（方法论 AI 按风险自决）
   ↓  verify：实际运行验证 → 写 report.md
你确认归档            archive：change 目录搬入 .workflow/native/archive/
```

日常只需记住这条链路。状态推进由引擎命令完成，每条命令返回 continuation，AI 按指示行动（继续 / 停下来问你 / 修复 / 收尾）。

---

## 2. 四阶段速览

| 阶段 | AI 做什么 | 你要做什么 |
|---|---|---|
| shape（想清楚） | 澄清需求、调查相关代码、写 `brief.md`（需求 / 方案 / 上下文发现 / 验证口径） | 看 brief 摘要，确认后开工 |
| build（做） | 按 brief 实现；任务拆分与工作笔记自决（可写 `plan.md`） | 有分歧随时打断 |
| verify（验证） | 实际跑测试 / 构建 / lint，写 `report.md`（命令、结果、遗留风险） | 过目验证结论 |
| archive（归档） | 等你明确说归档后执行；汇报需求摘要、验证结论、遗留事项 | 说「归档」 |

---

## 3. 目录含义

| 路径 | 定位 | 说明 |
|---|---|---|
| `.workflow/native/changes/<name>/` | 进行中 change：`brief.md` / `report.md` / 可选 `plan.md` 由 AI 撰写 | **应随 Git 提交**；brief 批准后不要再改（内容 hash 漂移会触发重新批准） |
| `.workflow/native/archive/<name>/` | 已归档 change 目录 | 只读参考 |
| `current.json` / `state.yaml` / `.lock` | 引擎状态与指针 | ❌ 引擎独占，禁止手改；看进展用 `feai native status --json` |
| `.workflow/project.yaml` | 项目索引级事实（包管理器、测试/构建命令等） | 人可改 |

> `.workflow/native/` 的文档层（进行中 change 的 brief / plan / report，以及 archive）应随 Git 提交；只有 `current.json` 与各 change 内的 state.yaml / audit.log / .lock / runtime 属于本地运行态，已纳入 `.gitignore`——避免跨机幻影状态与锁楔死。

---

## 4. 几条会影响体验的纪律

- **不手改引擎状态**：想推进就走引擎命令（通常由 AI 代跑），想看状态用 `feai native status --json`（只读，随时安全）。
- **同一时刻只有一个 active change**：开新需求前先归档或处理完当前 change。
- **证据必须真实**：brief / report 不许编造，verify 必须实际运行过验证命令。
- **重复失败会强制停**：同一失败签名连续 2 次警告、连续 3 次停止、累计 12 次硬顶——AI 会停下来找你，不会无限返工。
- **中断可恢复**：会话断了重开，AI 会先跑 `feai native status --json` 按 continuation 继续；新工作树看到共享 brief 时，明确执行 `feai native resume --name <name> --json`，重建后重新确认契约。同一参数重试是幂等的。

---

## 5. 常见问题

- **想看当前进展？** `feai native status --json`。
- **换了工作树/机器？** 提交进行中的 brief / plan / report；新位置先 `status`，再按候选明确 `resume`。
- **团队约定（commit / 分支 / MR / TAPD / 用量上报）？** 见同目录 `references/team-conventions.md`。
- **从 Classic 升级来的？** 迁移说明见仓库 `docs/MIGRATION-native.md`。
- **想了解全部功能？** 见仓库 `docs/GUIDE.md`。

---

> feai native 不追求「让 AI 多跑命令」，而是让 AI 进入可控交付闭环——状态可恢复、证据可核对、边界有引擎把关。
