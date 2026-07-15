# 当前执行计划：公开测试公告付费表格展示调整

> 分支：`frontsandbox/public-beta-launch-ai-price-79`
> 规模：S
> 范围：仅调整 `/docs/announcements/public-beta` 公告中付费方案展示。

## 任务清单

- [x] 1. 调整付费方案说明、远航版字段和含 AI 积分版本表格展示，并运行文档改动的基础校验。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/src/content/docs/announcements/public-beta.md`
  - 验收方式：公告付费方案按最新策略展示，`git diff --check` 与 `pnpm check` 通过。
  - 结果：说明文案已补充含 AI 积分版本敬请期待；远航版价格和 Agent 标为敬请期待，独立环境展示为 `4 核 8GB x 3`；含 AI 积分版本表格已加回且月度价格、Agent 标为敬请期待。

## 验收重点

- 不改动订阅/支付逻辑。

---

# 当前执行计划：干净用户三要素实名闭环

> 分支：`codex/force-idcard-reface`
> 规模：M
> 范围：支持无两要素、无本地手机号、无 Shadow 绑定的用户完成实名；不恢复独立“绑定安全手机”入口。

## 任务清单

- [x] 1. 用服务层和 HTTP 测试锁定干净用户流程及手机号安全边界。
  - 角色：Developer
  - 影响文件：`user/auth/internal/service/*realname_faceid*_test.go`、`user/auth/internal/httpapi/handler_test.go`
  - 验收方式：覆盖无手机号可创建刷脸尝试、刷脸后发送/校验候选手机号、手机号冲突与篡改拒绝、既有手机号兼容。
- [x] 2. 扩展 FaceID 手机验证 API，并在 Shadow 验证成功后原子写入本地手机号与推进状态。
  - 角色：Developer
  - 影响文件：`user/auth/api/openapi.yaml`、生成 API、FaceID service、Memory/MySQL store、HTTP handler
  - 验收方式：服务端状态严格按 `identity -> face -> phone -> shadow -> completed` 推进；attempt/audit 只保存手机号哈希，不保存明文。
- [x] 3. 前端在无手机号时仅于刷脸成功后展示可编辑手机号，并随发送/校验请求提交。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/account-page.tsx`、Repository 类型/实现/测试
  - 验收方式：干净用户可完成全流程；已有手机号仍不可在该流程中替换；独立绑定入口继续隐藏。
- [x] 4. 运行 auth 全量测试、Go 静态检查、frontend 目标测试、类型检查与 i18n 检查。
  - 角色：Reviewer
  - 影响文件：测试与检查输出
  - 验收方式：相关新增测试通过，无已知回归；任何既有基线失败单独记录。
  - 结果：auth `go test ./...` 与 `go vet ./...` 通过；frontend 57 条目标测试、`pnpm check`、`pnpm i18n:check` 通过。MySQL 集成测试在配置 `LIGHTCLAW_AUTH_TEST_DSN` 时执行。

## 验收重点

- 干净用户必须先填写姓名身份证并完成新一次刷脸，不能直接进入手机号验证。
- 手机号必须通过 Shadow 真实短信验证；Shadow 创建/绑定成功后才写入本地手机号并完成 `phone_3fa`。
- 已有本地手机号的用户沿用当前号码且不能借实名流程换号。
- 不提供独立“绑定安全手机”产品入口。

---

# 当前执行计划：Hermes 默认头像高清替换

> 分支：`frontsandbox/hermes-avatar`
> 规模：S
> 范围：仅替换 Hermes 公共默认头像资产，不调整用户账号头像、组件结构或交互逻辑。

## 任务清单

- [x] 1. 将“我的 Hermes”等场景共用的默认头像替换为用户提供的高清图片。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/public/hermes_logo.png`
  - 验收方式：目标文件与用户提供的 `nousresearch.png` 内容一致，保持 640×640 PNG 与透明通道；现有 `/hermes_logo.png` 引用继续有效，`git diff --check` 通过。
  - 结果：目标文件与源图片 SHA-256 一致；本地静态资源请求返回 HTTP 200、`image/png` 和 17,597 字节。

## 验收重点

- “我的 Hermes”、创建成功页和默认头像回退继续复用同一 `/hermes_logo.png` 公共路径。
- 不修改账号用户头像逻辑，也不新增重复图片资源或组件分支。

---

# 已完成计划：FaceID 复用 Shadow 手机验证

> 分支：`codex/faceid-shadow-sms`
> 规模：M

## 任务清单

- [x] 1. 为已有 active Shadow 绑定补充 FaceID 手机证明复用测试。
  - 角色：Developer
  - 影响文件：`user/auth/internal/service/realname_faceid_core_test.go`
  - 验收方式：刷脸成功后复用当前手机号证明，直接进入 `shadow_pending`，不要求再次输入短信验证码。
- [x] 2. 为未绑定 Shadow 的账号补充真实短信发送与腾讯验证码校验测试。
  - 角色：Developer
  - 影响文件：`user/auth/internal/service/realname_faceid_core_test.go`、`user/auth/internal/httpapi/handler_test.go`
  - 验收方式：发送接口调用 Shadow `SendSmsVerifyCode`；验证码提交通过 Shadow 绑定校验，不再消费本地 `sms_challenges`。
- [x] 3. 接入 FaceID 专用 Shadow 短信 API，并更新前端 Repository。
  - 角色：Developer
  - 影响文件：`user/auth/api/openapi.yaml`、`user/auth/internal/api/server.gen.go`、`user/auth/internal/httpapi/handler.go`、`user/auth/internal/service/realname_faceid.go`、`frontend/src/repositories/http-repositories.ts`、`frontend/src/repositories/types.ts`、`frontend/src/pages/marketing/account-page.tsx`
  - 验收方式：已有绑定跳过短信；未绑定账号点击“获取验证码”会真实下发 Shadow 短信并可完成绑定。
- [x] 4. 运行 auth 与 frontend 目标测试及静态检查。
  - 角色：Reviewer
  - 影响文件：测试与检查输出
  - 验收方式：Go 目标测试、前端目标测试、类型检查和 diff 检查通过。
  - 结果：auth 全量测试与 `go vet` 通过；frontend `pnpm check` 及 FaceID/Repository 53 个目标测试通过。
- [x] 5. 放行国内环境 FaceID 回调。
  - 角色：Developer
  - 影响文件：`argocd/services/service-gateway/beijing-sandbox/config.yaml`、`argocd/services/service-gateway/shprod/config.yaml`、`service-gateway/internal/gateway/config_policy_test.go`
  - 验收方式：北京沙箱和上海生产均将 `GET /auth/realname/faceid/callback` 列入 `public_allow`，配置策略测试和 service-gateway 全量测试通过。

## 验收重点

- 必须重新刷脸。
- 已有 active Shadow 账号复用既有手机号证明，不重复发送短信。
- 未绑定 Shadow 的账号仍需通过真实 Shadow 短信完成手机号验证与绑定。
- Shadow 实名同步成功后才最终完成实名认证。

---

# 已完成计划：LightVela 场景任务安装器 v1

> TAPD：[#135720398](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091135720398)
> 分支：`frontsandbox/scenario-task-installer`
> 规模：M

## 任务清单

- [x] 1. 新增 `scenario-tasks` 场景配置和 builder。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/scenario-packs.ts`、`frontend/src/pages/marketing/scenario-tasks/scenario-task-builder.ts`
  - 验收方式：四个首发场景都能生成 name、prompt、一次性 schedule、周期 schedule、deliver 和最近执行匹配结果。
- [x] 2. 为 `scenario-task-builder` 补单元测试。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/__tests__/scenario-task-builder.test.ts`
  - 验收方式：覆盖 A股非投资建议、AI 动态无 LightVela 启发、一次性/周期 schedule 和 recent run 匹配。
- [x] 3. 新增 `ScenarioTaskGrid` 和场景卡。
  - 角色：Implementer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioTaskGrid.tsx`
  - 验收方式：`/agents/automations` 能展示四张场景卡，现有模板/添加入口仍可用。
- [x] 4. 新增 `ScenarioInstallModal`。
  - 角色：Implementer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`
  - 验收方式：按场景填写少量字段，分步展示任务设置、任务摘要、执行频率和微信 / QQ 回传，提交后返回 draft。
- [x] 5. 新增试跑提示承接和 `ScenarioEnableConfirmModal`。
  - 角色：Implementer
  - 影响文件：`frontend/src/pages/marketing/openclaw-automations-panel.tsx`、`frontend/src/pages/marketing/scenario-tasks/ScenarioEnableConfirmModal.tsx`
  - 验收方式：试跑创建成功后在自动任务页提示已开始处理、结果稍后推送，并可进入常态任务确认。
- [x] 6. 在 `AutomationsPanel` 中接入 Cron 创建和轮询。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/openclaw-automations-panel.tsx`
  - 验收方式：点击“先跑一次”创建一次性执行任务，创建成功后刷新已生效任务和最近执行；用户可通过页面提示或最近执行查看结果，并能继续添加周期自动任务。
- [x] 7. 更新 i18n 字典。
  - 角色：Developer
  - 影响文件：`frontend/src/i18n/generated/zh-CN.json`、`frontend/src/i18n/generated/en-US.json`、`frontend/src/i18n/generated/zh-to-key.json`
  - 验收方式：`pnpm i18n:extract` 和 `pnpm i18n:check` 通过。
- [x] 8. 运行目标验证。
  - 角色：Reviewer
  - 影响文件：测试与类型检查输出
  - 验收方式：目标单测和 `pnpm check` 通过；若浏览器烟测受登录态限制，明确记录未覆盖项。
- [x] 9. 在场景安装步骤中复用微信 / QQ 扫码通道回传。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`、`frontend/src/pages/marketing/scenario-tasks/scenario-task-builder.ts`、`frontend/src/pages/marketing/openclaw-automations-panel.tsx`
  - 验收方式：已扫码接入微信 / QQ 时可选择对应回传目标；未接入时禁用试跑 / 添加，并在场景弹窗内完成扫码连接；试跑和常态 Cron 共用同一份 deliver。
- [x] 10. 收紧四个场景提示词，显式指定执行工具和信息获取方式。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/scenario-packs.ts`、`frontend/src/pages/marketing/scenario-tasks/__tests__/scenario-task-builder.test.ts`
  - 验收方式：世界杯等实时类场景的生成 prompt 明确优先使用联网搜索/网页浏览/可用 CLI 工具，避免模型自行泛化导致执行时间过长。
- [x] 11. 场景安装弹窗内联完成微信 / QQ 连接。
  - 角色：Implementer + Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`、`frontend/src/pages/marketing/openclaw-automations-panel.tsx`
  - 验收方式：场景定时任务只保留微信和 QQ 两个交付选项；未连接时可在当前弹窗内打开连接子弹窗，不再引导去通道页。
- [x] 12. 通道连接改为实例内 exec 调用 `acli gateway qr-url`。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`、`frontend/openspec/spec.md`
  - 验收方式：微信 / QQ 连接子弹窗都通过 `debug/exec` 执行 `acli gateway qr-url --platform <platform> --wait true` 获取二维码，不再调用前端 Repository 通道配置 API。
- [x] 13. 将场景安装弹窗拆为任务设置和消息通道两步。
  - 角色：Implementer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`、`frontend/openspec/spec.md`
  - 验收方式：第一步只展示任务设置和任务摘要；第二步展示执行与回传；去掉“当前首版仅保留微信和 QQ”等内部产品逻辑解释文案。
- [x] 14. 将场景试跑改为下发后立即开始。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/scenario-tasks/scenario-task-builder.ts`、`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`、`frontend/src/pages/marketing/openclaw-automations-panel.tsx`、`frontend/openspec/spec.md`
  - 验收方式：一次性场景试跑默认创建为当前时间后数秒执行；开始试跑后关闭配置弹窗，向微信 / QQ 发送接单确认消息，在自动任务页提示结果稍后推送，并保留添加为自动任务入口。
- [x] 15. 国际站首版屏蔽场景任务入口，并修复 review 发现的弹窗可访问性和废弃代码问题。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/src/pages/marketing/openclaw-automations-panel.tsx`、`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`、`frontend/src/pages/marketing/scenario-tasks/ScenarioEnableConfirmModal.tsx`、`frontend/src/pages/marketing/scenario-tasks/ScenarioRunPreview.tsx`
  - 验收方式：`isGlobal` 为 true 时不展示场景任务入口和相关弹窗；新增场景弹窗使用项目 Dialog primitive；旧的等待结果预览组件和文案不再保留。
- [x] 16. 修复微信 / QQ 扫码接入命令一直 pending 时无法展示二维码的问题。
  - 角色：Developer
  - 影响文件：`frontend/src/lib/hermes-cron-client.ts`、`frontend/src/pages/marketing/scenario-tasks/ScenarioInstallModal.tsx`、`frontend/src/lib/__tests__/hermes-cron-client.test.ts`
  - 验收方式：`acli gateway qr-url --platform <platform> --wait true` 通过 `debug/exec` SSE 流式读取 stdout，一旦输出二维码链接就立即展示；关闭、重新生成或手动刷新时会取消旧请求。
- [x] 17. 修复 frontend 分支预览发布器拉取 master runtime 的鉴权失败。
  - 角色：Developer
  - 影响文件：`.ci/frontend-preview.yml`、`.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`
  - 验收方式：预览流水线自举阶段通过 `.ci/init.sh` 的 `ci_git_fetch_origin` 拉取 master runtime，可使用 SSH 或 Git WOA token fallback，不再依赖 CI checkout 的匿名 HTTP `origin`。
- [x] 18. 隔离 frontend 分支预览双产物构建的 Next 缓存。
  - 角色：Developer
  - 影响文件：`frontend/package.json`、`frontend/scripts/clean-next-build-state.mjs`、`.ci/runtime/commands/publish_frontend_preview.sh`、`frontend/scripts/build-release-artifacts.mjs`
  - 验收方式：每次 `build:next`、preview variant 构建和 release artifact 构建前都会清理 `.next`，避免 `cn -> global` 顺序构建复用 webpack cache 导致第二段国际站构建失败。
- [x] 19. 更新 Agent 记忆页的 `MEMORY.md` 说明文案。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/i18n/generated/*.json`
  - 验收方式：`/agents/memory/` 使用新文案，旧文案不再被源码引用，`pnpm i18n:check` 与 `pnpm check` 通过。

- [x] 20. 放宽记忆统计卡片说明文案的单行展示宽度。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/agent-settings-page.tsx`
  - 验收方式：桌面宽屏下 `MEMORY.md` 中文说明保持单行，中小屏仍可自然换行且不产生横向溢出。
- [x] 21. 下线自动任务页的场景任务卡片并保留注释实现。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/openclaw-automations-panel.tsx`
  - 验收方式：自动任务页不再渲染“场景任务”标题、说明和预设场景卡片，相关实现以注释形式保留，模板、添加、已生效任务与最近执行入口保持可用，`pnpm check` 通过。
- [x] 22. 统一存量两要素用户的三要素认证状态文案。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/account-page.tsx`、`frontend/src/pages/marketing/__tests__/account-page-faceid.test.tsx`、`frontend/src/i18n/generated/*.json`
  - 验收方式：`show()` 后，存量 `idcard_2fa` 用户显示“需重新完成认证”，不再显示“待完成手机号认证”；定向测试和 i18n 检查通过。
- [x] 23. 修复无手机号用户创建 FaceID attempt 时的 MySQL 非空约束错误。
  - 角色：Developer
  - 影响文件：`user/auth/internal/service/mysql_store_realname_faceid.go`
  - 验收方式：`current_phone_hash` 在手机号缺失时持久化为空字符串而非 `NULL`；干净用户 MySQL 集成用例和 `user/auth` 全量测试通过。

## 验收重点

- [x] 19. 将国际站 Skills 的搜索控件与搜索结果合并进 Discover。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：Discover 顶部保留搜索、来源和排序控件；有关键词时先展示搜索结果，无关键词时展示分类推荐；分类推荐不受搜索控件影响；移除独立 Search tab，并通过 `pnpm check`、`pnpm i18n:check` 与目标测试。

- [x] 20. 优化 Discover 分类标题和批次导航。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：分类标题不展示结果数量；搜索结果仍展示数量并放大；左右箭头置于分类标题行最右侧，首批禁用左箭头、末批禁用右箭头，切换时 6 张卡片按方向短暂滑动；通过 `pnpm check`、`pnpm i18n:check` 与目标测试。

- [x] 21. 加强 Discover 批次切换动效与箭头按钮样式。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：旧批次完整向对应方向滑出并淡出，新批次从相反方向滑入；导航箭头为略大的圆形按钮，禁用状态保持可见但淡化；通过 `pnpm check` 与目标测试。

- [x] 22. 消除 Discover 批次切换的离场等待。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：新旧两批卡片在同一段动画内交接，不出现旧批次完全离场后的空白等待；通过 `pnpm check` 与目标测试。

- [x] 23. 将 Discover 批次改为连续横向滑轨。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：相邻批次在同一裁切轨道中同步移动，旧批次移动时下一批立即同步露出；轨道外卡片不溢出 Skills 区域；通过 `pnpm check` 与目标测试。

- [x] 24. 将 My Skills 统一为技能卡片网格。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：已安装技能使用与 Discover/Search 相同的两列卡片布局，右侧改为复用现有卸载逻辑的红色垃圾桶按钮；通过 `pnpm check` 与目标测试。

- [x] 25. 用轻量 Gemini SVG 替换技能卡图标。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/public/assets/skills/gemini.svg`
  - 验收方式：Discover/Search/My Skills 技能卡左侧图标替换为 36px 静态 SVG；资源通过缓存 URL 复用，不重复内联；`pnpm check` 和目标测试通过。

- [x] 26. 更新技能卡 Gemini 图标视觉版本。
  - 角色：Developer
  - 影响文件：`frontend/public/assets/skills/gemini.svg`
  - 验收方式：替换为新附件版本，保持技能卡 36px 展示尺寸。

- [x] 27. 微调技能卡图标大小。
  - 角色：Developer
  - 影响文件：`frontend/public/assets/skills/gemini.svg`
  - 验收方式：仅放大 SVG 内部图形，保持外部 36px 卡片占位不变。

- [x] 28. 在 Discover 顶部新增人工运营 Featured 技能区。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/src/i18n/generated/en-US.json`、`frontend/src/i18n/generated/zh-CN.json`、`frontend/src/i18n/generated/zh-to-key.json`
  - 验收方式：搜索结果下方、Research 等分类上方展示 3 张响应式精选卡；固定关联 Self-Improving Agent、Find Skills、Weather 的 skills.sh ID；安装与已安装状态复用现有逻辑；中英文文案、类型检查和目标测试通过。

- [x] 29. 优化 Featured 技能卡视觉比例与安装按钮。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：彩色 Hero 区约占卡片 75%，白色技能信息区约占 25%；Hero 文案底部对齐；安装 CTA 复用技能卡的无框 `+ / ✓` 状态；三种主题使用更强的左上角高光渐变。

- [x] 30. 恢复 Featured 卡片原有总高度。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：总高度恢复至约 224px，仍保持彩色区与白色区 3:1 比例，并压缩底部内容避免溢出。

- [x] 31. 调整 Featured 卡片比例、主题色和安装数图标。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/src/i18n/generated/en-US.json`、`frontend/src/i18n/generated/zh-CN.json`、`frontend/src/i18n/generated/zh-to-key.json`
  - 验收方式：保持原总高度并改为 2:1 彩色/白色比例；Hero 渐变改为正常饱和色阶，白色文案垂直居中；Featured 标题和副标题更新；安装数使用稍深色 SVG 图标。

- [x] 32. 为 Featured 技能卡接入主题 banner 并收紧卡片高度。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/public/assets/skills/featured-find-skills.jpg`、`frontend/public/assets/skills/featured-self-improving-agent.jpg`、`frontend/public/assets/skills/featured-weather.jpg`
  - 验收方式：三张卡分别使用蓝色参考图、绿色和金色同构 banner；总高度约缩短 10% 且保持 2:1 比例；白色信息区的图标、名称和描述尺寸与普通技能卡一致。

- [x] 33. 为搜索结果增加前 12 条预览和全部/收起切换。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/src/i18n/generated/en-US.json`、`frontend/src/i18n/generated/zh-CN.json`、`frontend/src/i18n/generated/zh-to-key.json`
  - 验收方式：搜索结果超过 12 条时默认仅展示前 12 条，并在“搜索结果”标题行最右侧展示“查看全部”；点击后展示全部结果，按钮变为“收起”，再次点击恢复前 12 条；搜索词、来源或排序变化时重新默认收起。

- [x] 34. 调整搜索结果展开按钮文案和字号。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/src/i18n/generated/en-US.json`、`frontend/src/i18n/generated/zh-CN.json`、`frontend/src/i18n/generated/zh-to-key.json`
  - 验收方式：按钮显示 `View all / Hide all`，中英文按钮字号统一提升为 `text-sm`。

- [x] 35. 扩充 Featured 技能并接入三张主题横幅。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/public/assets/skills/featured-grill-me.jpg`、`frontend/public/assets/skills/featured-summarize.jpg`、`frontend/public/assets/skills/featured-firecrawl-search.jpg`、`frontend/src/i18n/generated/en-US.json`、`frontend/src/i18n/generated/zh-CN.json`、`frontend/src/i18n/generated/zh-to-key.json`
  - 验收方式：Featured 新增 Grill Me、Summarize、Firecrawl Search，均使用正确的 skills.sh ID、独立主题色和横幅；安装状态复用现有技能逻辑，中英文文案和类型检查通过。

- [x] 36. 为 Featured 增加三张一页的左右滑动分页。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
  - 验收方式：Featured 标题右侧显示与分类区一致的左右圆形按钮；每页展示 3 张卡，首尾页对应按钮禁用；切换时复用同一裁切横向滑轨和动效，卡片不溢出到其他区块。

- [x] 37. 修复同名技能按完整 ID 独立安装和展示状态。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/skill-registries.ts`、`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
  - 验收方式：相同短 slug/展示名但不同 `组织/仓库/技能` ID 的卡片使用不同身份 key；点击其中一个只显示该卡安装中/已安装；已安装列表合并不再按短 slug 折叠；目标测试和 `pnpm check` 通过。

- [x] 38. 将 Discover 分类替换为固定运营技能，并增加技能详情弹窗。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/curated-skill-categories.ts`、`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`、`frontend/src/i18n/generated/*.json`、`.agents/skills/lv-sitepage-skills/SKILL.md`
  - 验收方式：Market Analysis、Content Creation、Research、DevTools 各展示用户指定的 6 个 skills.sh 完整 ID；不再调用关键词分类搜索或显示分类左右翻页；点击固定运营卡片可打开包含 Skill Name、One-line Value、Best For、Recommended Input、Output、Why Install 和安装按钮的详情弹窗；中英文文案、目标测试和 `pnpm check` 通过。

- [x] 39. 将固定分类技能详情扩展为完整推荐页结构。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/curated-skill-overviews.ts`、`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/src/pages/marketing/skills-demo/curated-skill-categories.test.ts`、`.agents/skills/lv-sitepage-skills/SKILL.md`
  - 验收方式：24 个固定分类技能均按 What Is This、Who Should Use This、Why Use It、How to Use It 的固定层级展示独立概述、用户类型、问题、能力、基本用法和示例提示词；点击卡片可打开详情并安装；测试和类型检查通过。

- [x] 40. 为 Featured 技能复用完整详情弹窗并替换精选技能。
  - 角色：Developer
  - 影响文件：`frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`、`frontend/src/pages/marketing/skills-demo/curated-skill-overviews.ts`、`frontend/src/pages/marketing/skills-demo/curated-skill-categories.test.ts`、`frontend/public/assets/skills/featured-caveman.jpg`、`frontend/public/assets/skills/featured-to-issues.jpg`、`frontend/public/assets/skills/featured-simple.jpg`、`.agents/skills/lv-sitepage-skills/SKILL.md`
  - 验收方式：Featured 六张卡使用用户指定的完整 skills.sh ID；前 3 张保留 Self-Improving Agent、Find Skills、Weather，后 3 张替换为 Caveman、To Issues、Simple；点击卡片主体打开与分类技能相同的完整结构化详情弹窗，安装按钮继续复用现有安装状态；新卡片使用独立主题横幅，测试和类型检查通过。

- 四个场景全部首发。
- 试跑采用一次性执行 + 最近执行，底层复用现有 Cron 能力。
- 试跑结束后可以添加为常态化自动任务。
- 场景器首版只保留微信 / QQ 主动推送；未连接通道时先引导在弹窗内扫码连接，再试跑。
- 已扫码接入微信或 QQ 时，可以把试跑和常态任务结果推送到对应通道。
- 微信 / QQ 扫码接入使用流式 debug/exec，不能用同步等待命令结束的方式阻塞二维码展示。
- 场景试跑下发后立即开始，开始试跑后不阻塞在等待弹窗里。
- 国际站首版不展示场景任务入口。
- 国内站与国际站均不展示场景任务卡片。
- 分支预览发布器能在 CI checkout 的 `origin` 缺少 HTTP 凭证时继续拉取 master runtime。
- 分支预览的国内站和国际站构建互不复用 `.next` / webpack cache。
- 不影响现有模板、添加、编辑、暂停、恢复、删除和最近执行。
