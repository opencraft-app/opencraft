# OpenCraft 维护验证清单

按任务选择相关检查。下列路径与命令相对 OpenCraft 根；执行前核对当前 `package.json` 和脚本内容，遵循仓库命令包装规则。脚本名不是能力保证，入口变更后更新此表。

## 证据分层

1. **输入序列**：如何重现原问题，包括方向、按住/松手、取消、身份、页面、平台条件。
2. **模型/协议**：状态转换与不变量；既测成功，也测拒绝和迟到结果。不把当前实现直接抄成 expected。
3. **真实组件**：DOM、布局、焦点、主题与生命周期；mock 只替换明确的外部边界。
4. **实际运行时/产物**：AppServer/DSH 或已打包 Electron 的真实链路；说明替身停在哪里。
5. **外部或生产结果**：只有用户授权并实际验证后才声称完成。模型检测可能产生费用；环境创建、支付和发布不是 UI 测试的默认步骤。

## 按边界选入口

| 范围 | 模型/协议检查 | 真实界面或运行时 |
|---|---|---|
| 设置页、创建/编辑表单、工具弹窗 | 按 [UI 工作流](ui-design.md) 确认容器、共享视觉壳、字段与反馈槽的组合；按改动复用既有消费方 smoke | 从相关首次入口打开实际表单，检查窄/宽及主题下标签/输入关系、密度、反馈与操作可达；记录实际看过的画面和判断，不以原型或生成截图替代产品复核 |
| 任务目录、管理列表、页面层级 | 先按 `design/ui/collections.md` 选择范式、容器 owner 和主次动作；有客观布局缺陷时在既有消费者烟测补能拒绝旧行为的断言 | 在真实 Shell/路由检查留白、阅读顺序、动作层级及相关混合状态；触屏使用触控上下文与触摸输入，单改 viewport 不算触控验收。具体矩阵见该文档，不新增通用测试框架或每次修改的全局截图门禁 |
| Sidebar 几何/动画 | `npm run test:shell-space`；`npx tsx --test tests/shell/workbench-sidebar-dock.test.ts` | `npx tsx scripts/smoke/shell/smoke-shared-sidebar.ts`；已确认的独立桌面 CDP 上运行 `scripts/smoke/conversation/smoke-primary-visibility.mjs` |
| 登录/账户 | `npm run test:desktop-login` | 通用 `scripts/smoke/shell/smoke-sign-in-menu.ts`；下游产品下游在产品目录运行 `npm run smoke:authentication-flows`，控件改动再跑 `npm run smoke:account-controls` |
| 环境目录/创建服务（无产品页面） | `npm run test:environments` | 验证服务与 Chat/Host 消费边界；不得重建已删除的 Environment 页面作为验收替身 |
| 模型连接/默认模型 | `npx tsx --test tests/execution/model-capability-consistency.test.ts tests/execution/runtime-provider-service.test.ts tests/execution/local-agent-reasoning-settings.test.ts tests/execution/model-services.test.ts` | `npm run smoke:model-capabilities` 验证真实 DSH 输入能力、默认/清除/重启与已有模型绑定（隔离本地合成推理）；`npm run smoke:model-services` 验证页面 |
| 本机项目目录选择 | `npm run test:projects` | `npm run smoke:project-picker`：显式提供已签名预览的 `OPENCRAFT_PROJECT_PICKER_EXECUTABLE`，使用隔离项目/profile；系统点击取消单独人工验收 |
| Mac 语音输入 | `npm run test:native-speech`；构建native helper后运行 `npm run test:native-speech:lifecycle`；`npm run gate` | `npm run smoke:native-speech`、`npm run smoke:dictation-interaction`：显式设置 `OPENCRAFT_NATIVE_SPEECH_EXECUTABLE`，隔离profile的真实无录音probe与合成多片段helper验证原草稿/选区不变、final-only一次插入、取消/换草稿/设置持久化；真实权限、识别与task音频交接须另获授权，不能用合成结果冒充 |
| 自适应面板 | `npm run test:adaptive-navigation` | 实际容器缩窄、内部 Back、重挂载后的草稿/滚动/焦点 |
| Newera 手机浏览器工具栏、Agent 和标签页 | `npm run test:shell-space` | `npm run smoke:workspace-presentation`；`OPENCRAFT_SMOKE_BROWSER=webkit npm run smoke:workspace-presentation` 使用已安装的匹配 WebKit，验证真实组件触屏布局、尺寸收敛、安全区和原草稿/页面保留。键盘端口为模拟能力，不能证明 iPhone/Android 的系统弹盘 |
| 听写写入所有权 | `npm run test:native-speech` | `npm run smoke:dictation-ownership` 使用真实Core/OpenCraftComposer/Voice组件，只替换ASR边界，验证旧选区不被替换、内容代次失效、reservation丢失/reentrant写入拒绝不发送；再以独立签名桌面跑正常链路 |
| 协议/Host/会话 | `npm run check:boundaries`；按边界选择 `test:appserver`、`test:dsh-bridge`、`test:chat` | 相应运行时或回放路径；断线重连、晚到帧、宿主/会话切换 |
| Terminal 字符网格/排版 | `npx tsx --test tests/shell/workbench-terminal.test.ts`（含真实 PTY） | `npm run smoke:terminal-geometry`（需已安装 agent-browser）：真实 Panel/xterm，旧继承负例、DPR 1/2、字距/宽字符/resize/字体/显隐；再量当前 Electron 的字符 Range、光标、screen/host，不向用户 shell 发送测试命令 |
| Hermes 多 Profile Bot | 通用扩展跑 `npm run test:extensions`；下游产品原 Profile 测试在下游产品的 `npm test` | 下游产品 Web 构建后在产品目录运行 `npm run smoke:hermes-profile-bots`：真实 Bridge/client/Cordis directory/resolver/source/Bot View，仅远端 Hermes 与控制面替身；切 Bot、发送、Host generation 替换与原历史恢复。真实账号、企业服务和推理需另获授权 |
| 跨包或平台入口 | `npm run gate` | 对变更平台单独验收；Web 构建不能证明 Mac/Expo 实际交互 |
| 仅文档/Skill | Skill frontmatter 与链接检查；根入口的文档/影响检查 | 人工走查典型任务，不用重打包证明文档正确 |

