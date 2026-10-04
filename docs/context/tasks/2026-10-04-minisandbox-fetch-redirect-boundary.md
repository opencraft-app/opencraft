---
id: minisandbox-fetch-redirect-boundary-2026-10-04
type: task
scope: 用户Worker重定向不得触发平台内部fetch或泄漏路由能力。
triggers: ["Worker重定向", "fetch凭据边界", "内部代理自动redirect"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/workersapi/api.go
  - minisandbox/infra/cells/internal/workersapi/fetch_redirect_test.go
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进完整stateless/DO方案的内部代理边界：3xx原样交给调用方，不允许平台跟随用户Location。
不部署云资源，不重编workerd，不改变原strict10k任务或其36h窗口。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式设计安全/失败章节：用户response不可信，能力token只发给placement/executor的受信服务。
- b5e9a819基线fetchClient未设置CheckRedirect；标准HTTP client可跟随3xx，转发内部能力header。
- TLS和Registry故障矩阵仍保留原范围，本轮先收敛实际发现的redirect边界，不宣称它们已完成。

## interface_refs / data_structure_refs / history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md安全/网络与失败矩阵。
- relevant_evolution：b5e9a819源码基线；fetchTransport已有DisableKeepAlives，不能凭猜测认定它
  会重用连接后重放请求。实际client1.25.4源码确认ErrUseLastResponse保留3xx与打开的response body。
- superseded_refs：以默认Client redirect行为承载透明HTTP代理；不全局修改控制plane client。
- fetchClient为stateless dispatch、durable fetch和stateless prepare共享；准备接口遇到3xx必须失败。

## acceptance / affected_paths

- 真实HTTP upstream返回3xx，API返回相同status/Location/body，第二服务器零请求/零凭据。
- 无状态、DO及首次prepare路径均覆盖；成功2xx、流式和断连语义不能变化。
- 本轮只改fetch client policy、聚焦回归、正式设计和Task/catalog。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根AGENTS及minisandbox/infra/cells AGENTS@b5e9a819 | 本轮读取根，局部正文前轮全文且diff为空 | jj先建修订、锁、只改唯一mono2 |
| upstream-subtrees@b5e9a819 | route全文 | source与GitOps分离 |
| agent-gateway-runtime、ctl、sandbox服务Pack@b5e9a819 | 本轮router must_read全文 | 区分公共调用与本地协议证据，不改其他服务 |
| adjacency/argocd-ci-secrets、实际publish-cell-serving-route及tests前轮、API fetch实现本轮 | 卡片与真实邻居 | 固定route不能由用户Location绕过 |
| TASK/CHECKPOINT模板、api.go/fetch_trace.go/log_safety_test.go及已有API tests | 本轮正文 | 原代理、流和错误语义 |
| 当前Go1.25.4 client.go与transport.go | 本机主源 | redirect和新连接策略，不猜SDK行为 |
| context-audit Skill及assessment/rubric/report契约 | 本轮全文 | 用包装器记录局部门禁，不伪造仓库分数 |

## evidence / risks / validation / decisions

- red：真实TCP的10例stateless/DO重定向均有第二次请求及内部header；5例prepare重定向
  最终返回201，错误激活候选Version。原回执在/data/tmp/fetch-redirect-full-red-20261004.log。
- green：完整workersapi/objectrouter的race回归81项顶层测试通过，包括上述15个子用例；
  go vet通过。回执为/data/tmp/fetch-redirect-race-20261004.log、fetch-redirect-vet-20261004.log。
- 文档检查零错误/警告，change-impact通过但没有命中规则，不据此宣称语义评审完成。
  Context错误数组与原5026项基线逐字相同；根26项测试保持原四项失败，audit33项通过。
- 使用测试能力常量，不读取或输出真实secret；仅本地server，不代表云CCN或mTLS资格。
- 选择显式ErrUseLastResponse，不自动剥离若干header后继续访问任意Location。
- 恢复原源码是回退方式；source提交不等于云部署，生产验证仍须操作锁和探索先行。

## scan_scope / scan_output / handoff / checkpoint

仅本轮文件及自己的catalog行；日志回执留/data/tmp。
stage：源码修复与完整本地Go回归；verified：red/green、原3xx保留、prepare拒绝、无额外出站。
unverified：云发布、原万活跃/安全缩回、完整CLS通道及真实网络故障矩阵。
discard：fetchTransport会重用HTTP1连接的猜测；已有源码明确禁用reuse。
restore：唯一mono2当前修订/b5e9a819；原strict10k保持不变。
next_action：提交源码；原strict10k结束后，先探索模式验收再生产资格。
