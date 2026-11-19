# 浏览器批注：实现与复核状态

本记录更新早期 `browser-annotation-spike-findings.md` 的空实现结论。
源码位于 `spike/browser-annotation`；本次未进行远端合入或服务发布。

## 本轮修复

- 草稿提交事务校验 draft 身份和提交阶段；切到另一会话再切回也拒绝旧截图。
  取消、退出、页面变化、卸载会使旧拾取和截图失效；并发提交不能重复写入或复用编号。
- 清除操作只影响当前标签页。编辑期间页面点击不替换当前选择；截图期间不允许切换层级。
- 悬停只保留一个在途请求和最新待处理位置。触控滚轮只保留一个在途请求，累加剩余位移，释放后不继续发输入。
- 注解关闭时停止布局 RAF；触控编辑层按 visualViewport 避让键盘。
  自动滚动后的层级选择通过原目标 selector 定位，目标缺失时失败而不改选旧坐标下的元素。
- 远程覆盖层写操作需要控制权和文档身份；控制权切换清除旧标记。
  标记绘制经过页面双 RAF 回执后，才允许后续截图。
- 页面代理支持释放和重建；取消事件监听、RAF、覆盖层、接收入口和待响应请求。
  桌面 guest 代理延迟加载，加载期间关闭页面不会重新安装代理。
- 持久化引用校验结构；截图引用只接受限长 image data URL；邻近敏感控件不进入文本证据。
  普通用户文字即使包含 Browser comments 标题也完整显示；仅凭文本不再推断隐藏范围。
- 使用主题排版和共享 Button/IconButton。注解编辑层、桌面页面代理、iframe 自动化实现按需加载。
  显式保持页面运行时代码与启动协议分块隔离，并合并共享 context 小分块；启动预算不变。

## 验证

- Workbench Web、browser-preview-bridge、browser-annotation 类型检查通过。
  原先的 154 个 Web 类型错误和 bundler Bus error 来自此工作树不完整的依赖；按锁文件重装后消失。
- Web 生产构建通过，包括启动资源检查和浏览器兼容检查。
  首屏：119 个 JS 分块；JS 3,518,875 B；CSS 711,686 B；gzip 1,199,322 B。
- 聚焦注解、Composer、聊天语义和启动资源测试共 62 项通过；远程会话/控制测试 43 项通过。
- `scripts/smoke/browser/smoke-annotation-file-preview.cjs` 可独立构建并运行，17 个浏览器断言通过。
  覆盖 opaque sandbox、真实鼠标拾取、滚动后选父级、脱敏、释放和标记清理。
- `scripts/smoke/browser/smoke-annotation-overlay.mjs` 20 个离屏 Electron 检查通过，
  包含绘制回执、截图带框、滚动和缩放、导航与 bridge revision。
- 额外在 Chromium 加载生产压缩后的 frame-source 产物，实际安装 sandboxed iframe 代理并拾取按钮成功。
  此检查验证 `.toString()` 注入没有被生产压缩破坏。
- 实际注解组件的明暗主题/桌面/触控布局已在独立组件场景目视复核；页面及 Composer 为合成场景。
  CDP 触摸输入与 IME 回放通过；触控测试的远程调用端为模拟边界，不是真机端到端证明。
- Typography 检查通过。全仓 controls/platform 检查仍有本次范围之外的失败
  （announcement-experience、既有 app.scss 控件覆盖、smoke-channel-avatars 私有产品依赖）；未调整基线。

## 仍需区分的边界

- 自有 HTML 预览保持 `sandbox="allow-scripts"`，未开启 allow-same-origin。
  可传文件位置和 DOM 证据，不提供该 iframe 的页面截图。
- 现阶段按当前页面位置拾取，未实现视频历史帧对应的精确命中；高延迟期间页面变化可能影响结果。
- 标记采用文档/固定坐标。嵌套滚动容器、sticky 切换、持续布局动画的目标绑定仍需专项实现和验收。
- 远程离屏截图已验证；桌面 webview 的无头截图不可用，不能将其算作桌面可见窗口截图验收。
- 文本证据脱敏不等于全页截图脱敏；当前截图仍是用户看到的页面。
- 未完成真实 Shell 登录后的全流程验收、手机实机键盘和网络链路验收；本记录不代表已部署。
