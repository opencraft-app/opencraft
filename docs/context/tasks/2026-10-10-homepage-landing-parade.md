# 首页落地与队列动画

## goal
双站首页四个玩偶沿左侧空白下落，在核心特征与使用场景之间落地，并准备与页脚同质量的真实行走视频交接。

## non_goals
不发布、不修改路由与正文，不用整体弹跳冒充真实迈腿。

## requirement_refs
用户本轮截图与文字；wiki/prd-docs/2026-10-10-homepage-landing-parade.md。

## affected_paths
frontend/next-site/home-hero-artwork.ts、home-scroll-cast-loader.ts、home-mascot-landing.ts；共用 hermes-home.css。

## history_context
current_design_refs: frontend/DESIGN.md；基线 origin/master 3bc4384e53。旧设计保留 stash，当前分支 codex/homepage-redesign-20261010。

## context_receipt
- docs/context/domains/site-environment-routing.md：双站独立验收
- frontend/AGENTS.md、frontend/DESIGN.md：前端验证、位图及界面规则
- docs/context/project/adjacency/frontend-runtime-openspec-i18n.md、frontend/vitest.config.ts：相邻测试配置
- .agents/context/change-impact.json：本变更未命中映射架构路径
- animatorsSurvivalKit、fixing-motion-performance：区别化落地、有限播放与视口暂停

## acceptance
左侧下降不覆盖核心特征标题卡片；新增落地留白；四位不同落地反应，三位加入；减少动态与窄屏静态；卸载清理。视频尚未生成时不宣称真实行走已完成。

## validation
前端check、聚焦动画测试、双站构建及浏览器落地状态；视频交付后验证首尾相位与兼容性。

## checkpoint
stage: build；实现下坠左侧路线和落地占位，等待真实行走片段。unverified: 最新check、测试及视觉验证正在执行。restore: 唯一预览端口5184，视频制作包 /tmp/lightvela-mascot-video-kit。next_action: 检查左侧路线与起身状态。

## verified
- 2026-10-10：前端check通过，164 current / 171 baseline，0 new；原动画与首页播放测试30项通过；新舞台生命周期2项通过。
- Chrome1470px：核心特征标题左边界235px，四个下坠容器右边界分别213/205/197/189px；保持在内容左侧。落地后7位站定，真实迈腿待视频。截图 /tmp/lightvela-mascot-video-kit/landing-preview.png。
- git diff --check通过；制作包 /tmp/lightvela-mascot-video-kit.zip 已包含图片与页脚参考视频。

## unverified
- 国内优化构建正在 /tmp/lightvela-landing-build-cn.log 执行；国际构建尚未执行。
- 新真实行走片段尚未生成；不可宣称行走已完成或双站已发布。

## decisions
- 根据最新用户反馈，左侧滑落后垂直下降，不在落地前横向拐入正文。
- 用户指定页脚视频的真实迈腿质量，撤掉PNG跳动/滑行；落地起身后停住。推荐先生成10秒固定机位原地朝右迈步，后续网页控制横移。


## 2026-10-10 用户接受第三版落地视频后的接续

采用用户 video-0 (3).mp4 的 10 秒倒栽、翻滚与同伴扶起片段。抠除与画面边缘连通的黑底，保留封闭黑色眼睛，导出 VP9 Alpha WebM 与透明 WebP 尾帧。蓝色在网页下落末段转为 180° 倒栽，素材按其首帧位置对齐左侧落点；视频提前加载，解码未准备时保留原角色，防止加载空档。阶段空隙增至 380px，容纳同伴靠近动作，播放一次、离屏暂停、尾帧停留。此轮仅本地预览，尚无新三人入场素材。

用户反馈视频玩偶过大、颜色偏深：视频框 640→420px；落地区 380→280px；下落末段同步缩小 30%，蓝色倒栽落点按 420px 素材首帧重新对齐；视频与尾帧亮度 1.12、饱和度 .94。loadeddata 触发重新计算，避免快速滚动时解码准备后不接续。

