# 升级 feai 工具 0.56.0 → 0.58.0（feai-prd 需求创建 + Codex 用量审计）

## 需求

用户已运行 feai 工具升级，工作区产生未提交改动。要求：拉新分支 → CR → 提交 → 创建 MR。

## CR 结论（已验证）

- 版本：`.feai-installed` 0.56.0 → 0.58.0（2026-09-10 06:41 UTC）
- 规模：12 修改 + 4 新增目录，651+/61-（增量升级，无删除）
- 核心变化：
  1. **新增 `feai-prd` skill**（双份镜像）：TAPD 需求创建入口——模板选择→复杂度分层→影响评估→质量门禁→创建需求单，可衔接 `/feai-start`（原 manager 层能力工具化）
  2. **恢复 `feai-archive.md` 命令**（0.56 曾删除，现为 10 行薄壳兼容入口）
  3. **`feai_local_usage.py` +321 行**：新增 Codex CLI 用量审计支持（codex_usage 签名/路径解析/max_usage 合并）
  4. **engine.mjs isMain 修复**：realpath 对比 + try/catch 兜底，修复 symlink 场景（/tmp→/private/tmp、npm link）下静默不执行 main 的边界
- 验证：engine/auditor 双份镜像一致、py_compile/node --check 语法通过

## 方案

1. 从 master 拉分支 `chore/update-feai-tools-0.58`
2. 提交全部工作区改动
3. 推送并创建 MR → master

## 验证口径

- `git status` 干净（改动全量入库）
- MR 创建成功且 commit check 通过（纯配置/文档变更）
