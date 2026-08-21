# 技能包 ACLI 原生批量安装设计

## 背景

当前 Skills 页的多选安装已经使用 ACLI 原生 `batch-install`，但技能包仍先展开 `skillSlugs`，再通过 `/debug/exec` 逐个执行 `acli skills install`。这会为每个技能重复创建远程执行请求和 CLI 进程，也让一个原生支持批量语义的操作退化为前端串行编排。

## 已确认方案

采用“ACLI 原生 `batch-install` 优先 + 逐个安装兜底”：

1. 技能包有流式执行能力时，发起一次带国内 SkillHub 下载模板的命令：

   `env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE=... acli skills batch-install --wait=true '<slug list>'`

2. 复用现有 Skills 页对 JSONL `progress` / `summary` 的解析、技能匹配和重复事件去重逻辑。
3. ACLI 不认识 `batch-install` 时，完整回退到现有逐个安装流程。
4. 批量命令返回部分失败时，仅把失败 slug 交给现有逐项重试逻辑；HTTP 429 继续使用 2 秒、5 秒退避。
5. 批量命令尚无成功项且所有失败结果均提示 SkillHub CLI 需要升级时，只执行一次 `skillhub self-upgrade`，再重试一次批量命令；混合失败继续逐项恢复。
6. 只有所有目标技能最终成功时才把技能包写入已安装状态；失败提示保留具体 slug 和输出摘要。

## 兼容与边界

- 没有 `execDebugCommandStream` 的调用方继续使用现有逐个安装，不改变组件独立使用方式。
- 不改变普通单技能安装、卸载、已安装技能识别和 SkillHub API。
- 不在技能包模块复制一套 JSONL 协议解析器；共享已有实现，保留既有重复 `progress` + 完整 `summary` 的回归保障。

## 验证

- 单元/组件测试覆盖：批量成功、未知命令回退、部分失败只重试失败项、升级后重试。
- 回归运行现有技能包重试、429、失败展示和安装状态测试。
- 运行 TypeScript、i18n 与 diff 格式检查。
