# 当前执行计划：LightVela 场景任务安装器 v1

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

## 验收重点

- 四个场景全部首发。
- 试跑采用一次性执行 + 最近执行，底层复用现有 Cron 能力。
- 试跑结束后可以添加为常态化自动任务。
- 场景器首版只保留微信 / QQ 主动推送；未连接通道时先引导在弹窗内扫码连接，再试跑。
- 已扫码接入微信或 QQ 时，可以把试跑和常态任务结果推送到对应通道。
- 微信 / QQ 扫码接入使用流式 debug/exec，不能用同步等待命令结束的方式阻塞二维码展示。
- 场景试跑下发后立即开始，开始试跑后不阻塞在等待弹窗里。
- 国际站首版不展示场景任务入口。
- 分支预览发布器能在 CI checkout 的 `origin` 缺少 HTTP 凭证时继续拉取 master runtime。
- 分支预览的国内站和国际站构建互不复用 `.next` / webpack cache。
- 不影响现有模板、添加、编辑、暂停、恢复、删除和最近执行。
