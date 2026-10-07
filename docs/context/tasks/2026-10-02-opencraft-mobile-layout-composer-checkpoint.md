## stage
本地 Bot DOM 的窄屏布局和原生 Composer 代码已构建验证；Expo CLI 已登录，等待 iPhone 真实输入、触控验收。

2026-10-03 逐项验收审计见主 Task Pack 的 `acceptance_audit_2026_10_03`：模拟窄屏、共享代码及原生状态模型有证据；真实 WKWebView、Fabric、选择器与 Host 发送仍没有设备证据。当前 Hermes Host 不提供工作区和权限目录，不能将空目录描述为已具备选择能力。

打包 DOM smoke 增加 15 个原生侧栏可见 Bot 功能的正反向连续切换；普通与本地 Bot 场景均通过，无空根或渲染边界失败。假 API 返回 401，故不代表真实数据或 iPhone 布局验收。

## verified
- 当前工作树 `/data/mono2-mobilefirst-20260930`，分支 `codex/mobilefirst-account-components-20260930`，包含大量既有未提交改动；不得重置或整体提交。
- 打包的本地 Bot HTML 在模拟触屏 320、375、768px 下加载人设卡与文件记录后，页面、面板、人设网格及文件列表均无横向溢出；人设重抽/删除为 44px 触控区。
- 本轮 DOM build/smoke、Expo typecheck、iOS bundle（4771 modules）、前端类型基线（0 新诊断）、`git diff --check`、staged 文档影响检查通过；iOS 产物中 Bot HTML SHA-256 与源产物一致。
- 原生文档编辑在同一引用块或列表项内可合并段落并保留 marks；聚焦测试 21/21、Expo typecheck 与 iOS bundle（4771 modules）通过。
- Hermes 附件暂存改为从 Host 平台注入 SHA-256；Expo 用 `expo-crypto`，浏览器仍用 Web Crypto。附件聚焦测试 3/3、Hermes 插件与 Expo typecheck、iOS bundle（4771 modules）通过；真实 Host 发送未验收。
- 原生附件任务移入 Controller 持有的会话：失败后可重试，移除后迟到的 Host 结果会释放，切换 Draft 后任务仍回填原 Draft；会话聚焦测试 3/3。长重复文本的编辑定位改为线性扫描，结构化输入测试 22/22。三组聚焦测试合计 28/28、Expo typecheck 和 iOS bundle（4772 modules）通过。
- Bot/Host 聚焦门禁 32/32、字体生成一致性检查与平台边界检查通过；`git diff --check` 和 staged 文档影响检查通过。Quick Tunnel 的 iOS manifest 与 bundle 来源再次轻量核验通过，未下载完整 bundle。
- 与桌面 Composer 的 Host catalog 对照确认：原生工作区/权限控件已有共享目录接线，但 Hermes bridge 目前对 `project/list`、`permissionProfile/list` 返回空目录，LightVela Bot Chat 因而不展示这两项。没有伪造选项；该 Host 能力缺口已写入正式 Chat 架构和主 Task Pack。
- 对重复文本编辑定位的新旧算法作 240,000 个随机文本/选区差分检查，结果一致；聚焦长草稿测试仍通过。
- Quick Tunnel iOS manifest 和 bundle 来源通过轻量核验，未下载完整 bundle。预览地址 `exps://calgary-metropolitan-outputs-concepts.trycloudflare.com`。
- 用户完成当前监听的浏览器回调后，`expo whoami` 返回 `beordle`；Quick Tunnel iOS manifest 与 bundle 来源轻量核验通过，未下载完整 bundle。
- 从恢复草稿移除原生附件现在也调用 Host 清理回调；附件会话测试 4/4、Expo typecheck 和 `git diff --check` 通过。
- 原生段落格式可创建/切换引用与列表；简单列表项回车拆分、空项退出，保留 marks、列表项 ID 与选区。原生文档及附件测试 31/31、Expo typecheck、iOS bundle（4773 modules）通过。Quick Tunnel manifest 与 bundle 来源轻量核验通过，未下载完整 bundle；真机 Fabric 与键盘仍未验收。
- 输入事件现通过纯事务统一决定普通编辑、列表结构改写与受保护标记拒绝；Fabric 桥先保存原生 event count/text 后通知父层。原生文档、事务及附件测试 34/34、Expo typecheck、iOS bundle（4774 modules）和 `git diff --check` 通过；Quick Tunnel iOS manifest 与 bundle 来源轻量核验通过，未下载完整 bundle。设备行为仍待 iPhone 核对。
- 相邻顶层段落、简单引用和列表现可用一次选区切换块格式，保留 marks、列表项 ID 及未选块；选区结束于下一段开头时保持该段不变，跨 divider 或复杂嵌套结构也不修改文档。原生文档、事务及附件聚焦测试 38/38、Expo typecheck、iOS bundle（4774 modules）和 `git diff --check` 通过；实际 iOS 选区仍待验收。Expo CLI `whoami` 为 `beordle`，Quick Tunnel 轻量检查通过。
- 手机格式菜单增加共享文档中的代码块；只有纯文本能转换为代码块，已有代码块可转为其他简单块格式，语言属性在原格式再次选择时保留，回车继续留在代码块。原生文档、事务及附件聚焦测试 42/42、Expo typecheck、iOS bundle（4774 modules）和 `git diff --check` 通过；Quick Tunnel iOS manifest 与 bundle 来源轻量核验通过，未下载完整 bundle。实际 iOS 输入与选区仍待验收。
- 图片附件卡增加按 Draft 绑定的本地 URI 缩略图，切换 Draft 或移除附件后预览不串到别的输入区。原生文档、事务及附件聚焦测试 43/43、Expo typecheck、iOS bundle（4774 modules）和 `git diff --check` 通过；Quick Tunnel 清单与 bundle 来源轻量核验通过，未下载完整 bundle。真机显示和发送仍待验收。
- 人设卡的「人设解读」已从整卡选择按钮中拆出，触屏预览入口至少 44px 高；测试证明预览与选中是独立操作。前端组件测试 36/36、类型基线 0 新诊断、Bot DOM 构建与两种 smoke、Expo typecheck、iOS bundle（4774 modules）通过。Expo CLI `whoami` 再次确认为 `beordle`，本轮收到的旧 localhost 回调无需再兑换。
- 原生 Composer 的链接文字现在可局部编辑或格式化并保留 href 与子文本 marks；整条链接被普通文本替换时才移除目标。原生文档、文本事务、块格式及附件测试 44/44、Expo typecheck、iOS bundle（4774 modules）、`git diff --check` 和 Quick Tunnel 轻量核验通过；真实 Fabric 输入仍待验收。
- 原生选区新增链接编辑入口：按 Draft ID 固定选区，HTTP(S) 地址校验，键盘避让面板，保存/移除并保持行内 marks；链接在属性文本中可见。原生文档、文本事务、块格式及附件测试 46/46、Expo typecheck、iOS bundle（4775 modules）、`git diff --check` 与 Quick Tunnel 轻量核验通过；仍需 iPhone 选区、键盘、链接保存的真机反馈。
- Android 根布局已为共享 Chat 工具栏补上 HeroUI Native 样式与 Provider；Expo typecheck、Android bundle（4873 modules）、`git diff --check` 通过。iOS Quick Tunnel 清单与 bundle 来源轻量核验通过，未下载完整 bundle。
- 已应用自定义人设的状态行现能在手机宽度内换行，长名称断行，编辑/下载触控按钮至少 44px。组件测试 36/36、前端基线 0 新诊断、Bot DOM build 与双场景 smoke、iOS bundle（4775 modules）和 Quick Tunnel 轻量核验通过；iPhone 实际视觉待核对。
- 文件列表在手机窄屏改为单列，容量与修改时间放在文件名下方；桌面三列保持。文件夹进入按钮至少 44px。文件管理测试 32/32、前端基线 0 新诊断、Bot DOM build/双场景 smoke、iOS bundle（4775 modules）和 Quick Tunnel 轻量核验通过；真实 WKWebView 横向手势与长名称待核对。
- 原生附件草稿被清空时释放已暂存的 Host 文件，发送成功时保留文件供会话引用；切走后才完成暂存、或在切走后发送失败的缓存草稿，重置时也能清理。Composer 会通知缓存草稿的发送结算并暴露按 Draft ID 查询阶段。两个遗漏清理回归先红后绿，缓存发送成功保留文件另有回归；Composer/附件测试 31/31、Composer/Web/Expo typecheck、iOS bundle（4775 modules）和 `git diff --check` 通过。实际 Host 清理仍待真机验证。
- 总览服务卡的三列最小宽度在 320px 手机容器内超过可用宽度；共享 `HeroBanner` 改为窄屏两列，第三项单独一行，宽屏仍三列。总览测试 54/54、前端基线 0 新诊断、Bot DOM build/smoke、iOS bundle（4775 modules）通过；仍需 iPhone 实测。
- 原生列表首项开头退格可退出列表，保留格式、剩余列表及连续序号。此步聚焦测试 43/43、Expo typecheck、iOS bundle（4775 modules）、`git diff --check`、Quick Tunnel 轻量核验通过。Expo CLI `whoami` 为 `beordle`，旧 localhost 回调监听已结束；Expo Go 可点 Try Again。真实 iPhone 行为待反馈。
- 后续简单列表项开头退格可与上一项合并，保留 marks 与剩余列表 ID，并重新连续编号；复杂多段落项继续拒绝。聚焦测试 44/44、Expo typecheck、iOS bundle（4775 modules）、`git diff --check` 与 Quick Tunnel 轻量核验通过；真机光标反馈仍待核对。
- 当前打包 HTML 的 Chromium 窄屏复测覆盖 320/375/768px 已填人设卡、长文件名列表、文件重命名和新建文件夹态；页面及面板无横向溢出、无 JS 渲染异常。Expo CLI 再次确认为 `beordle`，当前 Quick Tunnel 的 iOS manifest 和 bundle 来源轻量核验通过；真实 iPhone 行为仍待使用者回报。
- 打包 DOM 的 15 个可见功能页已在 320/375px 模拟触屏下逐页测量，根文档与内容列均无横向溢出或渲染异常；离屏轮播卡和局部横向筛选不算整页横滑。原生引用块末尾的空段落现在可用第二次回车退出引用，保留已引用内容及 marks；聚焦测试 56/56、Expo typecheck 与 iOS bundle（4775 modules）通过，Fabric 真机回车与光标待核对。
- 附件发送途中销毁 Controller 不再提前删除已暂存的 Host 文件；异步发送接受后将其留给会话，失败或拒绝后清理。未发送草稿销毁时仍立即清理。常规发送和快捷建议发送均通知附件会话；附件测试 12/12、Expo typecheck 通过，真实 Host 发送待设备验收。
- 复核窄屏截图后把已填人设卡调整为容器不大于 360px 时单列、空卡保留双列，已填卡宽从约 126px 提升到 240px。Chromium 320/375/768px 触屏探针根与面板无横向溢出、无渲染异常，按钮保持 44px；Bot DOM build/smoke、前端类型基线 0 新诊断、iOS bundle（4775 modules）和资产 SHA-256 对齐通过。真机视觉仍未验收。
- 对照 RN 0.86.3 公共 TextInput 的卸载语义，iOS 属性文本适配器现于卸载时同步清理当前聚焦的原生 Host；Expo typecheck、iOS bundle（4775 modules）和 diff check 通过，真机键盘与会话切换仍待验收。
- Hermes 图片入口已按 Base64 尾部填充计算实际字节数，20 MiB iOS 上限不再被多算为超限；真实 20 MiB 测试从 Gateway 输入到 `prompt.submit` 通过，插件 typecheck 通过。普通文件 32 MiB 解码与摘要的内存峰值尚未评估。
- Hermes 普通文件暂存已将整份 `atob` 与整份重编码校验改为对齐分块解码加最终 quartet 校验，省去摘要前的一份全量拷贝；跨 1 MiB 边界暂存/重试与非规范 Base64 拒绝测试 4/4、插件 typecheck 通过。iPhone 实际峰值和 Host 上传仍待测量。
- 原生附件取消后仍等待已发出的 Host 暂存请求回复，再由附件会话释放迟到的文件引用，避免 RPC 本地取消导致远端孤儿文件。附件会话 12/12、Expo typecheck、iOS bundle（4775 modules）、文档校验与 diff check 通过；真实设备 Host 上传仍待核验。
- 原生 Composer 的撤销/重做不再是空操作：每次文本、格式、链接编辑和外部插入记录共享文档与光标，按 Draft 隔离且有容量上限；原生输入区按历史状态提供按钮。历史、文档与文本事务测试 36/36、Expo typecheck、iOS bundle（4776 modules）、文档校验与 diff check 通过；iPhone/iPad 实际选区回放待核验。
- 旧原生输入框迟到的文字、焦点、选区事件现受来源 Draft ID 约束，选区不会越过当前草稿文本；嵌套块投影测试覆盖 Emoji、链接、引用和有序列表的 UTF-16 长度一致性。文档/历史/事务测试 37/37、Expo typecheck、iOS bundle（4776 modules）通过；真机事件时序待核验。
- 新增 500–768px 窄容器断点探针：人设三列在 601px 使单卡缩到 162px，现两列延续到 740px，741px 三列仍约 209px；各宽度无根/面板横溢。文件夹触屏「进入」入口在 640px 以上不再被桌面断点隐藏，640/768/1024px 点击均进入目标路径，文件行不横溢。组件测试 68/68、前端基线 0 新诊断、Bot DOM build/smoke、iOS bundle（4776 modules）与打包资产哈希一致；本机无 WebKit，实际 WKWebView 仍待 iPhone 核验。

