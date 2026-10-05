# Compact upper lip shares main-surface elevation

## goal
用户要求截图中的白色上沿在带阴影主题下也有阴影，连续体现主表面抬升；扁平主题保持扁平。

## non_goals
不改主题参数、不加独立阴影常量/主题名单；不改动画、按钮布局、命中区或业务状态；仅在用户授权后替换预览，不重启后台。

## requirement_refs / requirement_excerpt
用户：“带阴影的主题的话，这里也要有个阴影。”截图为 compact rail 顶部与白色 Header 下沿接合。
后续用户授权：“替换”。

## interface_refs / data_structure_refs
Theme engine 的 `--codex-main-surface-elevation` 是主题立体效果真源；Header before 是原有上沿绘制投影，继续消费同一实时几何。

## history_context
- current_design_refs: opencraft/docs/workbench-design-language.md 的 Shared presentation；SHL-05。
- relevant_evolution: titlebar-motion 已提供连续白色上沿/横线，但只保留正文阴影，遗漏上沿自己的外露下沿。
- superseded_refs: 不推翻 live-motion 几何或背景约束，只补完整主题 elevation 消费。

## decisions
在现有上沿伪元素复用主题 box-shadow，用既有 toolbar 高度界定下沿外露范围，裁掉与同一白色主表面的左右/上方连接边；不新建 DOM、持久状态或时钟。

## acceptance
- Soft 主题的下沿实际像素投影可见；flat/none 没有阴影，stroke 主题维持自己的细线语义。
- 白色顶面与右侧接合不出现第二条阴影接缝；已有动画首帧/反向/显隐、主题/浮层/草稿保留回归。

## affected_paths
- opencraft/apps/workbench-web/src/styles/app.scss
- opencraft/tests/shared-control-standards.test.ts
- opencraft/scripts/smoke-shell-material-edge.ts
- opencraft/docs/workbench-design-language.md
- opencraft/design/invariants.md
- docs/engineering/domains/agent-gateway-runtime.md

## context_receipt
根/OpenCraft AGENTS、maintenance Skill/verification 完整读取；Router `opencraft titlebar upper lip theme shadow` 无匹配，bounded exact 搜索上沿/主题 elevation 真源与相邻 theme-material 测试；读取 frontend-runtime-openspec-i18n 邻接卡并核对共享控件/主题测试，未扩大到 frontend 或参考仓库。
替换轮次重新读取 maintenance/verification、自托管预览 Skill；Router `opencraft titlebar theme shadow preview replacement` 无匹配，有界读取 prior prepare/switch/smoke 与当前实际版本/PID/cgroup/runtime 摘要，不从 dirty 整仓构建发布。

## risks
小矩形直接加 box-shadow 会在白色连接处产生接缝，必须用实际像素负例验证；不只检查 CSS 声明。浏览器模拟 native safe-area 不能冒充 macOS 实机。

## validation / evidence
- 几何/控件/主题 capability 13/13，Web 类型检查、boundaries/typography 通过。
- 隔离完整源码构建 `/tmp/opencraft-titlebar-shadow-build-yusc95` 通过，既有大 chunk/dynamic-import/new URL 警告保留；未用 dirty 整仓构建替换 live。
- `/tmp/opencraft-shell-material-edge-yHoRVK/report.json`：10 个 context 与 20 个 compact browser/模拟 native safe-area 用例通过，无页面错误，computed lipShadow 与主题 elevation 相同；10 个浏览器主题/模式以移除 lip shadow 的受控负例对比实际像素，6 个 soft 下沿可见变化、flat 像素不变，白色接合像素始终相同。Frost 浅色完整截图已人工核对。
- 首帧/退出/快速反向/reduced-motion/held resize/零宽/强制颜色/手机浮层/草稿 DOM 回归通过；未验证真实 macOS 原生窗口/手机实机。
- 实际预览仍为 `20261004-titlebar-motion-5055df91da53`，本轮未写入 live、未重启后台。

## handoff / checkpoint
源码实现与相关验证完成；用户授权替换后，当前预览已为 `20261004-titlebar-shadow-2214b6bccf6e`。基于实际 `20261004-titlebar-motion-5055df91da53`，只有上沿 box-shadow/clip 两项 CSS 改动，JS 逻辑不变（94 处静态资源引用更新 namespace，可逆证明）、其他 CSS 保留。无实施或切换步骤遗留；设备观感仍待用户验收。首次 docs-impact 发现正式映射文档尚未更新，已同步真实主题绘制契约，不改规则或绕过门禁。

## preview_delivery_evidence
- `/data/opencraft-titlebar-shadow-preview-oJTTwO/provenance.json` 记录实际基线与源文件摘要；candidate/live-evidence 均 30 个主题/平台用例 + 10 个下沿像素/白色接缝负例通过，无页面/资源错误；已有 motion/held resize/草稿 DOM/手机浮层/强制颜色回归保留，无真实 Host 写入。实际 Frost 浅色截图已人工复核。
- 独立 `opencraft-titlebar-shadow-web-swap-20261004.service` 执行原子交换与失败回退，ExecMainStatus=0；status success=true / liveBrowserVerified=true / backendRestarted=false。
- 实际 version/健康接口、CSS HTTP200/immutable 和上沿 shadow/clip 规则核对通过；PID 2785955、`opencraft-neutral-focus-20261004-preview.service`、runtime SHA256 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a` 与切换前一致，数据目录未改。
- 替换轮次再次跑相关 13/13、Web 类型检查、boundaries/typography、docs-impact 与 diff check，均通过。旧 Web 留在 stage `/web` 可回退；后续修改先核对最新实际包，不直接发布 dirty 全仓构建。
