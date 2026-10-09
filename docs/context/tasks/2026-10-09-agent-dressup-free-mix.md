---
id: agent-dressup-free-mix-20261009
type: task
scope: Agent frontal plush free-mix creation flow and accessory fitting.
triggers: ["agent dressup", "plush avatar", "free mix"]
owner: keria
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-dressup-studio.tsx
  - frontend/src/components/site/hermes-plush-avatar.tsx
  - frontend/src/lib/hermes-appearance.ts
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.0
precedence: task
derived: false
---

## goal
完善 Agent 自由换装创建流程：颜色 → 形状 → 颜色 → 配饰；正脸底模和配饰能组成接近用户七角色参考图的形象。

## non_goals
- 首页 MR、部署、commit/push/MR 创建。

## requirement_ids / requirement_refs / requirement_excerpt
- requirement_ids: unknown（当前聊天需求，无外部单号）。
- requirement_excerpt: 颜色→形状→颜色→配饰；保持正脸，可自由组合，接近七角色参考。
- 2026-10-09 用户在本聊天要求继续 feat/agent-dressup-20261009，保持自由搭配，贴合已认可底模和七角色参考。

## interface_refs / data_structure_refs
- data_structure_refs: frontend/src/lib/hermes-appearance.ts、frontend/src/lib/hermes-profile-meta.ts。
- HermesAppearance v1、HermesStepDressup、HermesPlushAvatar、lightvela_appearance 持久化链路。
- 改颜色/形状保留已选配饰；无配饰状态为正脸裸底模；新版不显示皇冠。

## history_context
- current_design_refs: frontend/DESIGN.md。
- relevant_evolution: !5098 首页合并后，2231442aa1 本地换装基线，当前四步搭配与独立配饰校准。
- superseded_refs: 旧三步流程、旧粘连配饰仅供历史回退。
- frontend/DESIGN.md；2026-10-08-dressup-plush-visual.md。
- 用户提供基线 HEAD 5c0e1dc83c；实际继续分支 HEAD 2231442aa1（已有本地换装提交）；首页 !5098 已合并；当前分支 feat/agent-dressup-20261009。
- 已暂存前一阶段 Agent 换装文件，已有锚点修改保留并继续完善。

## acceptance
- 四步骤可前进/返回，换形状保留颜色；配饰独立增删且正常贴合五形状。
- 参考中帽、眼镜、耳机、书/相机等可组合；不自动切换整套穿搭图。
- 创建、完成、侧栏和编辑显示同一形象；聚焦测试、check、build，桌面/移动端截图核对。

## affected_paths
- frontend/src/components/site/hermes-plush-avatar.tsx
- frontend/src/pages/marketing/agent-dressup-studio.tsx
- frontend/src/lib/hermes-appearance.ts
- frontend/public/assets/mascot-dressup/plush/
- 对应测试。

## required_context
- route frontend agent dressup creation plush avatar 无 Pack。

## context_receipt
| 文件 | 用途 |
|---|---|
| frontend/AGENTS.md | WebP、check/test/build 门禁 |
| frontend/DESIGN.md | 现有共享组件与交互规则 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 检查 OpenSpec、测试邻居 |
| .agents/context/change-impact.json | 本轮组件与页面未命中架构强制映射 |
| .agents/skills/baseline-ui/SKILL.md | 步骤控制、焦点和移动端 |

## scan_scope
- 精确搜索 HermesAppearanceAvatar/HermesStepDressup：pages/marketing、lib、openspec。

## scan_output
- OpenSpec 无换装约束；onboarding 使用共享 StepDressup，profile-meta 保存/解析 appearance，bot-rail 使用共享 Avatar。

## evidence
- 当前组件仍是 shape/color/extras 三步；配饰共用 eyeY 推导所有垂直槽位，需视觉校准。

## risks
- 配饰切图残留其他物件、换色把天线/眼睛一起染色、不同形状眼镜缩放不准。

