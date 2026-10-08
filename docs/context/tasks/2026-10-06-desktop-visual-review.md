---
id: desktop-visual-review
type: task
scope: 对照用户截图、实际服务及固定原版Codex定位云桌面视觉差距。
triggers: ["desktop visual review", "云桌面视觉差距", "Codex desktop layout comparison"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/plugins/cloud-desktop/src/panel.web.scss", "opencraft/plugins/cloud-desktop/src/rfb.ts", "opencraft/docs/cloud-desktop-plugin.md"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_ids / requirement_refs / requirement_excerpt
unknown；用户给出当前云桌面截图，要求重新查看明显的UI差距。本轮只读分析，不实施新布局。

## non_goals
不提交、推送、部署、重启、改变远端桌面环境或输入授权；不操作真实远端；不把参考静态布局harness当成官方Codex运行结果。

## history_context / interface_refs / data_structure_refs
current_design_refs：cloud-desktop-plugin Panel presentation、platform-architecture residency、design/README。
relevant_evolution：上一轮控制光标已在本地验证，但未替换服务；现有UI smoke的media替身用width/height100% canvas，未覆盖真实noVNC等比画面的位置。
superseded_refs：结构一致、单独动画检查或测试通过不构成像素/真实画面视觉一致。

## context_receipt / scan_scope / affected_paths
读取根/OpenCraft AGENTS、maintenance Skill/verification、Task模板、design/README、桌面正式专题和相邻UI/RFB smoke/fixtures。Router命中frontend-product-surface，已读must_read frontend-service-detail；实际只触及opencraft，无frontend实现动作。adjacency/frontend-runtime-openspec-i18n已读并检查相邻真实renderer fixture/test。
有界精确查current panel/index/rfb/noVNC、Shell right-panel app.scss；固定/data/codex-new原版26.930.31428/build12913 README、panel-da547d640131.js及其直接import app-shared的Button/CSS。参考只读，不使用Wakaru复原组件作为运行真源。
本轮仅Task分析记录与临时浏览器诊断产物。

## evidence / decisions / risks / checkpoint / validation / handoff
已知：原版video object-contain，noVNC canvas margin:auto+autoscale；两者均可因比例留白，不能先贴顶/裁切冒充复刻。原版窗口text-sm override13px，我们body/control-panel14px。原版Button default px2/py0.5/text-sm/leading18，具体浏览器computed待测。
运行服务：80端口PID1469029，cwd指向独立disclosure-preview包，version build20261006-activity-disclosure-5d9c122c5；不是当前checkout刚构建的包。此观察不能确认用户截图的精确抓取时刻。
checkpoint：正在复用真实RFB smoke生成宽画面并测量，原版CSS/classes+合成video作为参考布局harness。内存模块探测先遇到ws CommonJS named export和data URL相对Playwright import问题；均为诊断loader问题，尚无几何结果，不归因产品。
checkpoint续：诊断loader两处已修；第三次探测1600x1000单包RAW画面导致连接结束，media ready等待失败。合成peer未报告协议错误，尚不能归因产品；正在核对已有wire消息大小上限并按真实流分片发送，不改变产品门禁。浏览器脚本位于/tmp/opencraft-desktop-visual-review-6X4P02/inspect.mjs。
resolved_diagnostic：wire既有单个binary消息上限为1MiB；合成peer改为512KiB分片后通过，未改变产品门禁。两处loader错误与该合成单包错误均不是视觉根因。
browser_receipt：/tmp/opencraft-desktop-input-mj5IuB，真实Panel/controller/noVNC且合成1600x1000 RFB；参考为原版app-shared CSS及实际panel类名的合成video布局harness，不执行官方应用。桌面pointer条件下，1280x1188两者toolbar均40高，画面均x0/y214/1280x800；720x480均x8/y40/704x440；390x700均x0/y248.125/390x243.75。此同条件实验未发现插件额外偏移，不证明用户截图时的Shell尺寸正确或iPhone实机等价。
confirmed_deltas：当前status为14px/20px/400，参考Electron CSS/classes computed为13px/18.5714px/430；control均24高、18px行高，但当前14px/400，参考13px/430。英文Take按钮当前126.11宽、参考harness96.02；当前主动预留Stop controlling最长文案槽，而原版随当前文案宽度且Stop control更短。宽度数值还受字体环境影响，不移作中文截图或官方Mac测量结论。当前有授权能力限定的Paste/手机Keyboard附加控件，原版该面板只有一个控制按钮。
media_scope：ctl/pkg/instance/desktop.go的默认启动为1440x900 Xvfb+startxfce4；Packages显式安装XFCE。截图壁纸、Applications条、图标及底部dock是远端画面，不归通用插件CSS。固定Codex原始Panel只有外部cloud-agent-desktop launcher入口，不能由本地renderer推断其远端OS主题。
validation_gap：旧UI smoke只以替身canvas width/height100%及720x480/320x480验按钮/动画，不含真实解码器16:10画面在近方形/纵向容器的对照。此次实验补齐诊断，不是已新增产品回归或整改。参考harness没有完整主题/字体资产，不能据截图比较颜色或声称官方像素复刻。
handoff：本轮分析完成；仅增加诊断Task及临时产物，未改变产品布局、输入、服务或参考文件。建议先校正DS状态/控制排版和实际文案尺寸策略，再将真实framebuffer比例与Shell尺寸纳入视觉验收；如要改变远端桌面外观，另走产品资源初始化边界，不用插件遮盖。用户截图没有可读的实际浏览器DOM/完整容器尺寸，留白是否额外超出fit仍不能单凭截图确认。maintenance Skill使结论按Shell/媒体布局/远端像素分层，未促成产品行为修改。
