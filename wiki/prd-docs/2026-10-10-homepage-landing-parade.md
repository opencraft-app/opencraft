# LightVela 玩偶落地与行走视频制作单

## 已确定的网页位置
国内与国际首页：四个首屏玩偶沿正文左侧落下，在「核心特征」结束与「可以做什么」开始之间落地；该区新增 260px 桌面舞台。移动端保留 150px 静态群像。不覆盖正文，不改文案。
网页实现落地、回弹、起身与三个朋友加入的占位分镜。真实翻身、爬起和迈腿由视频制作完成；不接受 PNG 整体上下弹跳冒充行走。

## 角色与资产（名称对应，不许变色/换配饰）
1. bean-lilac：紫色耳机、唱片。
2. round-coral：粉色巫师帽、披肩。
3. square-mint：薄荷方形身体、米白渔夫帽、书；第三个滑稽摔倒后爬起。
4. drop-sky：蓝色水滴、星星眼镜；扑倒后撑手爬起来。
5. cloud-butter：黄色、护目镜、围巾。
6. round-peach：粉色贝雷帽、相机。
7. bean-periwinkle：紫色针织帽。
assets 下七张同名图是角色身份参考，*-2.webp 是前四个下落姿势。
reference/footer-walk.mp4 是用户指定的行走品质参考：交替迈脚、重心转移、脚落地不滑、头顶球与配饰延迟摆动。

## 推荐制作：两个独立镜头，各不超过十秒
不是把同一个视频分成上下两排：上下分屏会降低角色分辨率，还容易发生动作/尺度不一致，后续裁掉一半也不能自然衔接。
A：5秒「落地与起身」。固定机位，无运镜，四个角色在画面左侧依次落地，另三位从左侧加入。0–1.2秒紫/粉先后柔软落地回弹；1.2–2.3秒薄荷屁股着地后侧翻，蓝色手脚撑地；2.3–3.8秒互相扶起；3.8–5秒七个角色整理成朝右的队列。喜剧表演，不疼痛、不伤害、不撞头。
B：10秒「朝右原地步行」。固定机位，七个同样的角色以右侧三分之二角度原地迈步，队形及大小固定。脚交替接地、手摆动，身体小幅重心起伏，天线球/帽子/围巾有跟随。不要整体横移；网页用 transform 将整队从左移到右，移动速度适配视口。
A最终帧作为B起始图，保留最终帧原文件；要求背景、光源、镜头高度、角色比例一致。B首尾脚步相位相同，可循环；不是倒放，不用 ping-pong 步态。
先做B确认行走，再做A匹配其起始帧，返工更少。

## 如果只想生成一次：10秒单镜头
0–3.8秒落地起身；3.8–4.5秒朋友加入；4.5–9.5秒向右原地步行；9.5–10秒正常持续迈步。全程固定机位。
交付原片及4.5秒处帧，可在该时间点切成两段；按动作停顿点切，不按画面上下切。若模型不能稳定处理七个角色，先出前四个，另外三个另片加入。

## 比例与画面
生成选16:9、1080p。所有角色位于画面中央横向带，脚在高度75%左右；天线/帽子完整；上下留白，左右留至少10%安全区。网站阶段将裁上下空白变成横条，不裁角色，不需要生成超宽比例。
首选可抠背景纯色版本，无纹理、无渐变、无地平线、无额外道具；同时交付带柔和地面阴影的白底预览。纯色绿色必须避免污染薄荷角色，优先由制作者根据角色调色选用不近似角色颜色的纯色底。
生成工具通常导出有底 MP4，不能把绿底文件直接当作透明视频；后期需抠像、检查轮廓及阴影，交付可透明播放的视频或逐帧序列。透明编码兼容性到接入时验证；也保留白底MP4供页面降级使用。
不要文字、Logo、声音、烟花、亮片、镜头推进、角色拉伸变形、换配饰、凭空多角色、裁脚、滑步、整体蹦跳代替迈腿。

## B 镜头提示词（可直接复制）
以上传的七张角色图为唯一身份参考，严格保留每个角色的色彩、身体轮廓、黑亮眼睛、头顶虹彩球和全部配饰。参考上传的页脚视频的真实迈腿动作与柔软3D材质。生成10秒16:9 1080p固定机位动画，七位角色以面朝右侧的三分之二角度原地步行。交替抬脚、脚掌接地、自然重心转移，短手轻摆，帽子、围巾、天线球略微滞后摆动；脚接地时不滑动，队形与整组中心固定，不整体横移、不整体跳跃。角色完整位于画面中央横向带，脚在画面高度75%，上下留白，左右各10%安全区。纯白#FFFFFF背景，柔和地面接触阴影，柔和一致的正面偏左照明，无运镜、无文字、无场景物件。最后一帧与第一帧的步态相位匹配，可无缝循环。不要变色、不要换配饰、不要多肢体、不要人物合并、不要截断头顶或脚。

