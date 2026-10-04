## stage
宿主最小高度修复及浏览器回归已实现；准备源码提交、正常 MR 合并。

## verified
- 国内 Next 完整构建通过；前端 check 166 current/171 baseline/0 new。
- 真实构建 CSS + 原 viewport helper 的 Chromium 几何回归通过：layout844/visual460，修复 root460、Composer fixture360–460；旧 min-h-dvh 负对照 root844、Composer744–844，被可视区遮挡。
- visual pan40 后 root500；键盘收起恢复844；保留焦点和草稿；解绑清除变量；普通页面保持最小844；桌面嵌入仍844。
- 130 文件 Agent Console 只读同步检查通过，4个实现/测试路径未命中正式文档影响映射。

## unverified
- 无真实 iPhone/WebKit 系统键盘验收；浏览器几何 fixture 不等于真实手机或完整 Host 会话验收。
- 广范围 marketing 测试出现多项失败及 fork OOM，不能宣称整套全绿；直接相关4文件25测试已单独通过。
- 工蜂正常审核/合并结果尚未确认；生产不在授权发布范围。

## discard
- 不改 helper 坐标算法，不新增 observer、延时、滚动补丁；不修改独立 OpenCraft。
- 广范围测试最终退出1：113/133文件通过，1698测试通过、25失败、5 worker错误；尝试停止时进程已自行退出，不再有该进程。

## restore
- 分支 fix/lightvela-embed-keyboard-viewport-20261005，checkout /data/mono2-opencraft-startup-delivery-20261004。
- 自有脚本 frontend/scripts/check-agent-chat-viewport.mjs，需外部 Playwright/Chromium；完整使用条件与限制见主 Task Pack。
- 构建生成 next-env/font 已从自有 /tmp/lightvela-viewport-build-backup-20261005-WhlkdN 恢复。
- 启动任务旧文档、optimization-queue 与 .kube 保留但不 stage。

## next_action
新鲜fetch确认基底与master同为e0c1f1b37，无需整合。精确 stage、docs-impact、commit/push，按正常工蜂 MR 门禁合并。
