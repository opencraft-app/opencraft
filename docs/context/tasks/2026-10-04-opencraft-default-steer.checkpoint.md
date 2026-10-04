# 默认跟进 checkpoint

## stage
源码、真实组件/候选验证、独立切换重启与重连后复核完成。

## verified
- 32 项偏好/SQLite/Composer/Queue 单元检查通过。
- ui-preferences、Web 类型检查及 i18n、boundaries 通过。
- 实际预览 owner 已确认，当前 buildId compact-titlebar，数据目录与运行时保留。
- 源码真实 DOM 矩阵及候选真实 App 设置路由/Composer 验证通过；零页面与资源错误，无真实 Host 写入。
- 候选 `20261004-default-steer-59f854ec977a`、全部旧 immutable assets 与 runtime 原字节保留。源码 hook/ChatSettings 编译进候选，不包含全量 dirty 工作区改动。
- switch unit Result=success/ExecMainStatus=0；status.json complete/success，live UI evidence 通过，无回退。
- 当前 80 端口新 PID 2785955；原 service/cwd/data-dir 保留，runtime SHA256 不变，version 为 default-steer、health.ok=true，重连后逐项 Web manifest hash 通过。

## unverified
- 原生 iOS/macOS、真实推理不在本轮验收。

## discard
- 不使用全量 dirty checkout 构建覆盖并发预览。
- 首次 Chromium 缺 libgbm：使用机器已有 /data/lightvela-rpms/usr/lib64，未安装或改系统。
- 首次 selection probe 误把 ProseMirror 段落元素当 Text；修测试 TreeWalker，不改组件迁就用例。
- 若干脚本猜测路径查询失败后已改为明确目录和 AST 有界检查。
- 候选验证最初错误假设 Settings 常显；实际 Applications 未 pin，应先从 Applications 入口打开，再点 Settings。修验收序列，不改产品布局。

## restore
- 新源码：typed preference key、共享消费 hook、ChatSettings、主会话 Composer prop、翻译和测试文档。
- 新增 IndexedDB key 需同一 registry 驱动 BroadcastChannel 过滤，不能维护第二份硬编码清单。

## next_action
用户刷新当前页面；设置 → 聊天 → 回复时立即跟进可切默认方式。不需再次重启。旧 Web 保留可交换回退。

## execution receipt location
- independent unit: `opencraft-default-steer-20261004-switch.service`
- `/data/opencraft-default-steer-preview-QZZM4u/status.json`: scheduled/restarting/complete 或失败回退。
- `/data/opencraft-default-steer-preview-QZZM4u/live-evidence.json`: 重启后实际 80 端口包、真实 Settings/Composer、immutable hash 验收。
- 预期 buildId `20261004-default-steer-59f854ec977a`；旧 PID 1554252，unit/data/runtime/cwd 不变，新 PID 必须不同。
