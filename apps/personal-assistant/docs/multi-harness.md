# 多 Harness：主助理推理与持久执行分开选择

当前实现于独立评测工作副本。默认保持 Pi；可显式将主助理推理切换为 Codex app-server。没有修改或发布 Join/OpenCraft 主服务。

| 边界                                      | Pi                   | Codex                                                                 |
| ----------------------------------------- | -------------------- | --------------------------------------------------------------------- |
| 接待提议、已有只读查询循环                | 原 Pi completeSimple | 原生 app-server 临时线程 + outputSchema                               |
| 记忆提炼、独立复核、工作摘要              | 原 Pi completeSimple | 同提示词、同业务校验，原生结构化交换                                  |
| 委托执行、工具 checkpoint、等待用户、恢复 | Pi durable           | 原生持久线程 + 宿主边界收据，见[持久委托](codex-durable-execution.md) |
| 领域状态、原文、记忆事实、revision/CAS    | 原业务 owner         | 同一批业务 owner                                                      |

Pi 默认主助理仍是原有 one-shot 模型路径，不将它宣传为完整 Pi durable 执行。Codex 主助理角色用于结构化推理；查询继续由宿主 ReceptionPlanner 按原 6 次查询/7 轮限制执行，不在 Codex 中新增第二套业务工具循环。既有委托无需 checkpoint 迁移，也不会因更换主助理而丢失等待状态。

## 配置与运行

Node >=24。Codex 原生二进制需由用户显式提供；当前验证并固定 `codex-cli 0.162.1`，其他版本拒绝执行，需要重新核对协议与工具限制后适配。

准备 `codex.json`（本地配置，不包含密钥内容）：

```json
{
  "binary": "/absolute/path/to/codex",
  "baseUrl": "https://your-explicit-responses-endpoint.example/v1",
  "modelId": "your-explicit-model-id",
  "credentialFile": "/absolute/private/codex-api-key"
}
```

凭据文件仅保存 API key，权限 0600，必须是当前用户拥有的普通文件。配置文件同样建议 0600；评测入口强制这一要求。非 loopback 端点必须 HTTPS 并显式配置凭据。不会读取当前机器的 Codex 登录、共享 auth.json 或继承 OPENAI_API_KEY 等变量。配置未知字段（包括 apiKey）会被拒绝。

```bash
node bin/assistant.mjs init --profile /tmp/assistant-codex --owner local:me \
  --assistant-harness codex --codex-config /absolute/private/codex.json
node bin/assistant.mjs doctor --profile /tmp/assistant-codex
node bin/assistant.mjs run --profile /tmp/assistant-codex
```

默认 Pi 执行模型仍是确定性 fixture；真实 Pi 委托需显式配置 `profile.mode=model` 和 Pi 模型及授权凭据。选择 `--execution-harness codex` 则使用明确配置的 Codex 真实模型及原生持久线程，详见[持久委托](codex-durable-execution.md)；主助理与委托各自的模型、协议、用量分别记录。`doctor` 是离线配置检查，不证明远端兼容或模型质量。

已有 profile 可在停止该 profile 的 runner 后显式添加：

```json
{
  "harnesses": {
    "assistant": "codex",
    "execution": "pi",
    "codex": {
      "binary": "/absolute/path/to/codex",
      "baseUrl": "https://your-explicit-responses-endpoint.example/v1",
      "modelId": "your-explicit-model-id",
      "credentialFile": "/absolute/private/codex-api-key"
    }
  }
}
```

恢复 Pi 主助理时设置 `harnesses.assistant=pi`；委托仍归原 Pi durable。load 不会重写旧配置。配置应只引用操作者明确授权的端点和凭据。

## 原生协议与权限

每次结构化交换拥有独立临时目录、空 cwd、独立 HOME/CODEX_HOME 和原生进程；不加载助理工作目录。进程环境仅包含固定 PATH、LANG、隔离目录和显式配置的 key。没有继承模型账号、Node preload 或第三方插件配置。主会话连续性来自宿主输入中的原文、工作上下文与记忆，不来自临时 Codex 线程。

原生模型目录禁用 Shell 和 apply_patch；配置关闭 view_image、web、MCP 来源、skills/apps、多 agent、计划、目标等工具。当前版本的真实请求已验证 `tools=[]`；模型捏造 exec_command 会由原生拒绝。意外的宿主工具/审批 RPC 会失败并终止交换。只读 sandbox 是补充限制，不能单独作为禁止读取任意文件的依据。

