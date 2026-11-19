# Bot 资源边界验证

基线：独立 lab `8a2dc8d`，工作树 `/data/build/worktrees/bot-resource-boundaries`；Core 搜索在 `/data/build/worktrees/unified-native-channels`。均未部署、未修改用户的运行 profile，没有调用付费模型。

## 当前证据

- `test/bot-resource.test.mjs`：13 项覆盖扁平 Markdown、换会话/重开、跨 owner/server/assignment 拒绝、路径与 symlink、引擎保留、写入接管、平台授权、撤权、忽略取消的 provider 以及交付前失效。
- 中间版本与 `test/continuation.test.mjs` 合跑 43/43 通过；随后与 `test/runner.test.mjs` 合跑 28/28 通过，最终 managed Bot 入口补测 13/13 通过。
- 首轮全回归 416/417：旧 pump 隔离测试缺失新增 UoW guard 的测试替身，已补上；补测通过。另将 guard 失效在 pump 边界记录为健康错误并停止调度，避免 interval 未捕获异常。
- Core 首轮 9/10 暴露关闭时持久转交窗口：关闭发生在异步 `transferring` 落库后、原生 `add` 前，恢复会判为未知。新增确定性测试先复现，再只对**尚未调用引擎**的关闭分支退回 accepted。未知实际 handoff 不回退，不重发。

- Core 确定性关闭测试、原生搜索/同步、真实 WebSocket 和原有协作共 32/32 通过；access-control TypeScript 检查通过。
- 实际 Unix socket 已验证异步群聊结果、普通状态返回与撤权失败，修复了同步序列化 Promise 的接入缺口。
- 中间全量回归 422/422 通过；追加 socket 适配后的全量回归 **425/425 通过**（511 秒）。启动必须注入 Host 授权接口的最终补测 13/13 通过。以上为真实本机存储/runner/协议测试与合成认证端口，不代表真实平台 Bot 登录、真实模型效果或线上验收。

最终证据保存在 `.local/bot-resource-validation/`：`full-suite.log`、`bot-boundaries.log`、`socket-and-runner.log`、`native-channels.log`、`handoff-before-fix.log`、`native-types.log`、`syntax.log`、`format.log`。174 个模块语法检查通过，改动代码格式检查和两个工作树的 `git diff --check` 通过。真实模型质量、线上自动分配和平台生产认证未在本轮验证。
