# 升级 feai 工具 0.54.2 → 0.56.0（Native 引擎瘦身版）

## 需求

用户已运行 feai 工具升级，工作区产生未提交改动。要求：拉新分支 → 提交 → 创建 MR。

## 关键发现

- 版本：`.codebuddy/.feai-installed` 0.54.2 → 0.56.0（2026-09-03 06:56 UTC 安装）
- 规模：61 文件，124+/6834-（46 删除 / 15 修改 / 3 新增目录）
- 核心变化：feai 从「多 agent 文档工作流」转向「native 引擎」模式
  - 新增：`.codebuddy/skills/feai-native/`（引擎 + SKILL）、`.codebuddy/commands/feai-native.md`、`.agents/skills/feai-native/`
  - 删除：`.codebuddy/agents/`（9 个 agent 文档）、`.workflow/agents/`（7 个）、`.codebuddy/skills/superpowers` 系列、`.agents/skills/` superpowers 13 个
  - 精简：`.workflow/rules/`（9 文件）、commands（7）、checklists（3）、project.yaml
  - `.gitignore` 配套：native 运行态（state/lock/audit）不进 Git，文档层（brief/plan/report）随 Git 共享
- 与上一版（0.51→0.54.2，MR !3261）方向一致：持续削减 token 开销，本次更彻底（agent 文档层整体退役）

## 方案

1. 从 master 拉分支 `chore/update-feai-tools-0.56`
2. 提交全部工作区改动（含未跟踪的 3 个新增）
3. 推送并创建 MR → master

## 验证口径

- `git status` 干净（全部改动入库）
- commit 内容 = 工作区改动全量（61 文件）
- MR 创建成功且 commit check 通过（纯配置/文档变更，无 CI 构建阻塞）