## A 镜头提示词（可直接复制）
严格沿用七张角色图及B镜头起始帧的同一身份、比例、光源与固定机位。生成5秒16:9 1080p柔软3D喜剧动画：紫色耳机角色与粉色巫师帽角色从画面左上方依次落下，落地轻微压缩后回弹；薄荷渔夫帽角色屁股着地后侧翻，蓝色星星眼镜角色趴在地上用双手撑起。四位互相帮助站稳，黄色护目镜、粉色相机、紫色针织帽三个朋友从左侧加入，最后组成与B起始帧完全一致、朝右的队列。动作错开，不同时落地；友善、轻巧、有重量，无受伤、无痛苦、无撞头。纯色可抠背景，无文字、无额外道具、无镜头运动、人物和配饰不变形，天线球保留。以B起始帧作为本镜头最终帧。

## 交付验收
- 7个身份稳定，脚/配饰不丢；薄荷与蓝色反应不同。
- 真正迈腿，无滑步、无倒放步态；方向朝右，镜头固定。
- A终帧与B首帧可重合，B首尾能循环。
- 原始MP4、抠像版本/逐帧序列、A末帧/B首帧、时间切点和帧率。
- 网站默认静音、进入舞台才播放，离开视口暂停，减少动态效果用静态图。

## 实际上传顺序
先做B：上传assets里的七张无编号角色图，以及reference/footer-walk.mp4；选择16:9、1080p、10秒，粘贴B提示词。先发生成结果给网页开发核对，再做A。A上传七张角色图+B首帧，必要时再加一张square-mint-2.webp作为下落姿势参考，总图片数不超过9。网页落地后先静止等视频，现阶段不做PNG假行走。


## 2026-10-10 用户接受第三版落地视频后的接续

采用用户 video-0 (3).mp4 的 10 秒倒栽、翻滚与同伴扶起片段。抠除与画面边缘连通的黑底，保留封闭黑色眼睛，导出 VP9 Alpha WebM 与透明 WebP 尾帧。蓝色在网页下落末段转为 180° 倒栽，素材按其首帧位置对齐左侧落点；视频提前加载，解码未准备时保留原角色，防止加载空档。阶段空隙增至 380px，容纳同伴靠近动作，播放一次、离屏暂停、尾帧停留。此轮仅本地预览，尚无新三人入场素材。

顺序纠正：四个原角色均由网页完成下落，视频裁掉前 3 秒中原角色从侧面进入的镜头，仅接四个已经聚齐后的扶起段。视频结束再从侧面加入两个不同原版形象（cloud-butter、round-peach），当前入场是静态素材位移动画预览，尚非真实步态视频；新的多人行走片段仍待生成。

接入用户 video-0 (4).mp4：四个下落、扶起、另外两个加入均在素材内，使用完整 10.125 秒片段，移除图片模拟入场。抠绿导出 Alpha WebM，420px 视频框不变。首帧四人位置重对齐，蓝色倒栽方向不变。当前仅动作衔接预览，原片仍有书本造型变化、起始帽子裁切与部分绿边，不宣称最终角色一致性验收通过。

修复用户截图中双套角色同时出现：视频接管后 original cast 必须保持隐藏，直到反向滚动回到 .7 之前才复位，避免 .90—.92 区间视频和图片同时出现；下落位移在接管阈值 .92 到达终点。视频框 420→320px，下落终点可见尺寸同步校准，落地区 240px；静态视频调色为 brightness 1.2 / contrast .94 / saturate .9，减轻生成素材的深色光照。源素材仍有姿态与原画差别，不等于逐帧一致。

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

### 曲线玩偶定位修正（2026-10-11）

- 用户截图显示玩偶被曲线穿过。预览 DOM 证据：track 的 offsetTop 为 211px，而 getBoundingClientRect 包含入场 translateY(48px)。玩偶位置不跟随这项位移，导致入场中曲线压在身体上。
- 曲线与玩偶共用固定布局坐标，按 track offsetLeft/offsetTop/offsetWidth 计算脚部锚点；track 保留淡入但取消整体纵向位移。国内、国际与全部语言使用同一控制器与样式。
- 回归测试模拟带 48px 入场位移的矩形，确认定位仍使用布局坐标；27 项生成/定位测试与 20 项动效测试通过。
