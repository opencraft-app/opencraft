---
id: opencraft-navigation-rail-icons-2026-10-04
type: task
scope: 借鉴 codex-new 的导航图标视觉，在共享控件中实现并验证。
triggers: ["codex-new 左侧边栏图标"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/components/shell-navigation
  - opencraft/packages/design-system/src/menu.web.scss
status: active
reviewed_at: 2026-10-04
review_due: 2027-01-04
revision: 0.2.0
precedence: task
derived: false
---

## goal
核验用户截图的大图标导航做法，把当前应用导航的尺度、状态色和选中图形固化到正确 owner，同时保留已有入口和触控能力。

## non_goals
- 用户后续“搞起来”授权实现并验证，“继续”续接本次前端预览交付；不重启后台、不恢复此前删除的 Home 功能、不复制参考产品全部目的地，不提交/生产发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户希望左侧边栏换成截图的大图标风格，要求查看 `/data/codex-new` 如何实现。
- 用户随后“搞起来”授权本轮源码实施与验证。
- 源码交接后“继续”续接前端预览；采用当前运行包局部增量，不全树构建并行 dirty 改动。

## interface_refs / data_structure_refs
- NavigationAction.icon 是语义声明；NavigationIcon 是平台图形投影。
- ShellNavigationMotionFrame 拥有收缩几何；Design System 拥有图标尺度与状态色。

## history_context
- current_design_refs：`opencraft/design/README.md`、`opencraft/docs/platform-architecture.md`。
- relevant_evolution：已有导航分为 applications/account 与 compact/expanded，共享状态不因呈现变化复制。
- superseded_refs：不拿旧 ref/codex 快照代表本次新解包版本。

## acceptance
- 核验参考版本、运行入口、实际控件 token 与本地 CSS，给出可实现方案。
- 普通态与选中态使用同一 20px 图形盒；紧凑/展开中不缩放。桌面基础控件 36px，触控至少 44px；导航不再受菜单 14px 图标规则影响。
- 原有入口、插件语义、页面选择与持久化所有权不变，菜单密度不变；鼠标、触控、键盘与强制颜色分别验证。

## affected_paths
- Shell NavigationIcon/NavigationContent/Frame、shared control/token、compactActionSize 与相关测试/浏览器 smoke。
- 本记录、design/invariants、正式 agent-gateway-runtime。

## required_context
- OpenCraft maintenance；研究阶段 Router 无匹配，实施阶段 navigation 关键词命中 frontend-product-surface，读取必读 frontend 服务 Pack 后限定 OpenCraft 边界。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、opencraft/AGENTS.md | 维护授权与平台边界 | 保留 dirty 改动，不重启/发布 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 视觉与所有权规则 | 优先共享控件 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | 后续验证选择 | 真实控件与触控检查 |
| opencraft/design/README.md | 工作区边界 | 不引入新的页面行为 |
| codex-new 解包 README | 参考身份与完整性说明 | 26.930.31428 / build 12913，仅只读分析 |
| docs/context/project/services/frontend.md | 实施路由必读 | 确认任务不触及 frontend 服务源码 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 检查邻居 | 选择真实组件与 i18n 测试根，不另造国际化上下文 |
| opencraft/design/invariants.md、docs/engineering/domains/agent-gateway-runtime.md | 现有所有权与正式设计映射 | 同步导航图标共享 owner 的约束 |
| opencraft/.agents/skills/opencraft-self-hosted-preview/SKILL.md | 当前代理依赖宿主服务 | 独立执行切换/失败回退，前端更新不停止后端 |
| opencraft/docs/build-matrix.md | headless/Web 制品契约 | 保留 headlessHostId 与缓存/manifest，隔离产物 |
| docs/context/domains/release-gitops.md | 交付路由必读 | 明确只有本机临时预览，不触及 GitOps/生产 |
| 当前预览的 default-steer prepare/switch 与 compact-titlebar smoke | 确認实际资源来源和验证邻居 | 保留默认Steer/折叠/顶栏等已部署变更，独立候选真实包验证 |

## evidence
- Router 查询 `opencraft 左侧边栏图标 sidebar activity rail codex-new 参考视觉设计` 无匹配。
- 限定 sidebar 文件未命中 activity-bar；随后由 rg --files 定位 shell-navigation。
- 新解包原始 app-initial 的 YXo 为导航 rail，GXo 选择 `railIcons.default/selected ?? largeIcon`，TXo 使用共享 Button 的 size=xl/iconSize=lg/ghost/secondary/uniform。
- 必须追到 CSS：该 Button size=xl 实际使用 control-size-lg=2.25rem，即通常 36px；iconSize=lg 使用 control-icon-size-lg=1.25rem，即通常 20px。不能把单独 icon-lg utility 的 28px 当成此控件尺寸。
- 浏览器 rail 宽度 w-13、间距 gap-y-4、圆角 10px；不同平台选择由源文件声明，截图物理像素不是 CSS 单位。
- 本地 NavigationIcon 默认 size=15；Settings size=16；但 NavigationContent 所在 shell-navigation__items 同时套 menu.item 和 navigation-control，menu.item 的直子 SVG 规则最终强制 14px/secondary 色。
- 本地 motion 在 compact 只额外缩放 1.04，不能弥补上述尺寸/颜色所有权问题。
- 当前 nav compactWidth=52、compactActionSize=34。图标和按钮是不同尺寸，手机触控命中区仍须保持至少44px；不据截图缩减触控区。

## risks
- 参考是包含多个产品模式的解包 renderer，不能宣称所有入口等同当前 Codex 产品配置。
- NavigationAction 的插件语义不能改为平台组件或像素字段；不能用 Home 图形冒充 Chat 意图。

## validation
- RED：新图形断言能识别旧实现缺少 variant/选中投影；首次类型检查识别 JSX SVG data 属性的类型问题，修正为类型兼容的 props 对象；旧 Footer 源码断言适配为共享语义入口后重跑。
- `npm run test:navigation-icons`：35/35（图形投影、导航模型、Dock/既有 sidebar 不变量）。
- `npm run test:control-standards`：17/17；Web、Design System、Workbench Runtime 类型检查通过；`npm run check:boundaries` 通过。
- `npm run smoke:navigation-icons`：34/34，使用真实 Dock/MotionFrame/NavContent/主题/i18n，只有 controller 的未消费能力为替身。包含 Codex/Lavender × 浅/深 × 桌面/触控 × 紧凑/展开共16组，再按输入方式检查52→60→80→100→137→100→80→60→52连续几何共18组。检查20px图形、36/44px命中区、边界、菜单14px负例、选中/hover、焦点/DOM身份、键盘与强制颜色；浏览器未报错。
- 本机 evidence：`/tmp/opencraft-navigation-icons-OfpthM/evidence.json` 与对应截图；已检查浅色紧凑和深色展开截图。路径仅作本次记录，不是产品配置。
- 正式设计影响检查通过：`--staged` 的空集合仅是流程检查，另以本任务显式14文件集合检查命中 agent-gateway-runtime 并通过。文档检查通过，无断链。
- 源码交接阶段未更新预览；后续前端交付见下节。未运行全仓 gate、未进行手机实机或 Electron 验收；浏览器验证不冒充原生体验。

### 当前前端预览交付
- 已按 self-hosted-preview/maintenance 规范以正在运行的 default-steer 包为基底，不构建整个 dirty 工作树。源码派生3个导航函数、1个Footer调用、compactActionSize与限定Sass导航规则；475个其他新namespace文件除资源URL改写逐字节不变，所有旧immutable资源保留。候选记录与回滚包在 `/data/opencraft-navigation-preview-UYL1ne`。
- 发布缓存/SPA/静态Host聚焦测试 `npm run test:web-release` 10/10；当前文档检查与变更影响流程检查通过。
- 候选及实际80端口真实包 smoke 均20组通过（16种主题/输入/档位 + 2次held-drag + 2次手机浮层）；包含无测试wrapper的真实页面3个导航图标、实际打包Shell/controller/motion、设置图形细节、键盘/强制颜色/减少动态效果/草稿DOM身份，零pageerror/asseterror。外部内容/Host边界由夹具替换，浏览器WebSocket隔离，无真实Host或模型写入。已查看实际页面、触控紧凑和手机浮层截图。
- 首次独立切换在实际浏览器检查通过后，验证脚本同步等待浏览器子进程令Undici空闲连接过期，最后探测报 `UND_ERR_SOCKET / other side closed`；触发完整回退，旧buildId/健康恢复，后台PID未变。它是验证脚本连接复用失败，不能报告为前端或模型故障。修正为只读探测新连接与有限瞬时socket重试，不重试交换/写入操作。
- 第二次 `opencraft-navigation-icons-20261004-retry-cutover.service` Result=success、ExecMainStatus=0，status.json success=true。实际HTTP buildId `20261004-navigation-icons-80433d8b205c`、健康200/ok，新JS/CSS HTTP哈希匹配manifest且返回immutable；完整Web/旧资源逐项哈希验证通过。
- 80端口PID仍2785955，原unit/cgroup/cwd/data-dir不变，runtime SHA256仍 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`；后台没有重启。旧Web完整保留在staging/web可回退。手机实机验收待用户刷新后观察。

## decisions
- 建立导航栏专用共享图标/控件呈现，移除菜单对 rail 图标几何及颜色的错误控制。
- 借鉴 default/selected 图形、20px 视觉尺度和中性状态色，保留现有业务入口与导航状态 owner。
- 闭合轮廓图形选中时填充；Bot/Server/Settings 等含内部细节图形使用更强轮廓，不靠统一 SVG fill 抹掉细节。不复制参考专有图形。

## scan_scope
- 新解包原始 app-initial/app-shared JS/CSS 及有限命名 SVG；本地 shell-navigation、Design System menu/control/token 与相邻测试。

## scan_output
- 不可变参考文件未修改。共享源文件只改任务相关部分，同文件已有 focus/material/侧栏边界等并行改动保留；前端预览仅按续接授权更新本次导航增量。

## handoff
- 源码与当前前端预览交付完成，刷新可见20px导航图标及更明确选中态。按维护规范将尺寸/状态色集中于 Design System、图形投影集中于 NavigationIcon、几何集中于 Shell；不改变页面选择 owner。后台未重启，现有已部署改动与旧资源保留；手机实机/原生验收未宣称完成。

## stage
源码、候选验证、前端原子切换与实际运行包验收完成；等待用户实机视觉反馈。

## verified
- 原菜单样式将图标强制14px；新应用导航共享规则固定20px、按钮继承状态色。
- 35项导航与17项共享控件测试、34组真实组件浏览器检查、3个受影响包类型检查及平台边界检查通过。
- Web交付聚焦测试10/10、候选与live真实包20组检查通过，运行buildId/健康/PID/runtime/hash/cache均核对。

## unverified
- 手机实机、原生与全仓 gate 不在本轮已验证结论中。

## discard
- 不能将参考 standalone icon-lg 的28px误当导航按钮iconSize=lg的20px。
- 不再使用compact时scale1.04或菜单14px规则作为应用图标尺度；不恢复Home或伪造目的地。

## restore
- 续接本记录与 shell-navigation、Design System 控件/token；定向命令已登记为 `test:navigation-icons`、`smoke:navigation-icons`。
- 工作树含其他会话大量并行改动；不得直接整树打包覆盖当前预览。
- 当前监听PID2785955、unit `opencraft-neutral-focus-20261004-preview.service`、cwd `/data/opencraft-neutral-focus-YZHpna/opencraft-server`、data-dir `/var/lib/opencraft-preview-codex-20260923173651`；runtime SHA256 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`。
- 实际基线 `20261004-default-steer-59f854ec977a`；候选 `20261004-navigation-icons-80433d8b205c`。staging `/data/opencraft-navigation-preview-UYL1ne` 包含源码派生 prepare、provenance、manifest、真实包 smoke、独立 switch；仅改3个当前chunk中的导航函数/规则与compactActionSize，475个同namespace文件除URL改写逐字节不变，所有旧immutable资源保留。

## next_action
- 交接更新成功与后台未重启，用户刷新查看；若需要再调整视觉，从当前live基底继续，不覆盖其他会话后续更新。
