# V4 初始数据冻结拒绝记录

## 结论

初始冻结使用工蜂 MR 文件清单作为 Gold。对 55 条候选进行本地 `base_commit → merge_commit` 首父差异复算时，发现 1 条候选的文件清单不一致，因此该版本被拒绝，未进入任何模型实验。

## 保留证据

- `candidates-v4-api-paths-rejected-holdout.jsonl`
- `candidates-v4-api-paths-rejected-final.jsonl`
- `v4-dataset-provenance.api-paths-rejected.json`

这些文件只保留在 evaluation 目录，继续受运行时路由排除规则保护。

## 修正后的权威链

工蜂仅提供“已合并到 `master` 的 MR 候选、IID、标题和 merge commit”；Gold 一律由本地 Git 对 `base_commit` 与 `merge_commit` 执行 `git diff --name-only` 得出。当前 canonical 的 `candidates-v4-holdout.jsonl` 和 `candidates-v4-final.jsonl` 已完成 55/55 本地复算一致性校验。