## unverified
- iPhone WKWebView 中带真实数据的人格、文件页呈现与按钮点击。
- iOS Fabric 富文本选区、中文输入法、附件选择及真实 Host 发送。
- 若 LightVela Bot Chat 需要可选工作区或权限，Hermes Host 须先提供真实 catalog 与执行语义；当前只是原生通用控件已接线。
- Expo Go 真机连接和实际界面呈现，CLI 侧已登录 `beordle`。

## discard
- 旧 Expo CLI 浏览器回调、端口与验证码；不能在新监听复用。
- 只加载空状态的人格/文件布局证据，已由带模拟记录的探针补充。

## restore
- 主 Task Pack：`docs/context/tasks/2026-10-02-opencraft-mobile-layout-composer.md`。
- 本轮新增改动：`opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/attachment-staging.ts` 的可注入摘要、桥和 transport 透传、Expo 三端 crypto 提供者；`native-attachment-session.ts` 的 Controller 级来源与任务所有权及原生重试入口；`native-composer-document.ts` 的线性选区定位；对应测试和架构记录。前轮移动布局和结构化输入改动仍在工作树。
- Expo CLI 登录已完成；继续前可用 `expo whoami` 复核，勿记录或输出回调码。

## next_action
让使用者用 iPhone Safari 打开明文 Expo Go 链接，对照 Task Pack 的布局、输入和附件验收项回报真机结果。
