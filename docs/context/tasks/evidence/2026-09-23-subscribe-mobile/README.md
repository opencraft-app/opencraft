---
id: subscribe-mobile-visual-evidence-2026-09-23
type: document
scope: 订阅页移动端与桌面回归的可复核视觉证据。
triggers: ["subscribe screenshots", "订阅页视觉证据", "套餐响应式回归"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - frontend/next-site/subscribe-page.tsx
  - docs/context/tasks/evidence/2026-09-23-subscribe-mobile/after.json
status: active
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 1.0.0
precedence: task
derived: false
---

# 订阅页响应式评审证据

2026-09-23，本地 Chromium 145.0.7632.6（Playwright）、DPR 1；国内预览与国际预览分别构建运行。基线订阅源码为 `870d03dcb`，当前分支已合入 `ac1735ca0`，两者之间订阅页、共享 Card 和 DESIGN.md 无变化。

当前页面只有启航和巡游两档；本次没有新增套餐。所有图片和测量 JSON 随 MR 提交，可直接在工蜂中查看。截图等待入场动效结束后获取。

## 手机前后对照（390px）

| 修改前 | 修改后 |
| --- | --- |
| ![双列挤压](before-390.png) | ![手机单列](after-390.png) |

修改后 320 / 375 / 390 / 430px 均为单列；768 / 1024 / 1440px 均为双列，无页面或卡片横向溢出。测量包含卡片矩形、圆角、阴影及 overflow 状态，详见 [after.json](after.json)。

| 320px | 375px | 430px | 768px | 1024px | 1440px |
| --- | --- | --- | --- | --- | --- |
| [截图](after-320.png) | [截图](after-375.png) | [截图](after-430.png) | [截图](after-768.png) | [截图](after-1024.png) | [截图](after-1440.png) |

## 最新要求：屏蔽剩余名额

用户追加要求：无论是否登录或后端返回多少库存，都不展示“今日剩余 x/y 份”。已移除渲染和专用展示字段；后端销售状态仍负责售罄与订阅按钮禁用。

以下截图同样在本地把 available_count 临时设为 5、total_count 为 100，页面均未出现名额提示，截图后恢复数据：

| 390px | 1024px | 1440px |
| --- | --- | --- |
| [截图](quota-hidden-390.png) | [截图](quota-hidden-1024.png) | [截图](quota-hidden-1440.png) |

[测量结果](quota-hidden.json)：quota 数组全部为空，无横向溢出。国内和国际新增组件用例分别覆盖登录后 AVAILABLE（5/100）与 SOLD_OUT（0/100）：剩余数字均隐藏、可售按钮启用、售罄按钮禁用。

## 桌面回归历史（隐藏要求之前）

此前评审修正已验证 1024／1440px 的卡片圆角、尺寸和 hover 与基线一致，旧名额提示的截图为 [before 1024](before-stock-1024.png) / [after 1024](after-stock-1024.png)、[before 1440](before-stock-1440.png) / [after 1440](after-stock-1440.png)，当时像素差为 0。该状态已被上方用户追加的“屏蔽名额”要求取代，不代表最终产品界面。

[基线测量](before-stock.json) / [历史测量](after-stock.json)保留作追溯。普通／主推圆角保持 12px／16px，hover 抬升为 -2px，`motion.create(Card)` 保留 fadeIn / stagger，卡片保留 overflow-hidden。

主题 `--radius-md` 是 1rem，上一版 rounded-md 的实测结果是 16px，并非 Tailwind 默认的 6px。Card pricing／pricing-featured 变体保留原来的层级；默认 Card 外观不变，pricing 变体不继承 floatingPanelClass 的阴影。

## 三档兼容路径（仅本地 fixture）

向静态 bundle 列表临时加入一条名为“测试套餐”的 general 数据，使用已有巡游价格、200 积分、相同公共描述。第三张仅用于验证既有分组路径；未启用已下线的远航，未把 fixture 写入产品代码。

| 768px | 1023px |
| --- | --- |
| [三张同行截图](three-tier-fixture-768.png) | [三张同行截图](three-tier-fixture-1023.png) |

[测量结果](three-tier-fixture.json)包含三个卡片的坐标：同一 y，三个 x，均无横向裁切。窄平板三列的长文案沿用既有折行行为；当前两档页面不受此 fixture 影响。

## 国际站语言矩阵

7 种语言分别检查 320 / 390 / 768 / 1440px，28 组测量均无横向溢出，详见 [global-matrix.json](global-matrix.json)。为便于复核，390px 截图全部提交；截图前只在本地选择必要 Cookie。

| 英文 | 简体 | 繁体 | 印尼语 | 西语 | 日语 | 韩语 |
| --- | --- | --- | --- | --- | --- | --- |
| [截图](en-390.png) | [截图](zh-sg-390.png) | [截图](zh-hant-390.png) | [截图](id-id-390.png) | [截图](es-390.png) | [截图](ja-jp-390.png) | [截图](ko-kr-390.png) |

## 检查边界

最新 62 个聚焦测试（订阅页 59、共享 Card 3）通过。类型基线与双站生产构建结果见任务记录。上一轮全量测试和整仓 context 门禁未全绿；本轮没有将其描述为通过，是否接受基线失败由 owner 决定。没有线上发布或真实支付操作。
