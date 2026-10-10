# 打包给 OpenCraft iOS 的 Bot DOM 入口

先遵循 `frontend/AGENTS.md`。本目录的 `entry.tsx` 复用主站已有 Agent 页面、Provider 和仓库逻辑，由 `opencraft/apps/workbench-expo/scripts/build-mobile-bot-runtime.mjs` 打包进 Expo；不要在这里复制第二套 Bot 功能或把原生侧栏改成网页侧栏。

原生与 DOM 的双向消息以 `@opencraft/mobile-bot-bridge` 为唯一契约，阅读 [桥接设计](../../../opencraft/docs/mobile-bot-bridge.md)。添加消息时同步改包、两端与聚焦测试；不要直接向 `ReactNativeWebView.postMessage` 塞无版本的任意对象。命令要先验证 runtime ID 和 payload，外部链接交给原生壳做站点与协议检查。

每次改本目录或它引用的 Bot 页面，运行本地 DOM 构建和 smoke；涉及共享包时同时跑 frontend 与 Expo typecheck。当前 UI 整体由主站 CSS 控制，原生导航和控件规范见 [Expo 局部入口](../../../opencraft/apps/workbench-expo/AGENTS.md)。
内嵌页面自身只能纵向滚动：根文档和内容区限制在容器宽度内，宽表格、代码或文件列表在控件内部响应式排布或局部滚动，不能把整个 WebView 撑宽。不要靠禁用原生抽屉手势掩盖 DOM 横向溢出；桌面主站样式保持独立。
内嵌 DOM 的展示文字默认不可长按选中；输入框、文本域及可编辑区域必须保留光标和系统编辑菜单。需要复制业务数据时提供明确的复制控件，不让 iOS 选区高亮充当按钮反馈；这条规则只作用于打包的手机 DOM，不覆盖主站网页或原生 Chat。