## validation
- `pnpm check`：成功；类型诊断 166 / baseline 171，0 新增；国际化 0 错误、47 已有警告。
- 四份 dressup / profile persistence / onboarding recovery / global onboarding 测试 105 项通过；最终复跑记录见 /tmp/dressup-regression-final.log。
- `pnpm build`：成功；最终源版本复跑见 /tmp/dressup-build-final.log。
- 桌面浏览器已验证颜色→形状→颜色→配饰、跨形状保留配饰和创建完成/侧栏同图；手机390×844配饰页无横向溢出，可纵向滚动。
- 截图 /tmp/agent-dressup-created-desktop.jpg、/tmp/agent-dressup-mobile.jpg。

## decisions
- 保留现有用户确认的五正脸底模；独立配饰先修源图再校准位置。

## handoff
- 本地实现完成；当前变更未暂存/提交/推送/发布，使用 5183 试玩。


## stage
本地实现完成，最终验证与交接。

## verified
- 八项配饰的新透明 WebP 已接入，原始切图未覆盖。五形状沿用已确认正脸底模。
- 改色校准原色差，天线球单独保留原色；眼镜保持稳定眼间距，耳机横向包住头部，帽子与手持物分槽定位。
- 当前工作目录 `/Users/keria/.codex/worktrees/homepage-review-20261008/lightvela工作区`，分支 `feat/agent-dressup-20261009`。本轮没有提交、暂存、推送或部署。

## unverified
- 新独立配饰组合的最终视觉需用户评价，不能视为用户已认可。
- 真实云端创建没有浏览器联调：本地认证服务不可用；共享数据链路由 profile payload 与 onboarding 测试覆盖。
- 预览根布局出现 SearchDialogFooter aria-hidden hydration 警告，位于全局搜索 Provider，不属于本轮换装组件。

## discard
- 5175 为旧 worktree 服务；本分支可用服务是5183。
- 旧配饰中的相邻物件残片已通过新配饰源图替代。

## restore
- 使用本 Task Pack 和配饰 manifest 续接；保留已存在的本地提交与其他文件。

## next_action
向用户交付当前本地试玩与截图，确认视觉方向后再决定后续提交。

- 上下文 catalog 全仓校验发现大量既有 Task Pack 格式问题（例如2026-10-05-embedded-composer-viewport）；已补齐本轮 Task Pack 元数据，未扩展修改历史文档。文档链接校验0错误。


## 最终验证记录
- 最终四文件回归：105/105通过（/tmp/dressup-regression-final.log）。
- 最终 pnpm check 和 pnpm build 均退出0；前端无新增类型错误。
- validate_documentation：0错误，0断链。
- context tests：27项中4项全仓治理/语言/体积校验失败，包含历史文件格式问题；本轮 Task Pack 元数据通过独立 schema 检查。
- context-audit tests：33/33通过；audit_context脚本执行完成。
- validate_change_impact --staged：通过，当前没有暂存变更；不替代后续提交前对真实变更集的检查。
- 构建生成的 next-env、字体和全仓catalog差异已恢复，保留本轮5份代码/设计/测试修改、8项新WebP和2份任务记录。


## 颜色一致性修正
- 用户指出同选蜜桃色时五个形状仍有明显色差。旧 hue-rotate 仅校正色相，保留不同底模的原始亮度与饱和度。
- 改为 SVG 灰度亮度→统一RGB调色板映射，按五底模实测中间亮度校准；保留黑色五官、白色高光及独立原色天线球。
- 新 route 命中 service-frontend / site-environment-routing / frontend-product-surface；补读 docs/context/project/services/frontend.md 与 docs/context/domains/site-environment-routing.md，沿用已读 frontend/AGENTS.md / DESIGN.md。
- 浏览器已核对蜜桃色五形状同行预览，截图 /tmp/agent-dressup-same-colour.jpg；验证日志 /tmp/dressup-colour-test.log、/tmp/dressup-colour-check.log、/tmp/dressup-colour-build.log。

- 本轮颜色修正最终门禁：73项测试通过，pnpm check 无新增类型错误，pnpm build 退出0。构建时暂停5183开发监听后文档生成冲突消失，已恢复同端口预览。

