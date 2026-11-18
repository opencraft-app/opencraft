# Codex 持久委托

独立实验目录已支持 Pi/Codex 分别承担主助理推理与持久委托，默认仍为 Pi。未接入或发布 Join。Codex 固定验证版本为 `codex-cli 0.162.1`；使用显式 Responses 端点及私有凭据，不借用当前机器的登录。

## 运行

沿用[多 Harness 配置](multi-harness.md)中的 `codex.json`：

```bash
node bin/assistant.mjs init --profile /tmp/native-assistant --owner local:me \
  --assistant-harness codex --execution-harness codex \
  --codex-config /absolute/private/codex.json
node bin/assistant.mjs doctor --profile /tmp/native-assistant
node bin/assistant.mjs run --profile /tmp/native-assistant
```

两种角色独立选择；`harnesses.execution=codex` 使用该 Codex 配置的真实模型，即使旧 `profile.mode=fixture` 也不会切成假 Codex。`mode` 继续控制 Pi 模型路径，用量按实际引擎/真实调用标记。两个角色均选 Codex 时不需要 Pi 模型账户。doctor 仅离线检查，不证明远端可用或模型质量。

已有 profile 停止后可显式修改 `harnesses.execution`。选择只影响之后创建的 Execution；旧 Pi 工作仍交给 Pi，旧 Codex 工作仍交给 Codex。不迁移原生 checkpoint，不在故障时偷偷换引擎。未完成 Codex 绑定的模型和端点必须保留；改变它们会在启动时明确失败，需恢复原配置后先完成或取消旧工作。当前没有并存多套 Codex 后端的配置注册表。

## 所有权与恢复

| 内容                                   | 唯一 owner                                |
| -------------------------------------- | ----------------------------------------- |
| 原生线程、历史、模型续接               | 相应 Pi durable 或 Codex 原生存储         |
| 委托快照、固定引擎、原生引用、执行观察 | ExecutionLedger / ExecutionService        |
| 问题、答案、取消与修订退役             | 原 InteractionLedger / InteractionService |
| 工具授权、资料范围、记忆更正屏障       | 原 ScopePolicy 与相应业务 owner           |
| 完成依据、结果、交付                   | 原 Completion / Outcome 链路              |
| 活跃进程、RPC、timer、并发槽           | runtime 与对应 adapter，仅临时资源        |

Codex 执行目录在 `profile/executions/codex/<execution 摘要>/`。先通过原生 `thread/name/set` 物化并落盘空线程，再保存不可变绑定；单纯 `thread/start` 的空线程尚不能保证重启恢复。绑定不代表输入已被接受，`turn/start` ACK 后才保存输入送达观察。submission 引用显式标为宿主 requestId，实际原生 turnId 另行记录，避免混淆身份。

等待用户时，先由原 owner 保存 Interaction，再终止并回收当前 Codex 进程，释放执行槽。回答后重开同一原生线程，核对原 work/revision/Interaction，以新 turn 继续。**原生 pending 工具 RPC 不会跨进程保留**；这属于原生线程续接，不宣称等价于 Pi durable 的逐工具 Task 恢复。

为处理“效果已发生、响应未保存”的窗口，宿主保存有界的工具边界收据：调用身份、不可变意图、pending/waiting/completed 及结果摘要。它不保存第二份原生任务图。读取只留摘要/hash，完整内容归原生历史；恢复不从宿主缓存重新注入旧私密读结果，必须重新授权读取。已消费的原生上下文不能据此宣称被抹除。

当前可重放动作仅限授权读取，以及固定身份的本地笔记/Interaction 等原 owner 已有幂等操作。发布复用不可变产物身份；重启对账后不得生成第二份结果/交付。审计观察不承诺恰好一次。未来非幂等外部工具必须先定义未知效果的对账方式，不能照搬安全重放声明。

原生结束后先保存最终文本及原生 turnId，再经原 WorkCoordinator 报告和 Completion/Outcome 检查；模型说“完成”不会绕过真实资料读取、笔记发布或交付要求。迟到工具结果、取消、修改和显式记忆更正仍受原边界检查。

## 权限和限制

Pi/Codex 复用 `adapters/work-tools` 中同一批真实宿主工具与窄 port，工具参数、资源和工作版本分别校验。只挂载原快照允许的工具，不开放任意 Shell、文件路径、网络、MCP、插件、skills/apps 或原生多 agent。进程隔离独立 HOME/CODEX_HOME、空 cwd 和明确环境；这不是对任意第三方代码的安全沙箱。

原生异常退出有界重连；取消和关闭等待原生进程及在途宿主动作收尾，再释放 profile 锁。模型请求截止、活跃运行截止、协议输出大小和宿主调用步数均有界。Codex 计步覆盖新 turn 与宿主工具响应，包括无效参数反馈；不宣称精确计量原生内部所有模型生成。没有等价的单次输出 token cap 或金额预算。

schema18 为旧 Execution 添加默认 `pi` 的引擎列，并增加边界收据表。升级前在私有 `profile/backups/` 保存 SQLite 快照。旧版不认识 schema18；不能直接降级打开它。若恢复升级前数据库，升级后的新业务事实需另行保全；数据库备份也不替代原生存储、产物和记忆文件的完整备份。

## 验证

```bash
node --test test/codex-execution.test.mjs test/execution-harness.test.mjs
npm test
npm run test:eval-memory
```

专项用真实 Codex 二进制及明确配置的 loopback Responses 替身，覆盖真实工具/产物、等待重开、混合引擎、绑定前后崩溃、效果回执窗口、最终报告窗口、参数/调用身份、取消、更正屏障、资料依据、修订及迁移。无可用二进制时显式 skip，不能当作原生测试通过。完整回归还检查旧 Pi 场景。

真实模型烟测为显式付费入口，仅使用合成任务，经 ask_user 等待时关闭 runner，再重开回答并发布笔记：

```bash
node evaluation/codex-execution-probe.mjs \
  --codex-config /absolute/private/codex.json --output NEW_DIRECTORY
```

验证记录保存在 `evidence/codex-execution-20261107/`。真实 TokenHub + `deepseek-v4.1-flash-1017` 已通过该续接烟测；它证明实际接线和等待恢复，不代表长期无人值守或记忆 benchmark 分数提高。原 Pi 的 58/70 成绩保持原归属。
