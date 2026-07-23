# Agent 记忆页 P1 稳定性修复技术规格

## 1. 读取命令

`buildHermesMemoryReadCommand()` 必须：

- 通过 `${HERMES_HOME:-$HOME/.hermes}` 解析 Hermes 根目录并导出给 Python。
- 优先使用 Hermes 自带虚拟环境 Python，缺失时回退 `python3`。
- 以 YAML safe-load 读取 `config.yaml` 顶层 `memory` 节点。
- 仅把“不存在的 config/记忆文件”视为合法回退或空内容；其他 I/O、编码和 YAML 错误必须导致命令失败。
- 用固定 `HERMES_MEMORY_JSON_START` / `HERMES_MEMORY_JSON_END` 标记包裹 JSON。

## 2. Snapshot 契约

`parseHermesMemorySnapshot()` 只解析固定标记之间的 JSON，并要求：

- `memoryText`、`userText` 为字符串。
- `memoryChars`、`userChars` 为非负安全整数。
- `memoryCharLimit`、`userCharLimit` 为正安全整数。
- `usedFallbackLimits` 为布尔值。

任一字段缺失或类型不匹配时抛出 payload 错误，不做前端默认值填充。

## 3. 数据访问

新增按显式 `botId` 读取 snapshot 的函数。该函数：

- 调用 `execDebugCommand(botId, command, { timeoutMs: 120_000 })`。
- 校验命令状态后解析 snapshot。
- 不读取 React 当前 Agent 闭包。

## 4. 保存编排

独立保存编排函数接收显式依赖：

- `botId`、目标、值、当前字符数。
- 配置命令执行器。
- gateway restart 命令提供器。
- 指定 bot 的 snapshot 重新读取器。

返回判别联合：

```ts
type HermesMemoryLimitSaveResult =
  | { status: "success"; snapshot: HermesMemorySnapshot }
  | { status: "failed"; error: Error }
  | { status: "partial"; error: Error; snapshot?: HermesMemorySnapshot };
```

配置命令成功是 `partial` 的分界点。config/restart 均使用 120 秒超时；重新读取复用数据访问函数的同一超时。

## 5. React 状态保护

- 读取继续使用读取请求序号，并额外校验捕获的 botId。
- 保存维护独立 `saveRequestId`；切换 Agent 时使旧保存失效。
- 只有 botId 与 requestId 同时匹配时才能写 snapshot、错误、saving state 或 toast。
- `savingMemoryLimitTarget !== null` 时两张限额卡片均不可提交；仅目标卡片展示 spinner。
- `partial` 保留编辑态，显示“配置已保存，但后续步骤失败”及恢复指引。

## 6. 测试

- 命令/解析单测覆盖自定义路径、YAML 注释、I/O 语义、固定标记和严格字段。
- 保存编排单测覆盖三种结果以及三个命令阶段的 timeout。
- 组件或聚焦状态测试覆盖切 Agent、保存互斥和旧请求不更新 UI。
- 验证命令：目标 Vitest、`pnpm check`、`pnpm i18n:check`、`git diff --check`。
