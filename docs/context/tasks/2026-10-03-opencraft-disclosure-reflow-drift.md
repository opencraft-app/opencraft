## goal
定位并修复 Read/Bash 折叠后轻微位移，固化完整折叠生命周期的标题位置不变量。

## non_goals
- 不提交或发布正式版本；本轮获授权仅切换当前预览的 Web，后台 Host 与运行时不重启。

## requirement_refs
- 用户 2026-10-03：Read/Bash 展开或收回上移 1–2px，Worked for 不发生。

## context_receipt
- 根与 OpenCraft AGENTS.md；OpenCraft maintenance skill 与验证清单。
- 当前 Chat UI 架构、活动折叠组件、Timeline Web reflow 与测量边界。
- Context Router 查询未命中；有界源码搜索定位调用链。

## findings
- `Conversation` 在 click capture 阶段调用 viewport owner 的 `captureReflowAnchor`。
- `timeline-host-web/src/reflow.ts` 默认 250ms 后移除 Turn ResizeObserver 并取消待处理帧。
- ActivityDisclosure 与 AgentActivityGroupDisclosure 的高度动画为 300ms；Worked for 的外层展开动画为 220ms。
- 最后 50ms 的高度变化发生在锚点保持释放之后，可能留下小量位置偏移；像素取整使短内容未必表现出永久偏移。

## evidence
- 临时 Chromium DOM 诊断直接加载当前 reflow.ts 的转译代码；使用同样的倒序滚动容器、禁用原生 anchoring、300ms 高度动画和 cubic-bezier(.19,1,.22,1)。没有创建产品测试文件或修改源码。
- 2000px 内容：300ms 动画 + 250ms 保持，展开残留 -1px、收起 +1px；仅将保持改为 400ms，两种操作都为 0px。
- 4000px 内容：相同 250ms 保持，展开 -2px、收起 +2px；400ms 保持两者为 0px。
- 220ms 动画 + 250ms 保持，2000px 内容两种操作都为 0px。
- 这是 Chromium 控制变量复现；未采集用户 iOS 页面位置，也未证明用户报告的两个方向都上移是同一方向的偏差。

## proposed_direction
折叠交互的滚动锚点保持应覆盖实际动画生命周期和末帧测量，由交互结束或取消释放；固定时间不应先于所属动画结束。

## implementation
- 用户 2026-10-04 要求实施。活动项、分组和 Worked-for 各自报告动画完成，视口按 lease 保持到稳定末帧。
- 新交互撤销旧 lease；主动滚动、视口替换和卸载取消保持；完成回调携带本次 render 身份并核对动画目标。
- 正式设计固化为 WSP-37 和 Chat UI disclosure anchor lifetime。
- 包级新增 Worked-for 控制变量发现：无 exit 动画的 AnimatePresence 仍会延后内容移除，晚于父级收起布局完成，造成一帧大位移后恢复。移除这个多余 presence owner，保留进入动画，收起按实际同步 DOM 提交完成；lease.complete 当场补偿，再等待稳定帧释放。

## handoff
用户授权“把这项完整修复也接入当前预览”。完整候选 Web 已从最新运行菜单包定向编译并切换；后台 PID、运行时哈希和数据目录不变。实际 port80 包级回归、完整 Web 哈希清单和实际 HTML buildId 已核验通过；手机实测留给用户刷新后确认。

## 运行包复核（2026-10-04）
- 用户反馈“250ms 那个问题好像还在”。本轮只核对，不重启或修改运行服务。
- port80 当前 buildId 为 `20261004-thread-menu-b5f8180b6dc9`，其基础是仅菜单更新的 `20261004-goal-menu-2a0b1e518cee`。
- 直接检查当前正在服务的 `assets/thread-menu-b5f8180b6dc9/a-xhSHKQST.js`：仍有 `var vk=250`，reflow helper 在定时器触发后 disconnect observer / cancel frame；没有 `data-timeline-reflow-owned`。
- 因此此生命周期修复尚未进入当前运行 Web；源码存在新 lease 与动画完成接线，但不能把源码验证当作此预览已升级，也不能把当前服务的旧实现归因浏览器缓存。
- 下一步如获交付授权，需在最新运行菜单版本基础上带入完整折叠修复并验证实际包，不覆盖其他同时进行的变更。

