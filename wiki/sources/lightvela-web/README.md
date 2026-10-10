# LightVela 汇报前端

## 源码归档说明（mono2 / wiki/sources/lightvela-web）

| 项目 | 说明 |
| --- | --- |
| 归档位置 | `mono2` 仓库 `wiki/sources/lightvela-web/`（master 分支） |
| 当前快照 | `LightVela_前端项目源码_33页_20261010.zip`（2026-10-10 导出，33 页正文 / 16 份参考 / 61 条路由） |
| 历史快照 | `LightVela_前端项目源码_31页_20261010.zip`（同日早些时候，31 页正文 / 14 份参考 / 57 条路由） |
| 内容 | 含 `sources/deck` 原稿 XML、`scripts/import_deck.py` 转换器、Cloudflare 密码保护 Worker、全部图文与演示视频 |
| 状态 | 仅源码归档与本地预览；**不部署**。线上 Cloudflare Pages 仍为此前 21 页版本 |
| 迭代方式 | 直接改本目录源码 → 提交到仓库 → 本地预览刷新查看，不改动其他子服务 |

### 启动本地预览（本机 macOS）

```bash
cd wiki/sources/lightvela-web
export PATH="/Users/junweicao/.workbuddy/binaries/node/versions/22.22.2-2/bin:$PATH"
corepack pnpm install --frozen-lockfile --node-linker=hoisted   # 本机沙箱禁止 symlink，必须加 --node-linker=hoisted
corepack pnpm dev --host 127.0.0.1 --port 5174 --strictPort
open http://127.0.0.1:5174
```

排障：