浏览器脚本使用项目既有 Playwright/Chromium 环境。必要时指定 `OPENCRAFT_PLAYWRIGHT_MODULE` 和 `OPENCRAFT_CHROMIUM_EXECUTABLE`，不把当前机器路径写成项目依赖。原生脚本必须显式设置已确认的 `OPENCRAFT_CDP_URL`，不沿用默认端口猜测用户窗口。

## 拖动验收不是最后一张截图

- 起始宽度取正常范围，不要从最小宽度向内拖后误以为已覆盖缩窄。
- 按住同一指针依次缩窄、拉宽、反向；采样多个渲染帧，检查 frame、viewport、真实行/按钮边界、相邻区域。
- 按住期间保存值不变；正常释放不产生内容补排版；取消/捕获丢失恢复预期基准。
- Primary 的正常展开范围与 compact/hidden 过渡分别断言，不能用同一条“始终裁切”规则混过去。
- 浮动侧栏与固定侧栏都测；菜单打开时不影响 Footer 轨道，真实 Settings 分类按钮不被裁切。
- 打断正在吸附的动画再拖，检查移动增量从当前显示位置连续变化。
- 展开、收起、快速反向、减少动态效果分开测；退场内容应及时不可交互，消失时再卸载。
- 最终至少有一次打包应用上的 held-drag 验证。记录宽度关系与状态即可，不导出账户/凭据数据。

## 异步业务矩阵

- **登录**：恢复不弹窗；同账号重登有明确完成；取消/新流程/切页/扩展卸载隔离晚到结果；资料/实例 5xx 不冒充登出；旧会话 401 不清新会话。
- **环境**：国内/国际与账户范围正确；发现、配置、Running、Connected 分别展示；创建只在确认后发生，未知提交结果不盲目重发；当前聊天 Host 不被后台发现改变。
- **模型**：两个连接可有相同模型 ID；配置修改保留 CAS 基线；新 Key 不覆盖共享旧凭据；未应用的模型编辑不能误保存；发现/检测不自动启用，默认与现有会话不被改写。
- **Chat/滚动**：恢复、流式更新、用户向上滚动、切换会话、重连分别检查；视图不能通过重挂载或强制滚到底掩盖状态错误。

## 桌面预览纪律

- 先确认哪个 checkout、构建产物、进程和 profile 在运行；用户说“没变化”时不先归因于缓存。
- 查 `docs/build-matrix.md` 和打包脚本的输出/清理范围；验证用独立输出目录、profile 与空闲调试端口，不覆盖或终止用户正在用的预览。
- 不复制真实会话、Key、Cookie 或数据库来省略登录；默认用合成数据/本地模型端点。需要真实账号或付费调用时保持授权边界。
- 记录构建/签名检查和实际窗口结果。ad-hoc preview 不是 Developer ID/notarization 发行；源码合入也不等于发布。
- 结束前把新预览放到相关页面，说明旧窗口不会热更新。不要将一次性的端口、临时目录、实例 ID 沉淀为长期配置。

## 复核此 Skill 是否有用

用以下请求人工走查路由与行动边界；这是维护者复核，不宣称为独立模型效果实验：

| 用户请求 | 应引导出的行为 |
|---|---|
| “给插件加个设置页面” | 即使没有提设计，也先由 design.md 选择真实消费者与容器；新增表单走首次入口和反馈状态，查看实际画面 |
| “页面用了统一组件，为什么还是丑” | 审查整页阅读顺序、主次动作、空态节奏和表单密度；区分共享零件与组合，不重复承诺只换 token 就会统一 |
| “只改一个字体，其他别动” | 只加载字体专题与相关消费者；不扩成整页改版或全局截图门禁 |
| “先分析，为什么松手才跟上” | 不改代码；查实时/提交宽度与裁切策略，取按住证据，审查旧测试预期 |
| “整改拖动” | 修共享几何源，分别保留显隐策略；验收双方向、反向、取消和实机，不改业务页补宽 |
| “做成 Cordis 服务” | 先定生命周期/接口/释放，服务有实际 owner；不把所有 UI 状态搬进全局 Context |
| “登录完别跳账户页” | 区分会话事实、登录完成与账户展示；保留匹配流程、代次及切页边界 |
| “参考其他产品改模型体验” | 对比现有能力，先明确可见流程变化；模型、连接、凭据分开，不把原有能力冒充新增 |
| “构建给我看” | 新产物与新进程对应，独立 profile 验证；不隐含提交/推送/生产发布 |
| “为了性能，拖动时先冻结内容可以吗” | 保留跟手与控件可达性；测量后优化更新范围，不以帧率替代交互正确性 |
| “能不能只改几行 CSS” | 根据根因判断；CSS 足够则采用，否则修恢复不变量所需的最小模型边界，不以行数或重构规模衡量质量 |
| “桌面和手机全部做成一样” | 明确需要统一的是语义、能力还是像素；保护平台输入和空间适配，不复制业务状态机或删功能凑布局 |

发现新问题时优先修正式设计、源码与用例，再判断是否需要补充本 Skill；不要把每个临时故障都扩成一条永久禁令。
