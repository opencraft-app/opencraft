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

## 前端预览制品（StaticPages）

`.ci/runtime/commands/publish_frontend_preview.sh` 构建双站（cn/intl）Next 产物并经 `staticpages_pack.py` 以 packs 分卷（target 32MB / max 48MB）直传对象存储，不经 API 网关。两个边界决策：

- 产物冻结与打包阶段均排除 `out/.edgeone`（EdgeOne Pages 部署目录，内容是 `out/` 的完整副本）：它是构建内部部署格式而非站点资源，进入上传包会把体积翻倍。预览发布器取自 `origin/master`、frontend 源码取自触发分支，老分支的构建链路可能仍写出该目录，因此 runtime 侧删除与 `iter_files()` 的 `EXCLUDED_DIR_NAMES` 兜底双保险。
- 预览产物压缩体积以 ≤50MB 为预算（`tar -czf - --exclude='./.edgeone' -C frontend/out . | wc -c` 口径）：超预算直接推高上传耗时（1800s×3 次重试）、对象存储成本与预览站首屏加载。图片资源一律 webp 化（quality 82），新增 public 图片资产必须先转 webp 再入库。

## 回滚

回滚目标是上一已知健康的 GitOps pin 或应用 revision，不用本地未审阅 manifest 覆盖集群。数据库变更必须预先声明向前/向后兼容与独立恢复方式。

邀请返利在北京按依赖分段放行：先准备 Pulsar/Secret/Plan 和三个 schema，再启用生产者 relay 与
consumer，最后开放 Gateway 与前端。任一步失败时关闭环境级开关即可停止新增事件和用户入口，已写
outbox/inbox/reward 记录保留用于恢复；不得通过删除审计记录或重复创建奖励来回滚。

## 授权

commit、push、MR、流水线触发、GitOps 合并、Argo 操作和生产验证是不同授权面。用户只批准前一层时不得自动扩大到后一层。