## 后续视觉反馈修正
- 移除五种形状下方的可见昵称，保留 aria-label。移除炭黑选择与随机入口，保留历史数据兼容。
- 耳机改为五形状独立耳宽/耳高锚点，缩小耳罩并将耳机置于帽子下层。巫师帽居中贴合帽檐，眼镜宽度按两眼间距修正。
- context_receipt：本轮重新读取 frontend 服务 pack、site-environment-routing pack、frontend/AGENTS.md、frontend/DESIGN.md 及 frontend-runtime-openspec-i18n 邻接卡；复核 dressup-studio 组件测试邻居。

- 云朵复用本地 body-cloud.webp，恢复中央顶部与左右下瓣的轮廓；校准中间亮度0.873，并设置独立天线球、眼间距、手部及领巾尺寸。

- 本轮验证：72项聚焦回归通过；pnpm check 166 current / 171 baseline，无新增类型错误；pnpm build退出0，5183开发服务恢复。staged设计映射检查通过，当前仍无暂存文件。

## 耳机二次锚点复核
- 用户指出豆形耳罩遮眼。整图缩放同时改变耳罩大小和间距，改为头梁/左右耳罩三层渲染，每种形状独立配置左右耳中心和耳罩大小。沿用上一轮已读取的 route must_read、frontend/AGENTS.md、DESIGN.md 及测试邻居。

- 浏览器逐一核对五种形状耳机，双眼不再被耳罩覆盖。补充云朵披风与手持物的独立宽度/纵向定位，避免超过头像下沿。

- 耳机二次修正最终验证：72项测试通过（/tmp/dressup-ear-test.log）；pnpm check 无新增类型错误，pnpm build 退出0（/tmp/dressup-ear-check.log、/tmp/dressup-ear-build.log）。五形状耳机与云朵帽子/披风/相机完成浏览器视觉复核。

## 参考图色彩复核
- 用户指出之前主色偏离七玩偶参考图。对新截图的裸露身体区域取色，校准五种主色，薄荷由偏绿改为浅青、紫色降低红调、粉色降低饱和度。颜色按钮与主体映射共用 HERMES_SKIN_COLORS。
- 继续使用已读取 frontend/site-environment-routing context、frontend/AGENTS.md、DESIGN.md 及 dressup 测试邻居；不涉及首页或生产。

- 参考配色最终验证：浏览器逐一检查五主色在五形状上的渲染；72项回归通过；pnpm check 无新增类型错误；pnpm build退出0。日志 /tmp/dressup-reference-colour-{test,check,build}.log，预览继续使用5183。

## 天线方向一致性
- 用户要求所有球球统一微斜。四种正面底模以头部接点旋转18度；云朵原生大倾角反向校正21度。杆与球同步，主体层去除旧天线区域，珠光球使用原色层。沿用已读取的frontend与站点路由context及测试邻居。

- 天线调整验证：五种形状同行截图 /tmp/dressup-antennas-slanted.jpg；裸模与配饰组合已复核；72项回归、pnpm check（0新增类型错误）和pnpm build通过。日志 /tmp/dressup-antenna-{test,check,build}.log。

## 珠光球和帽饰二次复核
- 五个珠光球改为完全相同的 front-bean 素材区域；去除各底模球，保持倾斜杆连接。
- 四类帽饰改为每头型独立帽檐接触点与宽度，降低普通帽冠比例，避免水滴帽堆在尖顶。使用已读取的 frontend/site-environment-routing context、DESIGN 与测试邻居。

- 最新反馈“帽子像放在前面”：渔夫帽/贝雷帽遮去内底面并保留弧形外檐；普通帽恢复立体高度。浏览器完成4帽×5形状的20组合复核，截图汇总 /tmp/dressup-hats-grid.png。当前进入最终回归门禁。

- 最终检查点：72项回归通过；pnpm check 166 current / 171 baseline / 0 new；pnpm build退出0；staged设计映射检查通过（无暂存改动）。日志 /tmp/dressup-hats-{test,check,build}.log。字体构建产物已还原，5183预览恢复；未commit/push/MR/部署。

