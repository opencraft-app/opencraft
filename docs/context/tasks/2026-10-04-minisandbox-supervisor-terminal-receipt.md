---
id: minisandbox-supervisor-terminal-receipt-2026-10-04
type: task
scope: 保持严格容量资格门禁，同时让最终缩容超时产生明确失败回执。
triggers: ["strict10k supervisor", "capacity convergence timeout", "容量失败回执"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/run-on-builder.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/verify.py
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

修复最终等待超时后set -e提前退出、没有最终失败回执的问题，并将实际进程exit status纳入资格。
不缩短36小时正常缩容窗口，不停止原supervisor、不修改immutable source、不绕锁发布。
不改controller或Cell、不直接scale/delete、不重编workerd、不运行新压测或物理恢复。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless/DO正式设计Phase5：low → 10k active → 正常serial drain → low，任何失败不得宣称通过。
- 用户“继续运行”：续接原句柄；source修复与cloud发布分开，不重复producer。

## interface_refs / data_structure_refs

- run-on-builder.sh保留initial 43200/final 129600秒窗口及deterministic Object cleanup。
- verifier增加显式load/cleanup/final-capacity exit statuses；任意非零不能生成passed。
- whole-operation flock仍由原wrapper持有；最终结果只有完整资格证据才能通过。

## history_context / acceptance / affected_paths

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：原7d5fa6ac负载FAILED、cleanup PASSED后正常缩容等待；A111/115，B4/4。
- superseded_refs：prepared launcher不是新提交授权，也不是strict10k成功回执。
- 验收：真实Bash runner的离线double能证明超时仍调用verifier；非零exit拒绝成功；完整成功路径不变。
- 受影响：run-on-builder、verify及测试、README、正式设计、Task/catalog。

## required_context / context_receipt

| 文件 | 原因 | 用途 |
|---|---|---|
| AGENTS.md、infra/cells/AGENTS.md@ffe633e6 | 全文 | 唯一写入源及锁/不强删合同 |
| release-gitops.md、upstream-subtrees.md@ffe633e6 | route全文 | source不等于cloud发布 |
| adjacency/argocd-ci-secrets.md@ffe633e6 | 全文及launcher测试邻居 | immutable release验证 |
| fleet/README.md@ffe633e6 | 全文 | serial operation ownership |
| run-on-builder.sh、verify.py、test_verify.py@ffe633e6 | 全文 | 精确失败路径及不放宽资格 |
| operations/with-autonomy-operation-lock.sh@ffe633e6 | 全文 | 原workflow存活期间不释放/绕过锁 |
| 2757 admission/launcher prepared及test_launcher_admission.py@ffe633e6 | 全文 | 48h service/36h final窗口关系 |

## evidence / risks / validation / decisions

- 原snapshot保持不变，当前独立源码change从ffe633e6后开始。
- final wait原来是未捕获的set -e命令，超时跳过verifier；成功receipt也未绑定实际命令exit status。
- cloud-environment技能及network参考全文读；environment_status不可用、policy缺失不证明ready。
- 不提前退出释放live锁；source修复只改善未来相同资格流程失败证据，不修复A拓扑阻塞。
- 验证：actual Bash离线test、verify/release/launcher regression、bash -n、文档/context/impact/secret门禁。
- inv-d9fi2j0uh4 SUCCESS/0：23:35:02Z原supervisor同InvocationID/PID仍active，A111/115、B4/4、
  active0。只读续接，没有修改cloud或原source；下一常规观察不早于23:40:07Z。
- 红测试先因缺少显式exit-status CLI不能生成receipt；最小修复后全部63项严格容量/分析/launcher
  回归通过，router consumer邻居5项通过。actual Bash double覆盖成功、final timeout、load/cleanup
  command失败及missing input，并断言observer退出、只允许kubectl GET及0600 receipt。
- final wait在conditional中执行会禁用Bash函数内部errexit，故显式检查日志pipeline与sleep失败。
  final窗口保持129600秒，不从source修复推断原live流程已修复。
- 文档检查零errors/warnings；8项显式变更集合impact passed；bash -n与diff检查通过。
  context 26项测试仍为同4项历史失败，4970条历史errors排序后与上轮基线逐字一致，
  new Task没有错误；audit 33项测试通过。不将历史治理门禁称为全绿。

## scan_scope / scan_output

- load/ten-thousand-active、operations/with-autonomy-operation-lock；有界rg定位final/timeout/receipt。
- 输出仅本机/data/tmp和该Task摘要；不读取credential内容或其他租户日志。

## checkpoint / handoff

- stage：未来source失败路径修复并通过离线回归，尚未变更cloud。
- verified：失败后的36h等待是既有策略，不是新workload；timeout确实跳过最终verifier。
- unverified：未来source回归与原live缩容；完整Phase5未通过。
- next_action：完成source/context/impact/secret门禁及授权FF push；按原5分钟节奏续接同supervisor。
