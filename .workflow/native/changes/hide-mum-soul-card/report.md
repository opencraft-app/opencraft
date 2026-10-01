# 验证报告：双站 Soul 新推荐移除 MUM/MOMMY

## 实现结果

- LightVela 人设页将原始 Soul 目录与新推荐候选分离。新抽卡、重抽和人格测试候选排除 canonical `MUM`，同时覆盖国际站 `MOMMY`。
- 历史卡片继续使用原始目录本地化；未修改持久化数据、已应用状态、SkillHub 数据或接口。
- 人格测试只在当前候选 slug 中按现有余弦相似度与顺序选择结果。

## 已运行验证

| 命令 | 结果 |
| --- | --- |
| `pnpm install --offline --frozen-lockfile`（`frontend/`） | 通过 |
| `pnpm exec vitest run` 四个相关测试文件（locale、匹配、面板、测试弹窗） | 53/53 通过；覆盖国内与国际站候选、历史卡片和目标匹配后的替代推荐 |
| `pnpm check`（`frontend/`） | 通过；TypeScript 当前 166、基线 171、0 新增诊断；i18n 0 错误、47 条告警 |
| `pnpm build`（`frontend/`） | 通过；构建自动改写的 `next-env.d.ts` 已恢复，未纳入变更 |
| `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` | 0 errors、0 broken links、0 unclassified |
| `git diff --check` | 通过 |

## 全量测试限制

- 第一次 `pnpm test`：305 个文件通过、24 个失败、1 个跳过；4,035 项测试通过、117 项失败、13 项跳过，另有 6 个 worker 错误。日志显示 Vitest worker 意外退出和 Node heap 内存耗尽。
- 第二次以 `--maxWorkers=2` 运行完整 Vitest：307 个文件通过、22 个失败、1 个跳过；4,037 项测试通过、115 项失败、13 项跳过，仍有 6 个 worker 错误和多次 heap 内存耗尽。运行约 7 分钟后因重复 worker OOM 停止。
- 低并发运行的失败文件未包含本次修改的 `agent-buddy` 相关测试。日志还包含其他领域的断言与 mock 错误，因此不能将全量测试判为通过，也未证明这些失败均是基线问题。

## 风险与交接

- 本地相关行为、类型与构建已验证；全量测试门禁未通过，需由测试环境或对应失败文件 owner 进一步处理。
- 未做真实账号的双站浏览器验证、未提交、未推送、未创建实现 MR，也未发布。
- `feai workflow usage-context write` 未执行：当前宿主未提供 `feai` 命令（`command not found`）。