## 帽口中央遮挡修正
- 用户否认上一轮整段底面裁切，要求保留左右两侧并补齐巫师帽/针织帽。四类遮罩改为平滑的中央开口，两侧回折内沿保留；巫师帽沿斜檐、针织帽沿卷边单独定位。沿用本任务已读取的context_receipt。
- 浏览器20组合视觉核对已完成，证据 /tmp/dressup-hats-wrap-grid.png；当前执行回归门禁。

- 用户进一步指出球下断片：旧球/杆局部裁切残留，改为整段去除原天线，连续渐变杆根置于主体后方，球覆盖杆上端。完成5裸模+20帽饰组合复核，截图 /tmp/dressup-connected-grid.png。进入最终完整代码验证。

- 最终检查点：72项回归通过；pnpm check 166 current / 171 baseline / 0 new；pnpm build退出0，diff空白检查与staged设计映射检查通过（无暂存改动）。日志 /tmp/dressup-connected-{test,check,build}.log。恢复5183开发服务，未commit/push/MR/部署。

## 全配饰融合与真实感检查
- 用户要求全部配饰与形状复核。浏览器检查12配饰×5形状的60个单组合，并检查3套跨槽叠戴×5形状的15个组合。
- 发现并修正：程序渐变天线偏平，改为统一原生3D杆材质；帽檐缺接触阴影，添加限定在主体alpha内的柔和阴影；披风/领巾偏低，上移0.035；书本宽度调整与双手接触；云朵物件改为左手锚点持物。5类受影响衣饰/手持物×5头型再次复核。
- 用户明确认可按点击顺序改变遮挡：撤销临时固定层级方案及对应测试，保留原交互。
- 证据：/tmp/dressup-fusion-shape-{0..4}.png 与 /tmp/dressup-fusion-final-shape-{0..4}.png；当前执行最终类型/回归/构建门禁。沿用已读取的frontend/site-environment-routing context、DESIGN与测试邻居。

## 创建头像链路检查点
- 新目标：检查真实创建外观写入、按bot/profile读回、列表/对话侧栏/资料页消费，并修复天线根残片。
- 精确检索已定位 agent-onboarding-panel、agent-buddy-profile、profile-meta、agent-bot-rail、agent-overview-panel 与 OpenCraft embedded-chat；先前猜测目录查询失败后改用有界文件名检索。
- 发现：SOUL可选读取失败会丢弃成功读取的metadata；已隔离该失败，补充刷新回归。真实聊天正文不接收appearance配置，需明确与宿主侧栏头像区分。
- 采用lightvela-web-validation；矩阵 /tmp/lightvela-dressup-validation/matrix.json。无登录测试实例，真实云端端到端待验证。
- 天线杆裁切收窄至47%–53%，排除底模肩部残片；实际截图 /tmp/dressup-stem-clean.png 已核对。

- 最终链路检查：80项头像/持久化/创建组件回归 + 99项创建计划/runner/进度回归通过；新增创建测试类型参数修正后独立复跑通过。pnpm check退出0、无新增类型错误，pnpm build退出0。
- 浏览器试玩创建/刷新保留相同头像，证据 /tmp/lightvela-dressup-validation/{created,reloaded}.png。真实云端创建到对话未验证；OpenCraft正文尚无appearance接口，宿主侧栏/列表/资料页源码已接入。
- HTML与JSON报告位于 /tmp/lightvela-dressup-validation/。构建字体与next-env产物恢复；未commit/push/MR/部署。

## 随机样式复核
- 用户指出随机截图似旧版本。重新路由并读取must_read和frontend/AGENTS；有界源码检查确认随机与手动共用HermesAppearanceAvatar/HermesPlushAvatar及统一主色集合。
- 当前服务真实浏览器随机6次，检查DOM证明新版v2配饰、云朵底模与18度天线均在随机结果使用；截图 /tmp/lightvela-dressup-validation/random-checked.png。用户截图确与当前页面不同，但未证实旧截图来源。本轮无需修改随机算法或素材。