顺序纠正：四个原角色均由网页完成下落，视频裁掉前 3 秒中原角色从侧面进入的镜头，仅接四个已经聚齐后的扶起段。视频结束再从侧面加入两个不同原版形象（cloud-butter、round-peach），当前入场是静态素材位移动画预览，尚非真实步态视频；新的多人行走片段仍待生成。

### 本轮交接检查点
32 个聚焦测试通过；最新类型检查 164 current / 171 baseline / 0 new；pnpm check 通过（47 个既有翻译告警）。国内站 build 已通过，随后顺序修正以聚焦测试和类型检查复核；国际站构建尚未重跑。本地 Chrome 已确认透明播放、扶起后才出现两个新增形象，比例缩小至 420px 视频框。当前预览通过裁掉视频开头 3 秒避免同伴重复入场，因此蓝色视频翻滚镜头暂未保留；网页下落仍为倒栽姿态。后续正确翻滚视频需要与四人同时下落的首尾位置匹配。未提交、推送或部署。

接入用户 video-0 (4).mp4：四个下落、扶起、另外两个加入均在素材内，使用完整 10.125 秒片段，移除图片模拟入场。抠绿导出 Alpha WebM，420px 视频框不变。首帧四人位置重对齐，蓝色倒栽方向不变。当前仅动作衔接预览，原片仍有书本造型变化、起始帽子裁切与部分绿边，不宣称最终角色一致性验收通过。

### 新素材试放检查点
完整六人视频已在本地 Chrome 播放到尾帧；旧模拟入场节点为 0；420px 视频框、当前左侧 65px 安全距离。最新类型检查 164 current / 171 baseline / 0 new；32 项聚焦测试已通过，最终落点调整后再次复核。本轮未重新执行双站生产构建，也未提交或发布；用于用户确认素材与衔接。

修复用户截图中双套角色同时出现：视频接管后 original cast 必须保持隐藏，直到反向滚动回到 .7 之前才复位，避免 .90—.92 区间视频和图片同时出现；下落位移在接管阈值 .92 到达终点。视频框 420→320px，下落终点可见尺寸同步校准，落地区 240px；静态视频调色为 brightness 1.2 / contrast .94 / saturate .9，减轻生成素材的深色光照。源素材仍有姿态与原画差别，不等于逐帧一致。

### 接续修复验证检查点
Chrome 在 scrollY 1673 和 1748 验证 video state=playing 且 visibleImages=0；视频 320px，亮度 1.2/对比 .94/饱和 .9。最新类型检查无新增错误；新增接管区反向滚动回归测试覆盖 .93→.91→.89→.74 保持图片隐藏、.69 复位。先沿左空白下落，到最后 8% 再展开对齐视频，减少功能卡片遮挡。生成素材首帧帽子裁切和原画姿态不同仍属于素材限制；未重新发布或构建双站正式包。

### 2026-10-10 角色颜色校正
- 对照原版 hero-poses 的浅紫、薄荷绿、浅粉与浅蓝，使用连续 HSV 校正视频阴影与薄荷色相，保留黑眼睛和米白配饰。
- 调色写入透明 WebM 和静态 WebP，移除全局 CSS 提亮滤镜，更新资源名避免旧缓存。
- 清除角色之间残留的绿幕，保留小面积身体阴影；视频本身的造型误差不能靠调色完全消除。

### 2026-10-10 对齐下落玩偶尺寸
- 视频画布由 320px 调到 480px，扩大单角色可见尺寸；桌面跑道从 240px 到 320px 留出角色空间。
- 取消下落过程 40% 缩小，同步视频首帧角色落点，保持原版下落素材尺寸。手机维持 320px 适配，颜色资源不变。
- 颜色以用户下落截图为主，再减轻身体下部阴影及饱和度；替换为 v4-soft 资源，保留黑眼睛和米白配饰。尺寸调整后 33 项动画测试通过。

### 2026-10-10 左移并缓和落点对齐
- 视频与网页落点统一左移 80px，最左不超过页面边缘。
- 横向对齐由最后 8% 改为下落 20%–80% 内渐变完成，避免临近切换突然向右跳。

