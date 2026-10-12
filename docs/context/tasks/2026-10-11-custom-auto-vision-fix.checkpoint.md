---
id: custom-auto-vision-fix-checkpoint
type: task
scope: 默认模型图片能力修复的交接状态
triggers: ["custom auto vision"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - ctl/pkg/instance/async.go
  - frontend/src/pages/marketing/agent-model-config/hermes-model-config-command.ts
status: active
reviewed_at: 2026-10-11
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: false
---

## stage
分支已推送，工蜂 MR !5186 已创建，目标 master；未合并、未发布。

## verified
- 当前主干配置套件 235 测试通过；测试断言类型问题修正后，95 聚焦测试再次通过，类型检查新增诊断为 0。
- 当前主干 9efa2102f 上 instance 包测试（跳过一个 Docker 用例）、go vet、136 文件同步检查通过。
- MR 新基线配置套件 234 tests passed；下面其他验证来自原实现基线，不能代替新基线完整门禁。
- CTL custom/auto 写入后合并并回读 supports_vision=true，ACLI/harness/legacy/幂等测试通过。
- 恢复默认配置补齐能力，移除旧顶层能力覆盖，保存失败回滚；配置套件 234 tests passed。
- CTL 相关测试、go vet 与跳过单个 Docker 用例后的完整 instance 包测试通过。
- frontend check 0 new diagnostics；OpenCraft 插件 typecheck、生成闭包检查通过。
- 文档检查与 docs-impact、git diff --check 通过。
- 本机真实 Hermes 0.21.0 的隔离测试通过两个 helper 的真实保存/回读、RSA 凭据流程、同进程热读与真实 AIAgent 消息原图保留；本机运行配置哈希不变。

## unverified
- 完整前端 build：Turbopack 与 webpack 都未在验证窗口内完成，已中止。
- Docker 相关 TestDestroyInstanceDoesNotRecordAcceptedEventWhenAlreadyDeleting 在本环境失败。
- OpenCraft 整文件测试无完成结果；筛选命令未提供有效功能测试计数。
- 线上新实例与网关原图请求；存量补齐不在本次实施范围。

## discard
- 默认 Go 依赖下载失败不是最终 CTL 聚焦门禁阻碍，已用离线缓存完成。
- 不把筛选 Node 测试的文件级 pass 当作具体功能测试通过。

## restore
- /data/mono2-custom-auto-vision-20261011，已 rebase 当前 origin/master 9efa2102f；本任务业务变更仅 ctl、frontend helper、OpenCraft 生成副本；现有其他脏文件不属于本任务。
- 详情见 2026-10-11-custom-auto-vision-fix.md；日志 /tmp/custom-auto-*.log。

## next_action
- MR：https://git.woa.com/wisp/mono2/-/merge_requests/5186；等待评审与 CI。
- 使用已恢复连接推送 fix/custom-auto-vision-20261011 并创建面向 master 的 MR；新基线 Go 包测试（跳过 Docker 用例）与静态检查已通过；继续前端检查，完整构建及 Docker 门禁待 CI。MR 描述保存在 /tmp/custom-auto-mr-description.md。
