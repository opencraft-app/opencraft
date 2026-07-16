# Terminal Output Rules

> 按需读取。终端输出治理用于减少测试、构建、lint、type-check 的 transcript token。首选 tokenjuice；未安装时使用本文件的手动摘要格式。

## tokenjuice 优先

推荐安装：

```bash
npm install -g tokenjuice
tokenjuice install codebuddy
tokenjuice install claude-code
tokenjuice install codex
```

手动包装长输出：

```bash
tokenjuice wrap -- <command>
tokenjuice wrap --raw -- <command>
tokenjuice wrap --store -- <command>
```

`tokenjuice` 是 deterministic reducer，不调用 LLM；只压缩命令输出，不改变命令执行语义。

## 何时使用

| 场景 | 默认 |
|---|---|
| test / build / lint / type-check | tokenjuice wrap 或 hook 压缩 |
| `git status` / `git diff --stat` / `rg --files` / `find` / `ls` | 可压缩 |
| `cat` / `sed` / `nl` / `jq` / `yq` 精确读文件 | raw |
| 部署、删除、生产数据、高风险写操作 | raw，且先确认 |
| 需要完整日志排障 | `--raw` 或 `--store` |

## 手动摘要兜底

未安装 tokenjuice，或 hook 不可用时，输出超过 200 行或 12KB 必须摘要：

```text
命令: <command>
退出码: <code>
结论: pass | fail | flaky | blocked
关键错误:
- <file:line> <message>
输出规模: <lines / bytes>
完整日志: <local-path or unavailable>
下一步:
- <action>
```

## 预算目标

| 项 | 目标 |
|---|---:|
| 单次普通命令输出进入上下文 | <= 2,000 tokens |
| 单次测试 / 构建失败摘要 | <= 3,000 tokens |
| raw / full bypass | 显式说明原因 |

## 禁止

- 把完整构建日志、测试日志、依赖安装日志直接塞进回复。
- 只说“测试失败”但不给退出码和首个关键错误。
- 为省 token 隐藏会影响判断的错误行。
- 用 LLM 重新“聪明总结”替代 deterministic reducer 的失败摘要；需要更准时应补 tokenjuice 规则或读 raw 片段。
