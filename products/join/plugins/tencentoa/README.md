# Tencent OA 插件

## 手机入口

桌面 Web（主指针为 fine）激活 IOA 后，侧边栏底部显示手机图标。确认员工身份且页面可见时，首次展示手机工作区预览与二维码。手机和内嵌页面不注册该入口，不弹出递归引导。当前 manifest 仅支持 Web，未扩展到独立 Electron 登录装配。

预览 iframe 直接打开当前工作区的正式页面，走同一个 `main.tsx` 和 `WorkbenchRoot`，使用当前浏览器已有的认证；不另外实现聊天、终端、文件或工具概览。操作真实生效，通过既有服务器协议与其他客户端同步。各客户端仍独立持有焦点、滚动和导航；这不是屏幕镜像，也不引入客户端之间的 DOM 或状态转发协议。

iframe 的 `data-opencraft-preview="mobile"` 是同源 frame 内临时的触控呈现意图，由共享 density owner 消费，不写安装级触控偏好。窄视口由浏览器实际布局，不缩放桌面截图；鼠标仍是鼠标，软键盘、系统菜单和物理触摸需在手机实测。主题通过既有 appearance owner 投影同一主题选择；Escape 在内层未消费时交给外层 ModalHost。

每次打开解析当前地址：二维码和 iframe 使用同一个工作区路径，仅保留 `hostId`、`draftId` 路由字段，丢弃其他 query、hash 和凭据。localhost、loopback 和非 HTTP(S) 地址不提供。扫码不会传递桌面登录态，手机仍按本站现有登录及准入规则访问。

展示记录为 `localStorage["tencentoa.identity.mobile-guide.seen.v1"] = "1"`，只属于当前浏览器和站点，不随账号同步、不写数据库。点击手机图标可重新打开。面板同时显示二维码和实时手机预览；尺寸与主题变化保留同一内嵌工作区，关闭不会清除展示记录。存储被禁用时，每次插件激活最多自动展示一次。插件销毁或生成期间失去展示资格会取消后续展示。

产品只贡献序列化 `preview.path`、二维码与文案。核心 AnnouncementCenter 验证同源路径，ModalHost 持有弹窗、关闭、焦点与主题桥。内容按需加载，不启动另一套 Demo，也不更改静态服务器的准入策略。

验证：`node --import tsx --test products/join/tests/ioa/mobile-guide.test.ts tests/shell/announcement-messages.test.ts`；Web 和插件类型检查；正式产品 Web 构建。`node --import tsx products/join/scripts/smoke-mobile-guide.ts` 以合成身份和 Host 边界运行完整 WorkbenchRoot，验证父子使用同一入口、临时触控呈现、主题同步、无递归引导、关闭及提示记录。截图和记录输出 `.local/mobile-guide-experience/`。这不代替真实账户的外部服务、微信扫描和实体手机验收。

面板默认展示二维码和“用微信扫一扫，打开当前工作区”。二维码由产品侧本地生成，使用 H 纠错级别，中央微信标识直接绘入 PNG；标识资源失败时降级为可扫描的普通二维码。打开面板即创建 iframe，扫码说明和手机预览同时可见；宽屏左右分区，窄窗口上下排列。预览中的鼠标拖动与真实触摸复用 Shell 的侧栏手势仲裁和动画，输入框等独占输入区域保持原行为；普通桌面页面不启用鼠标滑动模拟。二维码生成和解码检查覆盖首页及带 Host/草稿参数的会话链接。

### Sidebar participant preview

The avatar badge is a secondary action: mouse hover waits 600 ms before opening
its existing participant popover. Leaving, cancelling contact, scrolling over the
badge, or starting an explicit action cancels the pending preview. Timers are
also disposed when the badge unmounts or its host/conversation changes. Clicking,
tapping or keyboard activation still opens immediately; a hover preview does not
steal draft focus. The existing 150 ms leave grace permits moving into the popover.

Run `node products/join/tests/ioa/participants-hover.browser.mjs` from an assembled
workspace to check the actual Shell/sidebar row and shared menu owner in light,
dark and touch contexts, with synthetic employee data and no external writes.
