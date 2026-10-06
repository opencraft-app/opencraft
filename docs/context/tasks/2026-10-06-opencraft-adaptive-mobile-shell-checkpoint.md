## stage
Shell 自适应实现及本地验证完成；下一步为 iPad 真机体验验收。

## verified
- 唯一几何模型派生窄抽屉/宽侧栏、全页/账号面板；业务导航仍使用 mobileShellTransition。
- 保持 Bot/Chat/DOM 树身份和账号首次访问后的编辑 owner；Chat 使用自身容器宽度。
- 16 项模型测试、Expo 类型检查、最新 iOS bundle、diff 检查通过。
- Metro 与 Cloudflare 本地 systemd 服务均 active/running；manifest 轻量检查通过。
- 后续设置退出突变修复：终点取宿主右边界，手势速度进入统一收尾 spring，完成时阴影无残留再交接导航；新增终点回归，8 项聚焦测试及最新类型/iOS 打包/manifest/影响检查通过。

## unverified
- 无 iPad/模拟器。横竖屏、分屏、连续缩放、浮动/外接键盘及手势实际体验未验证。
- 设置慢拖/快甩松手、回弹、按钮返回的真机帧率与视觉效果需复验，源码修复不等于真机不卡顿证明。

## discard
- 旧隧道 responsible-locate-determined-suggests 已失效，不再使用。
- 不把纯几何测试当作组件保活或真实设备交互证明。

## restore
- 工作树 /data/mono2-mobilefirst-20260930，包含大量此前变更，保持原样；本轮未提交/推送。
- 正式设计 opencraft/docs/mobile-shell.md；完整记录 2026-10-06-opencraft-adaptive-mobile-shell.md。
- 核心源码 mobile-shell-layout.ts、interruptible-mobile-drawer.ios.tsx、native-navigation-surface.ios.tsx、app/index.tsx、workbench-frame.shared.tsx。
- 预览 exps://kijiji-anybody-common-calibration.trycloudflare.com 。仅轻量检查，禁止为核验下载完整外网 bundle。
- 服务 opencraft-expo-cf-preview-20261006 / opencraft-expo-metro-preview-20261006；不要操作实际 OpenCraft server 服务。

## next_action
- 按任务包真机路径验证 iPad 并记录具体观察；没有设备时明确交付限制。
