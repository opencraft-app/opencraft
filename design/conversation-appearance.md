# 会话图标

用户从会话标题的图标或侧栏/顶部的「更改图标」打开同一选择面板。
采用共享 utility ModalSurface 和 Button/IconButton；颜色、图标两组选项，恢复默认为次动作，关闭为完成。
面板拥有内容间距与滚动，ModalSurface 拥有焦点、退出和触控呈现。
选择面板及其样式按需加载，首屏只保留外观读取、图标与入口；构建门禁阻止面板进入静态启动依赖图。
使用现有自绘图标和 workbenchIconMetrics；预设颜色消费主题 badge 语义色（包括新增 yellow、pink 配对），自定义颜色仅接受六位十六进制值。
ColorInput 的原生选择入口、触控尺寸、描边与圆角由 design-system-web 持有，业务不重写控件外观；面板沿用 compact modal 尺寸、settings panel 内距和 typography role。

这是个人客户端外观。`UiPreferencesRuntime` 的 `chat.conversationAppearances` 为唯一持久 owner，
以账号 display scope、Host、Thread 组成无歧义键。Web 使用现有 IndexedDB adapter，桌面使用现有 preference port。
本期不提供跨设备同步或上传图片，不宣称服务器共享会话元数据。
默认会话在侧栏保持原样；顶部默认图标提供入口。图标独立于执行状态、未读标记及模型身份。
选择即提交，提交成功后所有消费者同步更新；失败保持已确认外观并使用 AsyncNotices 提示。
同一 runtime 写入保序，多窗口 CAS 冲突重新应用实体修改，恢复默认只删除对应键。
切换路由/账号关闭面板，迟到写入只落在原作用域，不关闭或改写后来打开的面板。

验证覆盖保存与重新打开、账号/Host 隔离、多窗口并发、失败恢复、共享侧栏/顶部入口、键盘和触控、浅深主题与扩展主题。
