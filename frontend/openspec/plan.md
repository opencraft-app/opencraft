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

## 验收重点

- 国内站与国际站均不展示场景任务卡片。
- 分支预览发布器能在 CI checkout 的 `origin` 缺少 HTTP 凭证时继续拉取 master runtime。
- 分支预览的国内站和国际站构建互不复用 `.next` / webpack cache。
- 不影响现有模板、添加、编辑、暂停、恢复、删除和最近执行。
