## stage
源码修复与聚焦验证完成；完整发布门禁未全通过，用户已授权提交 MR；尚未发布。

## verified
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
- /data/mono2-custom-auto-vision-20261011，基于缓存 origin/master 3bc4384e5；本任务业务变更仅 ctl、frontend helper、OpenCraft 生成副本；现有其他脏文件不属于本任务。
- 详情见 2026-10-11-custom-auto-vision-fix.md；日志 /tmp/custom-auto-*.log。

## next_action
- 按用户授权创建两个本地提交（真源、生成副本），尝试 push/MR；DNS 和缺失连接妨碍远端交付时保留明确证据。新基线 CTL 缺 OpenTelemetry 缓存，完整构建/Docker 门禁待正常 CI；镜像无需修改。