四类交换都有封闭 JSON Schema，经 `turn/start.outputSchema` 发送。接待线协议使用 `{"proposal": ...}` 容纳不同提议；可选字段在线协议中用 null，验证后转换回既有业务提议。未知字段和错误类型不能被悄悄丢弃。结构有效不等于授权、证据正确或业务有效，原应用校验仍必须通过。

模型未遵守 schema 时在同一临时原生线程反馈一次格式错误，最多两次 turn。不能修复时返回明确失败；不会用正则截取“看起来像 JSON”的部分，也不会自动重复业务写入。复核失败仍沿用原学习服务的持久重试，不新建重试账本。

取消/超时/关闭杀掉并等待本次原生进程，再删除临时目录。profile 锁与领域数据库在业务协调器和原生资源关闭后释放。评测强制超时回收独立 worker 进程组，覆盖其原生子进程。

当前取舍：每次交换启动原生进程，启动耗时计入模型调用时间；不复用长驻原生进程来换取复杂的恢复所有权。Codex 版本没有本适配器可用的等价单次 maxTokens 参数，因此**不声称沿用了 Pi 的输出 token cap**；仍有宿主 deadline、查询轮数、一次格式纠正、协议输出大小限制。原生 counters 保留，包括格式失败后的已观察用量；价格未知，不能当作扣账或金额预算。

Pi 兼容端点的 thinking 配置目前也没有映射为 Codex 原生参数，原生侧使用服务默认行为。评测 identity 明确记录该差异；即使模型 ID、端点相同，也不能把潜在分数差异严格归因于 Harness，必须另外核对推理与输出预算。

## 评测切换

独立 LongMemEval 回放入口：

```bash
node evaluation/longmemeval.mjs --dataset DATA.json --output NEW_CODEX_RUN \
  --mode model --assistant-harness codex --codex-config /absolute/private/codex.json \
  --limit 5 --timeout-ms 300000
```

`--plan` 只规划输入；此入口不自动评分。gold、答案会话 ID、类别仍留在 evaluator 进程，不能进入模型。每题新 profile，输出记录 assistant Harness；历史成绩不改写。

70 题分层、完整历史基线与 judge 驱动 `evaluation/benchmark.mjs` 也接受上述两个 Harness flag，其他参数保持原样。此时 `--model-config` 仍用于 Pi 基线/judge，要求 Codex 与基线配置同一 modelId 和端点，分别明确提供凭据；两种 API 协议必须均由该端点支持。Harness 选择写入运行 identity，禁止换引擎后复用旧答案/恢复计划。

2026-11-07 已使用用户此前明确提供的 TokenHub 端点和凭据做小规模真实验证：`/v1/responses` 探测返回 200（45 tokens）；随后原生 Codex + `deepseek-v4.1-flash-1017` 经 LocalRunner/UnixSocket/原接待服务回复“你好”，没有创建 Work。原生接待用量为 input 11333、output 32、total 11365，宿主模型调用约 2.65 秒。schema 和完整提示词也消耗上下文，这不是与 Pi 的性能/质量对照。

可显式重跑单条烟测：

```bash
node evaluation/codex-probe.mjs --codex-config /absolute/private/codex.json --output NEW_DIRECTORY
```

它会发起真实模型请求，只用合成问候，在短路径临时 profile 内运行，关闭后删除 profile，保留报告；无需共享账号。UnixSocket 有路径长度限制，因此 CLI 的 profile 也应选短路径。首次烟测因证据目录下的 socket 路径过长未发起模型请求，失败报告照常保留。

原来的 58/70 成绩属于旧 Pi 路径；本次没有重跑付费模型对照，不能声称已提高成绩。其他端点仍必须单独验证 Responses 支持，没有自动协议转换或借用当前 Codex 登录。

验证入口：`node --test test/codex-harness.test.mjs`。测试使用真实 Codex 0.162.1 + 明确配置的 loopback Responses 替身，覆盖原生 schema、无工具、并发、格式纠正、用量、取消/关闭、凭据环境隔离、真实 CLI、宿主查询、Pi 委托、重开及评测 worker。它证明接线与边界，不证明模型记忆质量。
