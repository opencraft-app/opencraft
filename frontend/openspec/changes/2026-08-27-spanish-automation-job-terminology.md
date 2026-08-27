# 西语自动任务 Job 术语统一

> 日期：2026-08-27｜分支：`codex/lightvela-roadmap-2026-09`｜提交：`34c81154cf59e10054afb9a74e1cd967e922d876`｜MR：`wisp/mono2!3405`

## 一、需求概要

西班牙语版本进入 `master` 后，同步此前英文和印尼语的自动任务术语规则，避免同一产品对象在西语界面中混用 `tarea automática`、`Job` 和单次执行概念。

## 二、任务完成情况

- [x] 西语以 `Automatizaciones` 表示自动化模块或能力。
- [x] 西语以 `Job` / `Jobs` 表示可配置、调度和管理的自动任务实体。
- [x] 西语以 `Ejecución` / `Ejecuciones` 表示单次执行记录，并保留 `tarea` 表达 Job 实际执行的工作内容。
- [x] 新建、编辑、详情、ID、上下游关系和限制提示统一使用 Job 术语。
- [x] 增加 92 条西语术语契约测试并完成相关回归。

## 三、关键决策

- 不把所有中文“任务”机械翻译为 `Job`；只有调度实体使用 Job，真实工作内容仍允许使用自然西语 `tarea`。
- `Automatizaciones` 仅用于模块、能力和测试消息，不代替具体 Job。
- 上下游关系沿用产品内统一表达 `Job upstream` / `Job downstream`，避免重新引入“前一个任务”等歧义。
- 生成字典通过 `i18n-apply` 写入，测试 fixture 同时作为可审计的中文原文到西语译文映射。

## 四、实施摘要

- 更新 `frontend/src/i18n/generated/es.json` 中 92 条自动任务相关译文。
- 新增 `agent-automations-panel.es.test.ts`，逐条校验中文源文案、hash key 与西语值。
- 新增 `agent-automations-job-copy.es.json`，集中维护本次术语契约。
- 在 `frontend/openspec/plan.md` 记录西语补充任务与 RED/GREEN 验证证据。

## 五、规范沉淀

国际站自动任务术语边界如下：

| 概念 | 英文 | 印尼语 | 西班牙语 |
|---|---|---|---|
| 自动化模块或能力 | Automations | Otomasi | Automatizaciones |
| 可调度实体 | Job / Jobs | Job | Job / Jobs |
| 单次执行记录 | Run / Runs | Eksekusi | Ejecución / Ejecuciones |
| 实际工作内容 | task | tugas | tarea |

本次仅调整翻译资源和契约测试，不修改 Hermes Cron 数据结构、调度逻辑、API、权限或区域分支，因此无需更新 `openspec/current_state.md` 项目地图。

## 六、回顾与改进

验证结果：

- 自动任务相关回归：14 个测试文件，377 条测试通过。
- `pnpm i18n:check` 通过，西语 2639/2639 条完整。
- `pnpm check` 通过，TypeScript diagnostics 为 221 current / 276 baseline / 0 new / 55 resolved。
- `git diff --check` 通过。
- 独立 final review 首轮发现 2 条 P2 残留，修复并补测后复核为 P0/P1/P2 均为 0，`verdict=pass`。

归档采用 scoped 降级：仓库共享的 `frontend/openspec/plan.md` 仍包含 9 个其他需求的待办项，未执行 `feai archive reset-state`，以免覆盖其他在研需求。该限制不影响本次西语术语变更及 MR 交付，但完整 archive gate 需等共享计划拆分后再通过。
