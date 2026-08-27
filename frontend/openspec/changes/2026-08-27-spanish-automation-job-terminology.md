# 西语自动任务 Job 术语统一

> 日期：2026-08-27｜分支：`codex/lightvela-roadmap-2026-09`｜基线提交：`34c81154cf59e10054afb9a74e1cd967e922d876`｜MR：`wisp/mono2!3405`

## 一、需求概要

西班牙语版本进入 `master` 后，同步此前英文和印尼语的自动任务术语规则，避免同一产品对象在西语界面中混用 `tarea automática`、`Job` 和单次执行概念。

## 二、任务完成情况

- [x] 西语以 `Automatizaciones` 表示自动化模块或能力。
- [x] 西语以 `Job` / `Jobs` 表示可配置、调度和管理的自动任务实体。
- [x] 西语以 `Ejecución` / `Ejecuciones` 表示单次执行记录，并保留 `tarea` 表达 Job 实际执行的工作内容。
- [x] 新建、编辑、详情、ID、上下游关系和限制提示统一使用 Job 术语。
- [x] 增加 92 条西语术语契约测试并完成相关回归。
- [x] 根据 MR 评审补齐英文后台运行提示、印尼语下游 Job 文案和审批关闭提示的多语言断言。
- [x] 合入最新 `master`，补齐新增会话侧边栏文案的西语和印尼语翻译，并同步全部语种字典结构。

## 三、关键决策

- 不把所有中文“任务”机械翻译为 `Job`；只有调度实体使用 Job，真实工作内容仍允许使用自然西语 `tarea`。
- `Automatizaciones` 仅用于模块、能力和测试消息，不代替具体 Job。
- 上下游关系沿用产品内统一表达 `Job upstream` / `Job downstream`，避免重新引入“前一个任务”等歧义。
- 生成字典通过 `i18n-apply` 写入，测试 fixture 同时作为可审计的中文原文到西语译文映射。

## 四、实施摘要

- 更新 `frontend/src/i18n/generated/es.json` 中 92 条自动任务相关译文。
- 新增 `agent-automations-panel.es.test.ts`，逐条校验中文源文案、hash key 与西语值。
- 新增 `agent-automations-job-copy.es.json`，集中维护本次术语契约。
- 修正全球站后台运行提示测试中的旧 `task` 文案，并为印尼语删除上游后的下游 Job 文案增加契约测试。
- 为审批关闭提示增加英语、繁中、印尼语、西语、日语和韩语的 UI 文案与单行布局断言。
- 本文档记录本次需求与验证结果；不提交仅供本地流程使用的 `frontend/openspec/plan.md` 改动。

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

- 本轮相关回归：8 个测试文件 285 条测试通过；全球站后台运行提示 2 条测试通过。
- `pnpm i18n:check` 通过：英语、繁中和西语 2652/2652 条完整；印尼语保持 175 条既有翻译债务基线。
- 字典完整性测试 10 条通过，最新 `master` 新增文案已同步到全部语种字典，过期反查 key 已由提取脚本清理。
- `pnpm check` 通过，TypeScript diagnostics 为 214 current / 276 baseline / 0 new / 62 resolved。
- MR 后续评审发现的全球站测试旧文案、印尼语 Job 残留、语言断言覆盖和本地过程文档范围问题均已修复。

归档采用 scoped 方式：仅维护本次 change 文档，不改动仓库共享的 `frontend/openspec/plan.md`，避免把本地过程记录混入 MR 或覆盖其他在研需求。
