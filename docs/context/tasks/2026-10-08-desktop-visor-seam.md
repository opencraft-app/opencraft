---
id: desktop-visor-seam
type: task
scope: 桌面控制底座圆弧与底座内侧覆盖。
triggers: ["desktop visor seam overlap"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/design/invariants.md"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs / non_goals
用户本会话批准“行 改吧”：只延伸圆弧内侧填充，不移动外曲线，降低紫色底座白线风险。
不提交、发布、替换预览或重启，不改变授权、动作或布局尺寸。

## history_context / interface_refs / context_receipt
Codex 26.930.31428/build12913 的 CloudAeonComputerPanel 也使用独立圆弧与底座遮罩；关键曲线/偏移一致，但不证明其iOS无接缝。
已读根/OpenCraft AGENTS（前序）、maintenance Skill与verification全文、desktop-view样式和desktop设计不变量。
Router `opencraft desktop visor seam overlap` 无匹配，有界搜索design-system与相关desktop tests；实际预览CSS为main-ChXs0pwk.css，未混读保留的其他版本CSS。

## affected_paths / acceptance / validation
共享desktop-view.web.scss、独立像素smoke、design/invariants。
窄屏左右及宽屏左圆弧内侧扩展；外曲线和位置不变。Chromium按DPR1/2/3与分数坐标验证左右外轮廓不变、普通渲染不恶化、模拟0.5px底座裁切时新增覆盖生效。
独立验收需显式浏览器工具路径；输出只在临时目录。不把模拟裁切当成真实Safari问题复现。

## evidence / risks / handoff
源码修改完成。左右遮罩盒内侧扩展1 CSS px，SVG外曲线坐标保持原位置；右侧因right锚点盒变宽而将SVG外曲线对应平移1单位，抵消盒原点移动。宽屏左曲线也单独处理。不平移整块圆弧、不改变控件/底座宽高与动效时间。
正常Chromium新旧无明显变化；初版要求正常渲染必须改善的断言失败，改为区分正常场景与人为0.5px边缘裁切容错场景，保留逐像素外轮廓和不恶化断言。
48组真实Chromium像素smoke通过：390/1024宽度、DPR1/2/3、4种分数坐标、普通/模拟裁切；左右外轮廓绿色通道差<=1，内部无恶化，裁切容错改善。证据 `/tmp/opencraft-visor-seam-bpew2m`；不是iPhone实际白线复现证据。
design-system类型检查、Web构建、44/44插件/主题聚焦回归、显式变更集合docs-impact与diff whitespace检查通过。
iPhone Safari截图仍需实际替换预览后验收；本轮未提交、替换预览或重启。与前一轮触控所有权修改并存，部署时需精准合入现有预览基线。
