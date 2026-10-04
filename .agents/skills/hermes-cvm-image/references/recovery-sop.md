# 中断恢复与 checkpoint SOP

用于 runner 重启、心跳超时、SSH 断开、部分派发和用户担心重复升级。先准备只读恢复计划。
新 master 的恢复逻辑不自动进入旧构建快照；原流水线 retry 是否取新脚本必须实查。

## 识别中断与证据

`Terminate Plugin ... 心跳超时` 是 runner 失联；AgentNotInstalled/AgentStatusNotOnline 是
目标 CVM TAT 错误。两者可同时出现，分别看 node_alias、uptime/service、任务日志和 checkpoint。
runner 重启不表示已经派发的目标命令停止。确认是否存在同轮恢复进程，避免同时派发两遍。

旧输入与结果：

```text
.ci/.runtime-state/hermes-rollout/<env>/hermes-tat/
  vms.jsonl
  vms-<region>.jsonl
  command-<region>.env
  hermes-tat-invoke-<region>-<timestamp>.jsonl
```

现顶层 repair 默认 checkpoint：

```text
/tmp/lightclaw-ci/hermes-tat-checkpoints/<scope>/<env>/
```

scope 为 HERMES_TAT_CHECKPOINT_SCOPE，否则 BK_CI_BUILD_ID，再否则 manual。region 从文件名
分开，sgprod 的 Singapore/Johor 可共用 env 目录。手动恢复显式设 scope，不让不同升级共用 manual。
迁移旧文件时复制保留原件，记录 build/env/region、CommandId、blueprint、payload commit/hash
和 inventory。该路径在 runner 本地 /tmp，可能被清理；跨机器、销毁或换节点不会自动迁移。

## 当前恢复保证

| 记录 | 含义 | 恢复决策 |
|---|---|---|
| INVOKED + invocation_id | API 接受派发 | 默认跳过；查原 invocation 完成状态 |
| INVOKE_FAILED | 未取得接受响应 | 查错误及原任务，超时响应存在未知窗口 |
| 未记录 | 未处理，或接受后未落盘 | 查旧日志/TAT，不能断言未执行 |
| DRY_RUN | 模拟结果 | 不当作已派发 |
| exit 0 / progress 100% | 遍历与汇总完成 | 仍需核对失败和远端终态 |

当前 invoke 不传去重 ClientToken，不等待远端终态。API 接受到落盘之间仍有重复窗口，checkpoint
不提供 exactly-once；并发恢复也会重复。跳过只按 cloud_id，不核对 blueprint/payload hash。
顶层重试会新建命令并动态解析 blueprint，若中断期间上游变了，可能在同一 scope 混版本。
恢复优先复用已确认旧 CommandId，保持本轮目标一致。

解析器当前会忽略所有 JSON 语法错误行，并非只容忍坏尾行。正常 crash 尾行可以解释；中间
大量坏行、未知 schema、非对象行不应自动忽略。保留原件，检查损坏位置。缺失历史结果时停止
自动全量重跑，先查询原任务/重建已接受记录。版本已到目标也不能证明所有修补动作都执行了。

## dry-run

底层 invoke 的 dry-run 不派发；顶层 repair 还会枚举/创建 Command。加载受控 command env，
明确同轮 region/input/skip/output。CSV skip 路径不要包含逗号，dry-run 放独立子目录：

```bash
HERMES_TAT_REGION="$REPAIR_REGION" \
HERMES_TAT_COMMAND_ID="$HERMES_TAT_COMMAND_ID" \
HERMES_TAT_INPUT_FILE="$REPAIR_INPUT" \
HERMES_TAT_OUTPUT_DIR="$REPAIR_DRYRUN_DIR" \
HERMES_TAT_SKIP_INVOKED_FILE="$REPAIR_SKIP_FILES" \
HERMES_TAT_DRY_RUN=true \
bash .ci/runtime/commands/invoke_hermes_tat_command.sh
```

只收同轮真实派发 JSONL。skipped 是 skip 集合大小，可能包含不在当前 input 的 ID；核对当前
去重 inventory 交集，不机械使用 targets+skipped。targets=0 时当前实际 invoke 会因不存在结果
JSONL 汇总失败，应直接报告无需新增派发并验收原 invocation。每次用独立输出目录防命名冲突。

## 后台续跑

复制经 merge 验证的代码或 git archive 到独立 recovery 目录，核对 commit/hash，避免 CI checkout
清理运行中的脚本。审阅大历史 inventory 的 CVM/TAT 存在性和 online；凭据从受保护环境读取，
不写 wrapper，不放命令参数，不使用 sshpass -p。SSH 断开应比较交互/非交互路径，不未经证据
归因于密码、唯一 root 会话槽或 PAM 故障，不猜测后改 sshd/重置密码。

确认没有同轮恢复进程，再在已授权范围启动 tmux 或 nohup。PID 文件不是锁，需要串行操作或
runner 已有 flock 等防重入机制。wrapper 只加载同轮 CommandId/input/checkpoint，调用底层
invoke，并用 EXIT trap 落退出码：

```bash
nohup bash "$REPAIR_WRAPPER" >"$REPAIR_LOG" 2>&1 </dev/null &
REPAIR_PID=$!
printf '%s\n' "$REPAIR_PID" >"$REPAIR_PID_FILE"
kill -0 "$REPAIR_PID"
```

断开后重新连接，查 PID cmd/start time 防复用、日志更新、progress/exit。nohup/tmux 可脱离 SSH，
不能跨机器 reboot 存活；再次重启仍需 checkpoint。监控只读，不自动重复启动同一操作。

## 收尾

当前脚本含 INVOKE_FAILED 也可能 exit 0，分别报告遍历、接受派发、失败、远端执行成功。
保留汇总，终态后删除监控。恢复不会把原蓝盾失败改绿；旧快照全量 repair 不读新 checkpoint，
不要为绿灯直接重试，应把恢复结果作为交付证据，未来构建消费合入后的脚本。