### 2026-10-10 玩偶经过模块后方
- 核心特征模块提升到玩偶层前方，标题有白底遮挡；保留侧边留白区域让玩偶可见，不遮盖卡片文字与图示。

### 2026-10-10 收窄遮挡范围
- 根据用户纠正，撤掉 about 整个区域的前景层；仅标题实际文字范围、图卡在玩偶前方。板块上下留白与卡片间隙透明，不裁掉经过的玩偶。

### 2026-10-10 修复视频抠像边缘
- 收窄绿幕色相范围，避免把薄荷身体阴影识别为背景；只修补微小封闭缺口，保留角色之间间隙。
- 用轻微收边、柔化、边缘去绿及近邻内部颜色修复轮廓；透明视频改为 CRF24 编码，降低轮廓压缩损失。
- 新资源 v4-edge 仅调整视频抠像，不改颜色、大小、落点和遮挡逻辑。视频原始绿幕反光仍可能留下细微色偏，不能宣称与原图逐像素一致。

### 2026-10-10 撤回过强边缘修复
- 用户指出 v4-edge 脚底碎块与轮廓异常。撤掉侵蚀收边和内部颜色外推，改用前景/背景分布分割，明确保护薄荷脚部阴影，保留自然抗锯齿。
- 先对原片第24帧翻滚、第216帧六人站定检查，脚和身体均完整；重新生成 v4-clean 视频中。
- 整段243帧导出完成，检查第24帧与216帧未再出现脚部缺口和碎块；视频生命周期2项测试通过。当前仅本地预览，保留微弱源视频绿幕反光限制。

### 2026-10-10 站在使用场景标题上
- 舞台视频按 scenes__title 实际位置居中，脚底对齐标题上沿，取消原来的左侧悬空落点。下落终点读取实际视频框位置，响应式重新对齐。

### 2026-10-10 玻璃标题底板
- 用户要求标题后加入玻璃质感；标题添加局部半透明磨砂底板、细上沿和轻阴影，玩偶脚底贴着底板上沿。
- 提升落地媒体层级，避免白色标题区域遮挡身体；静态资源版本更新为 glass-perch-v119，避免旧 CSS 缓存。
- Chrome 本地预览确认完整身体可见且标题清晰；截图 /tmp/lightvela-video-review/glass-title.png。局部动画回归 33 项通过，git diff --check 通过。
- 仅本地预览，未提交、推送或发布。

### 玻璃台沿与间距修订
- 用户选择方案 1：移除标题玻璃背景，改为媒体脚下 10px 薄玻璃台沿，标题独立位于其下约 22px。
- 落地区高度桌面 320→150px、窄屏 180→110px，缩小额外外边距，收紧上一板块到玩偶的空白。
- 本地浏览器截图核对完整身体、独立标题和板块间距；证据 /tmp/lightvela-video-review/glass-ledge.png。33 项局部回归通过，git diff --check 通过。

### 2026-10-10 四人视频边缘精修
- 保留前 109 帧（4.542 秒），使用源视频重新处理透明轮廓，删除独立绿幕碎片，收紧边缘并以内部前景色补偿轮廓染色。
- 替换为 mascot-four-landing-v6-refined.webm 及对应停帧；保留现有浅灰椭圆地面和标题布局。
- 核对第 24、108 帧与本地页面，截图 /tmp/lightvela-video-review/matte-refined-page.png；播放器测试通过，透明通道与时长已检查。
- 当前原始素材的细小轮廓锯齿仍受源视频质量限制；未提交或发布。

### 首屏入场节奏精简
- 用户澄清优化对象是分批入场效果；撤销误解导致的排版 CSS，恢复原布局。
- 逐字模糊、角色词延迟、按钮和平台分批入场取消；主标题整体淡入 0.4 秒，演示区 0.1 秒延迟 + 0.35 秒淡入。首屏辅助元素不再等待 hero-sequence-ready 才可见。
- 浏览器计算样式确认副标题/按钮/平台 animation=none、主标题 0.4s、演示区 0.35s/0.1s；截图 /tmp/lightvela-video-review/fast-hero-entrance.png。

