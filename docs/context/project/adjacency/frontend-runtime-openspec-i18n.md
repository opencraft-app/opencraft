---
id: adjacency-frontend-runtime-openspec-i18n
type: project
scope: 前端页面、运行时配置、OpenSpec、i18n 生成物和相邻测试的共同变更邻接。
triggers:
  - frontend
  - runtime config
  - i18n
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - frontend/openspec/config.yaml
  - frontend/src/contexts/runtime-config-context.tsx
  - frontend/src/i18n/index.ts
  - frontend/vitest.config.ts
status: active
reviewed_at: 2026-08-27
review_due: 2026-11-25
revision: 1.0.0
precedence: project
derived: true
related_packs:
  - site-environment-routing
---

# 前端运行时配置、OpenSpec 与 i18n 邻接

## 当前实现锚点

- `frontend/openspec/` 保存当前前端需求、计划和状态约束；它与运行时代码的关系必须由当前文件核验。
- `frontend/src/contexts/runtime-config-context.tsx` 是运行时配置消费的一个入口，`src/i18n/` 包含语言初始化和生成的 locale 资源。
- 前端测试分布在相邻 `__tests__`、`*.test.*` 和 scripts 测试中；生成的 locale 文件必须追溯到当前 i18n 脚本，而不是手工猜测。

## 适用触发

前端页面、运行时配置、环境变量、OpenSpec、翻译、locale、静态产物、国内/国际站或前端测试。

## 必查邻居

1. 先在 `frontend/openspec/` 确认当前任务约束，再在命中的 `src/` 目录精确搜索符号。
2. 若触及配置，检查 `runtime-config-context.tsx` 与对应 `*.test.*`。
3. 若触及语言，检查 `src/i18n/index.ts`、相关脚本和一个 locale/测试邻居；生成物只在确认生成入口后查看。
4. 若触及发布静态产物，检查同一能力的 `frontend/scripts/*test.*`，不把本地构建成功等同于线上发布。

## 验证命令

```bash
rg --max-count 50 "<页面符号、配置键或翻译键>" frontend/src frontend/openspec frontend/scripts
```

精确命中后读取一个实现文件和一个相邻测试或生成入口，避免全量扫描翻译 JSON。

## 失效条件

若 OpenSpec、运行时配置 Provider、i18n 生成目录或测试框架迁移，本卡必须随当前入口更新。