- `ERR_PNPM_..._BROKER_DENY`（建 symlink 被拒）→ 用上面的 `--node-linker=hoisted`。
- `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（vite 清理 `node_modules/.vite` 被守卫拦下）→ `mv node_modules/.vite /tmp/` 后重启。
- 端口 5173 常被其他会话占用，固定用 5174。

### 改动记录

| 日期 | 改动 |
| --- | --- |
| 2026-10-10 | 首次归档：导入 31 页源码快照，未改动页面内容与版式 |
| 2026-10-10 | 更新为 33 页快照：新增「国内站用户画像」（profile01，含开通套餐用户画像两张图）与「核数规模情景估算」（capacity01，附假设参考 capacity-assumptions）；参考由 14 份增至 16 份，路由 61 条；同步新增 capacity/profile 两组回归测试 |

---

React 19 + TypeScript 5.9 + Vite 7。从原24页PowerPoint转换为原生HTML文案、表格、SVG数据图与独立图片；当前按已确认方案整理为33页正文与16份可展开参考，包含三页出圈回顾、四页个人助理洞察、一页定位与差异、一页移动App路线、一页泛开发者场景选择及三页产品演进、完整8页基础设施动画、官网新视觉进展与原演示视频，以及两站注册到Pass转化对比和国内站用户画像与末尾核数规模情景估算，不以整页截图替代内容。项目已接入Manus版本管理与Cloudflare Pages服务端密码保护部署。

**当前版本：本地33页，线上仍为第五项21页版本。后续所有修改完成并获统一确认后再部署；本轮未推送远端或更新Cloudflare。**

## 本地运行

要求 Node.js 22.12 或更高版本、Python 3（仅重新导入时需要）。

```bash
npm install -g pnpm@9.15.9
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1 --port 5173 --strictPort
```

本机打开 `http://127.0.0.1:5173`。端口由启动命令选择；与 Manus 预览一起使用时，应与该会话的预览声明保持一致。

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm preview --host 127.0.0.1 --port 5173 --strictPort
```

`dist/` 是本机编辑预览所用的普通静态构建，不含访问控制，**不得将它直接发布为本次受保护站点**。Cloudflare 部署必须使用 `pnpm build:pages` 生成的 `cloudflare-dist/`，其中包含接管所有请求的 Worker 和全路径路由规则。构建不需要密码或 API Token。

## 如何修改

| 位置 | 职责 |
| --- | --- |
| `src/data/content.json` | 每个独立文案、表格单元格、图表数值和图片地址。修改内容不影响坐标 |
| `src/data/layouts.json` | 33页正文标题、顺序，以及各元素的位置、宽高、字号、样式与内容引用 |
| `src/data/supplements.json` | 传播、产品洞察、产品现状、产品演进与核数估算五组资料，含完整表格、产品路径、能力、架构与体验截图，不计入正文页数 |
| `src/data/theme.json` | 品牌色、背景色、字体角色与 1280 × 720 基准画布 |
| `src/components/SlideCanvas.tsx` | 页面元素的统一渲染机制 |
| `src/components/DynamicSlide.tsx` | 原HTML动画的隔离画布、有限导航通信与离页清理 |
| `src/data/infra-template.html` | 白底适配后的8页动态模板，由构建器生成 |
| `sources/infra/` | 用户完整原HTML与来源校验元数据 |
| `scripts/build_infra.py` | 白底语义换色及演示导航适配，可重新生成动画模板 |
| `src/components/RichText.tsx` | 原生富文本和目录跳转链接 |
| `src/components/DataTable.tsx` | 表格渲染与行列配置 |
| `src/components/BarChart.tsx` | SVG 数据图，读取原始类别与数值 |
| `src/components/Sidebar.tsx` | 完整目录与标题搜索 |
| `src/components/SupplementPanel.tsx` | 展开、切换补充材料，保持原图查看与返回正文 |
| `src/App.tsx` | 演示状态、全屏、翻页、总览、原图查看与视频弹窗 |
| `src/styles/slide.css` | 页面内的共享样式 |
| `src/styles/app.css` | 外部工作区、导航和响应式布局 |
| `public/assets/` | 自包含的原始图文、官网真实截图、演示视频与品牌角色，不依赖本机绝对路径 |
| `sources/deck/` | 当前逐页XML来源与manifest.json；清单决定正文顺序及补充材料 |
| `sources/supplements/` | 保留的完整传播背景/时间线、原友商比较、历史规模、国内站画像与核数假设XML |
| `scripts/import_deck.py` | 标准库转换器，将 XML 转成内容/布局/主题 JSON |

**修改单页内容：**先在`layouts.json`或`supplements.json`找到稳定ID（s01–s24、insight01–insight04、evo01–evo03、app01、profile01、focus01、capacity01、visual01及infra00–infra07），定位元素的contentKey，再去content.json修改对应文字、children、图片src或图表series.values。Muse图表的series.percentages保留原文占比，label-width/value-width控制长标签区域。需要更换图片时放入public/assets并更新/assets/文件名。

**修改版式：**直接调整对应元素的 `x / y / width / height` 和字号，或改共享渲染组件。页面仍使用 16:9 基准坐标，显示时通过 `ResizeObserver` 等比缩放，不因屏幕变化重新排版。小屏幕建议横屏或全屏，以保证密集数据页可读。

**新增/移动页面：**调整sources/deck/manifest.json的pages列表并运行导入，再更新src/deck.ts的章节范围。导入器生成number、页脚和路由声明。原页面ID保持稳定，显示序号随正文位置变化；s04/s05保留为传播补充，s22/s23为洞察详细参考，s09/s10为产品现状参考，原比较表使用product-comparison；s15位于产品现状开头，s08之后接focus01场景选择；evo01/evo02为第20–21页，infra00–infra07为第22–29页，evo03为第30页，原s16–s20完整保留为演进参考。insight01–insight04为第6–9页，产品现状第10–19页；s15定位后接app01移动App路线，再接visual01新视觉与原视频，再接s11注册/Pass、profile01画像与s12–s14三页使用数据，随后s08阶段判断和focus01场景选择。目录、导航页数和进度条均从当前数组读取。

**重新导入：**更新`sources/deck/*.xml`或清单后运行`pnpm import:deck`。该操作覆盖内容、正文、补充材料、主题四份JSON及路由声明；直接编辑过的数据先保存版本。图片可用original-src指定摘图对应的完整原图，渲染点击后打开原图。转换器支持原稿使用的文字、矩形/椭圆/线、图片、视频、表格、横向柱状图及本项目dynamic节点，并非任意PowerPoint文件的通用解析器。

**维护新视觉素材：** `sources/deck/visual01.xml` 的 `video` 节点指定 `src`、`poster`、`title` 与 `duration`。视频播放器位于 `src/components/VideoPlayer.tsx`；官网当前国际首屏与中文演示分开标注。完整原视频在 `/assets/lightvela-homepage-visual-demo.mp4`，不要以无保护CDN替代。

**维护App产品路线：** `sources/deck/app01.xml` 独占第11页，三项理由说明移动端优先，页底区分现有Web/IM、优先App和按需桌面。App未标为已上线，不补造排期、权限覆盖或获客改善。上一轮泛开发者与硬件能力重点不变。

**维护场景选择：** `sources/deck/focus01.xml` 独占第19页，先说明泛开发者选择理由，再列云端应用、多Agent协作、开放/设备接入三类任务；已有、实验与探索分开，数据不能推导职业分布。原演进三页建设方案保持不变。

**维护注册与Pass转化：** `sources/deck/s11.xml` 为第13页，国内累计注册89,122、开通/领取Pass25,218（28.3%）；国际累计注册17,807、开通/领取Pass14,036（78.8%）。两条同尺度100%基准只比较开通率。包含免费领取，与付费转化、生效套餐用户口径不同；实名流失按团队当前观察呈现，尚无分步漏斗归因，不将50.5个百分点差距全部归因于实名。原3.76万、3.53万、1.48万和39.4%整页保留在`sources/supplements/historical-scale.xml`，入口为`/#/supplements/historical-scale`；旧数字不按新注册分母重算，最新统计不补造截止日期。

**维护国内站用户画像：** `sources/deck/profile01.xml` 为第14页，位于s11注册/Pass之后。标题“国内站用户画像”，右侧“开通套餐的用户画像”；33,201个实名账号、平均33.5岁、中位数33岁、登记男性85.3%/女性14.7%，套餐开通20,593个、近7日使用7,634个、整体37.1%。只客观展示数据，不加评价、行动建议或职业/因果推断。原生图表保留9年龄段顺序；BarChart支持多series、axis-suffix、tick-count和value-position=fixed，单序列默认行为保持原样。完整核对表、D7分母与两张未改动原图在`sources/supplements/domestic-profile.xml`，入口`/#/supplements/domestic-profile`，关闭返回画像页。样本为已实名且收费Pass订单已开通，含优惠、未核验实付退款；使用含自动任务，D7仅纳入观察期已满账号。与前页25,218统计条件不同，不相除推导付费率，不按舍入D7百分比反推精确人数。

**维护核数规模估算：** `sources/deck/capacity01.xml` 为第32页，位于增长运营之后、封底之前；2026年两站合计32.4–33.1万核、2027年65.5–91.3万核，注册与核数分行。完整假设在`sources/supplements/capacity-assumptions.xml`，链接`/#/supplements/capacity-assumptions`；当前创建事件6.5/3.4万核与成功创建用户5.0/2.6万核为两种估算口径，不等同实际在用或峰值并发。预测为用户给定情景，底层系数未独立复算，国际站按同等注册规模需求更高表述。封底第33页，15份原参考与全部8页动画不变。

**维护基础设施动画：** 用户原HTML完整保留在 `sources/infra/agent-stability-original.html`，8页含子段落封面，原文实测、目标和研究设计标签未改。`pnpm build:infra` 重建白底模板，`pnpm import:deck` 同时重建模板和文稿JSON。页面ID infra00–infra07 仅选择原HTML的第0–7页；不拆分或重写原ACTS动画时序，CSS颜色与导航桥接在 `scripts/build_infra.py` 中维护。正文 iframe 仅允许脚本、禁用同源权限和外部网络；R重播、M自动/手动、N下一段，幕标签跳转仍在原播放器内。离开时卸载/停止；总览仅呈现静态终态。原素材包含的状态图标保留，不另加品牌角色。

## 演示操作

左右方向键、空格、PageUp/PageDown翻页；Home/End跳到首页/封底；F全屏；C目录；G总览；?查看快捷键。输入搜索内容时不触发翻页。第3–5页的“补充材料”打开传播资料，第6–9页的“详细参考”打开市场及能力附录，第10–19页的“详细参考”打开产品路径、配置/实验室、友商比较、历史规模与画像数据，第20–30页的“详细参考”打开原架构、完整场景、身份、接口和体验，第32页提供核数估算的完整增长假设，第33页为封底；五个参考分组分别展示。旧/#/s04、/#/s05、/#/s22、/#/s23、/#/s09、/#/s10及/#/s16–s20链接兼容对应材料；新链接为/#/supplements/材料ID。截图可放大，关闭原图返回材料，再关闭返回正文。第12页点击视频封面打开完整37.8秒中文新视觉演示；手动播放/暂停、拖动与原生全屏，不自动播放，Esc/关闭/导航会停止播放；播放器内方向键与空格不触发演示翻页。

## 保留的要求与数据边界

白色主调、LightVela紫色点缀。新品牌形象只在封面、目录和封底小面积出现（第1、2、33页，稳定ID为s01/s02/s24），visual01中仅展示真实官网/演示自带形象，不额外添加正文装饰角色。出圈回顾按“三项动作→媒体扩散→增长结果”压缩，邀请积分保留“原计划同步上线”口径，不强调单篇2万或10万阅读量。洞察中的4–5月上线与个人助理定位据用户补充，海外日期、837条Muse案例和Hermes判断沿用原文，不补造用户画像或因果贡献，不将底层分数当产品表现。定位页强调定制化、Web/IM配合和独立多Bot，自动协同留在演进。演进聚焦泛开发者，应用/协作/硬件同级，多云降为参考，亮点为多Bot/云电脑/硬件，官网首版新视觉作为现状展示，演进体验为拟人化/主动性/后续产品内交互视觉更新，现有与探索区分。原始数据与场景占比未重算。原文Meta Muse架构图仍标为参考，原始Markdown与PowerPoint文件未修改。

本项目是前端演示和源码维护工作区，**没有新增在线文案编辑器或多人同步系统**。内容通过源码维护。字体与图片随项目打包，运行时不发送内容给外部 AI。

Manus 自动发布保持关闭。Cloudflare 通过独立服务端密码保护提供访问；“内部演示”提示不代替认证。共享密码可由持有者转发，不提供逐人审计或撤销，后续如需个人权限建议改为 Cloudflare Access。

基础设施第22–29页保持动态；方向键翻整页，不推进段落。自动模式播放本页全部流程；手动模式可点画面或下一段，R重播、M切换、N推进；方案一两幕、方案二三幕可点击。全屏仍是整个文稿，不单独放大iframe。

## Cloudflare 受保护部署

运行 `pnpm test:auth` 检查服务端保护，`pnpm build:pages` 生成独立部署目录。`cloudflare/worker.mjs` 使用 Web Crypto 校验 PBKDF2 密码哈希和 HMAC 签名会话，Cookie 有效期 8 小时，设置 HttpOnly、Secure、SameSite=None，绑定当前域名。`cloudflare/routes.json` 必须保持所有路径包含且无排除项，静态素材不能绕过 Worker。

Cloudflare 正式和预览环境都需要 Secret `REPORT_PASSWORD_HASH`、`REPORT_SESSION_SECRET`，并设置 `fail_open:false`。Secret 缺失或校验异常返回 503，不提供静态素材。返回内容使用 private/no-store。登录带同源与 CSRF 校验，错误尝试限制是每个 Worker isolate 的最佳努力限制，不能替代全局 WAF。

部署命令：`wrangler pages deploy cloudflare-dist --project-name lightvela-report-202610 --branch main`。仅通过环境变量提供 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；不要把它们写入源码。正式地址、部署专用地址和预览地址均需登录。密码文件独立交付，不存入本仓库。

本机 `pnpm dev` 是授权编辑工作区，不模拟 Cloudflare 登录；服务器保护测试使用 Node 原生测试和实际云端验证。成功登录后的下载、截屏无法撤销，结束查看时可点“退出登录”。修改密码哈希或签名密钥将使现有会话失效，需重新部署后生效于对应版本。
