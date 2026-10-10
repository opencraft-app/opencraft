---
id: minisandbox-router-performance-serialization-2026-10-04
type: task
scope: Router性能编排与原容量及舰队操作整段互斥。
triggers: ["Router性能操作锁", "容量性能并行拒绝", "性能编排互斥"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/run-on-builder.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/test_run_on_builder.py
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进stateless/DO完整目标的Phase5性能编排：正式性能负载不得与容量supervisor、release或
资格任务重叠。复用现有操作锁，不引入另一协调器。不改云状态、原strict10k句柄/36h窗口、
运行时、负载/容量资格谓词，不以本地测试宣称云验收。

## requirement_ids / requirement_refs / requirement_excerpt

正式2026-09-22-stateless-workers-durable-object-routing设计Phase5要求真实Router性能证据；
infra/cells AGENTS要求高风险工作持有完整operation lock。性能入口会发布Worker/Object并
发起五分钟真实负载，旧实现只有router-performance.lock，不能与capacity/release互斥。

## interface_refs / data_structure_refs / history_context

current_design_refs：上述正式设计及性能README。
relevant_evolution：a7872881先验证完整10k容量receipt；现有capacity-cycle生产/探索共享
ten-thousand-active.lock，探索还使用with-autonomy-operation-lock.sh。
superseded_refs：认为负载后的collector只读就能使整个性能编排不必持锁。
保留现有capacity receipt校验、endpoint receipt、固定规模、零重试与精确cleanup语义。

## acceptance / affected_paths

- fleet/capacity/performance任一锁冲突，在输入选择、实验目录及API之前拒绝。
- 已由外层持有fleet锁时不自锁，仍检查capacity/performance锁。
- 实际子进程执行时三锁都排他，preflight失败退出后全部释放。
- 修改性能入口/测试/README、正式设计、Task及自己的catalog行。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根、minisandbox、infra/cells AGENTS全文 | 当前继承指令 | jj先新修订、原任务不变、整段锁 |
| upstream-subtrees Pack全文 | router唯一must_read | mono2唯一真源 |
| adjacency/argocd-ci-secrets及实际CLS GitOps测试 | 卡及一个部署邻居 | 准备声明不等于发布资格 |
| 正式设计Phase4/5、性能与探索README | 有界精确检索 | 探索先行、性能资格不缩小 |
| 性能shell/tests、现有operation wrapper及capacity-cycle | 实际实现 | 复用锁次序与外层所有权 |
| TASK/CHECKPOINT模板、context-audit主文及assessment/rubric/report | 阅读正文 | 局部回执、保留历史基线，不造评分 |

## evidence / risks / validation / decisions

- red：四条真实shell/flock回归均失败，见/data/tmp/router-serialization-red-20261004.log。
- green：入口原五条及新四条回归通过，见/data/tmp/router-serialization-green-20261004.log。
- 完整性能工具54项通过，Bash syntax、diff检查通过；见
  /data/tmp/router-performance-suite-20261004.log。
- 文档检查零错误；根Context保留历史5026问题与26项中的原四项失败，audit33项通过。
- fixture只在/data/tmp持有本地锁、FIFO及命令级暂停，不访问云/真实secret。
- fleet锁由既有flock supervisor持有；shell描述符保留capacity/performance锁至退出。
- 标记AUTONOMY_OPERATION_LOCK_HELD是既有操作协议，不是授权或安全沙箱。
- 原strict10k仍是等待而非完整通过；锁冲突不是负载重启或清理授权。
- 未执行云性能负载、CLS collector、controller发布或模式切换。

## scan_scope / scan_output / handoff / checkpoint

stage：局部编排修复；verified：旧缺口复现、新互斥与失败释放；unverified：云发布与完整目标。
discard：仅性能专属锁可隔离舰队变更的假设。
restore：基线0ad18383及本轮独立jj修订；原PID/Invocation仍按只读句柄观察。
next_action：完成局部suite、根历史基线和敏感扫描后提交；原锁释放后先探索再生产资格。
scan仅本轮路径及自己的catalog行；回执保存在/data/tmp，不上传payload或secret。