## 交付验证（2026-10-04）
- 77 项聚焦测试通过（原 71 项加 6 项 reflow 生命周期/同步移除回归）；Timeline Host 与 Workbench Web 类型检查、平台边界、正式设计影响映射及 diff check 通过。
- 源码浏览器使用真实 Read/Bash、Group、Worked-for 组件；正常与减少动画模式共 16 条展开/收起路径，最终偏移均 0px，正常动画过程最多约 0.49px（子像素取整）。快速反向完成且后续内容增长不再持有锚点。
- 候选包实际组件回归同样通过 16 条路径；另外验证滚轮、方向键、指针按下、实际触摸移动、视口替换及 dispose 取消，共 12 条正常/减少动画路径。
- 复验最新 Goal“＋”菜单的弹窗焦点交接、取消保留输入与合成保存，确认本次定向替换没有覆盖已有菜单更新；没有调用真实 Host 写入。
- 独立 `opencraft-disclosure-web-cutover-20261004.service` 原子交换 Web，退出码 0；健康检查正常。新 buildId `20261004-disclosure-d017acfc338e`，基础 `20261004-thread-menu-b5f8180b6dc9`；资源命名空间 `assets/disclosure-d017acfc338e/`。
- 承载服务仍是 `opencraft-neutral-focus-20261004-preview.service`，PID `1554252`；`runtime/server.mjs` SHA-256 仍为 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`。未重启 AppServer/Host，数据目录仍为 `/var/lib/opencraft-preview-codex-20260923173651`。
- 制品、完整 Web 哈希清单、来源记录、候选呈现证据和切换结果在 `/data/opencraft-disclosure-preview-IF6g3P/`；该目录 `web/` 保留交换下来的旧 Web 作回退点。浏览器测试只在响应中挂载合成夹具，没有把测试替身写入交付资源。
- 切换后 port80 再跑同一实际包浏览器检查：16 条展开/收起均最终 0px，Worked-for 全程 0px；12 条取消路径通过。证据 `live-evidence.json`，资源完整性与 buildId 一致，实际 HTML meta/入口也指向新版本。
- 手机 Safari 未由代理实测，用户需要刷新页面加载新资源后验证实际体验。

## 实测反馈与重新诊断（2026-10-04）
- 用户反馈当前预览仍会移动，并截图标出展开的整组活动标题（Read files and ran a command）；此前模拟通过不代表用户结果已完成。
- 此轮 Router 查询 `OpenCraft disclosure reflow drift 手机实测 仍移动 当前预览` 未命中；通过上述组件、viewport owner、timeline virtualizer/measurement/scroll controller 的有界搜索继续定位。若干猜测文件/浏览器路径不存在，停止猜测并记录检查点。
- 运行源站仍为 `20261004-disclosure-d017acfc338e`，服务 PID 和运行时未改变；没有可读取的用户浏览器 tab，不能据源站版本断言用户端版本或归因缓存。
- 之前源码/制品夹具只接真实 disclosure 和 viewport owner，没有 Turn 虚拟列表；本轮补入实际制品的 VirtualizedConversationTurns，80/200/4000px 内容、普通/减少动画、分数初始位置，共 12 条展开/收起，最终偏移为 0，但动画中仍有最多 0.5 CSS px 波动。该波动不能当作严格标题位置不变量已达成。
- 全局测量补偿在增长时也保持视口，因此旧夹具“增长必然移动以证明 lease 已释放”的断言不适用于带 virtualizer 的会话；已移除该误判，未改产品源码或部署。
- 诊断脚本和证据位于 `/data/opencraft-reflow-diagnosis-Da8Ppd/`；下一步测量可见 summary/icon 而非仅透明按钮，并核验不同浏览器及多 Turn 测量写入次序。当前不重启或替换预览。
- 进一步补入 3 个 Turn，活动组位于非最新 Turn，桌面指针/DPR1、分数初始位置。可见 summary 动画期间最高到最低为 0.625–0.9375 CSS px（相对起点约 ±0.5px），最终仍回到起点；减少动画 6 条均全程 0。之前只断言相对起点 <=0.55px，没有限制往返振幅，漏掉约 1px 抖动。
- 控制变量：仅在隔离浏览器响应上将 motion 写入的 body-clip 数值高度投影为整 CSS px，其余真实制品组件/测量/scroll controller 不变，12 条展开/收起均全程/最终 0px。支持“分数动画高度与原生 scrollTop 取整不一致”是该模拟残余抖动的因果边界；未证明用户是否还存在动画结束后的永久错位。
- 整数投影实验的 MutationObserver 仅为诊断反事实，不是待合入方案；产品修复应在统一动画/视口投影边界设计，不能增添逐控件 DOM 监听补丁。尚未更改产品源码或再次交付。
- 本机已有 Linux WebKit 启动失败（缺 libgstreamer）；未安装依赖、未实测 iPhone。用户截图不能区分动画期间与结束后；需要确认这个观察维度，不能将模拟的因果结论直接升级为其完整根因。

## 第二阶段实施（2026-10-04）
- 用户要求继续修复。此轮 Router 查询 `opencraft disclosure reflow fractional animated height title jitter fix` 未命中；精确复核 activity/group/disclosure height、motion-dom MotionValue 接线，并读取 frontend runtime adjacency 及静态缓存测试邻居（后者不构成折叠证据）。
- 新增 `useDisclosureHeight`：在自身 MotionValue 的提交入口统一投影数值/px 高度，Motion 仍为唯一高度写入者；`auto` 和非数值 CSS 值保持原样，不增加测量/MutationObserver，不改动画时长。ActivityDisclosure 与 Group 消费同一适配器，现有 reflow lease 保留。
- 初轮真实源码组件 16 条展开/收起全程、结束后均 0px；Web 类型检查及 13 条控件/生命周期/高度投影聚焦测试通过。
- 正式设计 WSP-37 和 Chat UI 已更新。浏览器回归正扩展为真实多 Turn virtualizer、分数初始几何、可见 label 全程与往返振幅、桌面/触控、减少动画与快速反向；源码未交付到当前预览，Host 不重启。
- 扩展源码浏览器 48 条路径通过，全程、往返振幅和最终偏移均为 0；快速反向与独立后续增长控制通过。75 条相关测量/滚动/活动/高度/生命周期测试退出 0；Web 类型、平台边界、i18n 和显式设计影响通过。额外 Codex 固定参考对照测试因硬编码的 r3562 目录缺失而未能运行，未改变参考 loader。
- 首候选 `RDyyJI` 实际包验证 64 条路径全程 0、12 条取消通过。独立切换 guard 发现期间源站已更新到 `20261004-material-edge-d62a11d3c3db`，在任何文件交换前拒绝切换，没有覆盖该更新或重启服务。
- 已比较最新与原基础包的 pA/xj/Ck，三个声明完全相同；新修改为 material-edge 的主题/侧栏 CSS。新的隔离候选 `JAN4UI` 以此为基础，仅重新编译高度适配器与两个消费者，build `20261004-disclosure-pixel-3aefaa3a6652`，其余资源保留最新来源。重新验包后才可切换。

## 第二阶段交付结果（2026-10-04）
- 最新候选包 64 条展开/收起与 12 条取消路径通过，全程/往返/最终偏移均 0。新资源空间中除主模块外的 477 个文件与最新 material-edge 基础一致（仅更新资源空间引用），CSS 没有被回退。
- 独立 `opencraft-disclosure-pixel-web-cutover-20261004-rebased.service` 完成原子 Web 交换，`Result=success`、`ExecMainStatus=0`。当前 build `20261004-disclosure-pixel-3aefaa3a6652`，基础为 `20261004-material-edge-d62a11d3c3db`。
- 承载服务 PID 仍为 1554252，工作目录和 runtime SHA-256 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a` 不变，后台与 Host 没有重启；数据目录沿用原值。
- 切换后核验 3354 个 Web 文件的清单 SHA-256、实际 HTML buildId/入口、健康接口。实际 port80 再跑 64 条真实制品组件路径及 12 条取消路径，退出码均 0，标题全程与往返振幅均 0。
- 来源、候选/源站三组浏览器证据和 status 位于 `/data/opencraft-disclosure-pixel-rebased-JAN4UI/`；其 `web/` 保存交换下来的 material-edge Web 作回退。测试只在隔离浏览器响应挂载合成输入，未把测试夹具写入交付资源或调用真实 Host 写入。
- iPhone/Safari 实机仍待用户刷新后确认；旧固定 Codex 参考目录缺失的对照测试仍未通过，不能将本轮有界门禁描述为全仓 gate 全绿。没有 commit/push 或正式发布。
- 交接时并行预览又基于本次 build 更新为 `20261004-local-edge-cfe65f910d12`。已比较此最新主模块与本次模块的 pA/xj/Ck、共享高度与 reflow 三个声明，全部逐字一致，修复没有丢失；后台 PID 仍为 1554252。上述 64 条源站验证针对本次 disclosure-pixel build，不冒称后来每一份 CSS 更新都重新跑了整套矩阵。
