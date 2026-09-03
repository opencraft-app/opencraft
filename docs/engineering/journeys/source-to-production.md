# Journey：源码到生产

## 目标

把一个已验证的源码变更转化为可追溯、可回滚的生产运行状态，并清楚区分每层证据。

## 链路与完成定义

1. 源码：在 `master` 上存在目标 commit，服务 lint/type/test/build 通过。
2. 制品：`.ci` 生成预期镜像或 runtime artifact，tag/digest/SHA 可见。
3. GitOps：promote MR 把目标 image/artifact pin 写入 `gitops`，不存在未解决冲突。
4. Argo：目标应用指向预期 revision，状态为 `Synced` 与 `Healthy`。
5. 运行态：Pod/服务健康，版本/selfcheck 与预期一致。
6. 业务：通过公共入口完成最小关键路径；必要时执行灰度、监控和回滚演练。

## 回滚

回滚目标是上一已知健康的 GitOps pin 或应用 revision，不用本地未审阅 manifest 覆盖集群。数据库变更必须预先声明向前/向后兼容与独立恢复方式。

## 授权

commit、push、MR、流水线触发、GitOps 合并、Argo 操作和生产验证是不同授权面。用户只批准前一层时不得自动扩大到后一层。