### 2026-10-10 首屏与滚动优化
- context_receipt：frontend 服务 pack、identity-access pack、frontend/AGENTS.md、frontend/DESIGN.md、frontend-runtime-openspec-i18n 邻接卡及头像/首页相邻测试。
- 国际版取消重复 GSAP 首屏序列，保留 CSS 三组短入场；卡片缩短入场并一次性读取位置。落地视频按帧判断可见性，滚动不再反复写定位。
- 中文丝带玩偶靠近文字，语言选择器不等待登录状态；保留真实权益门禁。取消导航分隔线与核心特征标题白底。
- 停稳悬停提供 700ms 有限轻点头反馈。真实挥手未实现：现有视频无独立手臂，需要相同站定构图的挥手片段或分层素材。
- checkpoint: verify；最新 check、聚焦测试与浏览器验收进行中。唯一端口 5184，未提交发布。

### 首屏轮流招呼验收
复用已有 hero-poses wave 帧，四位从左到右自动各挥手 1.45 秒，间隔 0.15 秒，只播放一轮。离屏/减少动态不触发，卸载清理计时器。相关回归 62 项通过，check 0 新类型错误，国内构建通过；截图 /tmp/lightvela-video-review/smooth-hero.png。站定视频悬停目前仅轻点头，真实挥手待独立素材。

### 2026-10-10 标题动画造成落点错位
用户截图仍有标题与脚部重叠：落点读取 heading 动画期间的视觉 rect，结束后标题回到原位，视频留在错误坐标。改用 offsetParent 的布局纵坐标，留 8px 全画幅安全间隔；测试覆盖标题平移前后位置不变。截图明确的长横线是 plays 的 border-top，本次去掉该线。此前去掉导航线不是这条线。checkpoint: verify；待最新回归与浏览器截图。

### 2026-10-11 步骤玩偶和孤字换行
用户确认刷新截图问题是左侧步骤玩偶位置。为未就绪的步定位变量添加模块内 CSS 回退，懒加载图 load 和 deploy/track ResizeObserver 重新定位，卸载清理。中文 play__list 末尾四字 nowrap，与 text-wrap:pretty 配合防孤字，不改原文。浏览器落地标题完整媒体间距 8px、plays 横线为 0px。checkpoint: verify；聚焦播放器回归35项、类型0新增，JS生命周期回归进行中。

## 2026-10-11 MR delivery checkpoint
- User authorized commit, push, MR and domestic/international branch previews; all locales included.
- context_receipt: docs/context/domains/release-gitops.md; docs/context/flows/tapd-gongfeng-delivery.md; .agents/skills/product-skills/lv-vibe-coding/SKILL.md; .agents/skills/gongfeng/SKILL.md.
- Final assets: mascot-four-landing-v6-refined.webm and its WebP still. Historical drafts remain local.
- 81 focused Vitest tests and 27 Node generator tests passed. pnpm check passed (164 current, 171 baseline, 0 new). Domestic build and OpenCraft 136-file sync check passed.
- Full pnpm test encountered cross-module timeouts and Node test collection incompatibility; stopped to release resources. Full suite is not verified green.
- Browser evidence: 8px heading/frame gap, plays separator 0px, Chinese final phrase kept together. Step mascot to be reviewed in branch preview.
- Limitation: landing hover uses group feedback; a real wave needs independent assets. Hero sequential greetings use existing wave frames.

## 2026-10-11 Review and delivery checkpoint
- MR: https://git.woa.com/wisp/mono2/merge_requests/5181; target master; branch frontsandbox/homepage-mascot-polish-20261011.
- Latest master merged. Required dialog preserved; only additional-creation form can dismiss; tests cover 1, 2 and 4 existing Bots.
- AI review fixes: guard cached Map lookups, optional clone-source count, centralized LANDING_STATE constants.
- After fixes: 83 focused Vitest passed; typecheck 164 current, 171 baseline, 0 new, 7 resolved. Node generator 27 passed.
- Global build passed after clearing Next cache; 1562 static HTML files, 58 public routes verified. CN build passed earlier.
- Branch preview pipeline p-9a3eeb676e0a4b0bacd778af7e39a952 triggered by authorized push; publication pending latest revision.
