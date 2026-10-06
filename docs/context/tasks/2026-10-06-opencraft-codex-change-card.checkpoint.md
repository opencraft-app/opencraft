## stage
Web 资源卡实施完成；用户已授权提交、推送、合入 master 和预览。隔离分支基于最新 master 的完整 gate 已通过，提交/替换进行中。

## verified
- Web tsc、平台/字体边界、资源/Review 单测 11 例通过。
- 实际 Conversation + Composer live resource + Review 四组合通过，活跃工作、稳定 DOM、流式 Review、完成与恢复正确。
- Codex 最新真实 token 为 radius-lg 10px，text-base14，chat-sm=chat-1，toolbar28px，头部12px内距/10px间距；初始按 Tailwind 默认推算的8px圆角已纠正为主题值。
- 最终卡片浏览器矩阵 12 组全部通过，截图 `/tmp/opencraft-codex-change-card-5XmInz`，人工检查了中文窄屏及英文暗色悬浮预览。
- 487 项 chat 回归、Web 类型、平台/字体边界及最终 Web 生产构建通过；既有 diff 布局 8 组合通过。文档链接/变更影响检查通过。
- 子项点击前显式关闭受控 live Tooltip，键盘 ArrowDown 进入文件列表/Enter 查看并关闭测试通过；不绕过真实 actionability。
- 窄屏 fixture 的 min-content 栅格已改为 minmax(0,1fr)，实际卡片最大宽度和 viewport overflow 断言通过。
- 减少动态效果遵循全局 0.01ms 无感知过渡规则，不错误要求 computedStyle 必须字面为 0s。

## unverified
- macOS Codex 原产品不能在本机执行；未做 Safari/真机/Native 卡片像素验收，不宣称 100% 运行时像素一致。
- Review 沿用本产品真实只读能力，没有实现 Codex apply-patch 撤销/重做或重建 Changes 工作区。
- 当前 80 端口仍旧预览；后续已获得提交/推送/master/预览授权，但生产/GitOps 不在范围内。

## discard
- 不再使用旧文件代码图标、Review 卡片文案、隐藏零值、56px/p8/gap12/r12 样式。
- 不把固定资源重建为 transcript Item，不给两个 Conversation presenter 各建 live UI。

## restore
- checkout `/data/mono2-ssh-native-integration-vYgvJx`；保留其他未提交改动和前任务资源分离修复。
- `turn-diff-resource.tsx` 拥有卡片/悬浮/展开；App 的 ComposerTurnChangeSummary 唯一呈现指定 active Turn，document context identity 抑制主/mini transcript 重复。
- 80 端口未重启，仍旧 hunyuan preview；新代码只在独立 Vite/Chromium fixture 验证。

## next_action
提交隔离分支、推送并合入 master；打包并启动独立候选验收，然后由独立 supervisor 切换、健康检查和失败回退。重连后核对实际服务，不以提交切换任务代替成功。

## authorized_delivery
- Router 查询 `OpenCraft commit push merge master changed file card active resource folding self hosted preview switch` 无匹配，随后只核对当前 Task Pack、相关 diff、build-matrix headless 章节及既有预览来源记录。
- 隔离分支以 `f1aa35cc2277b4f799b246449a9bde5a6283b48c` 为基线；选取卡片、共享资源分离依赖、相应测试和设计记录，共 34 个路径。原脏工作树未暂存、重置或修改。
- master 已包含线上桌面控制、动效和听写，无需夹带旧工作树的模型配置迁移；旧预览目录和数据保留。
- 隔离树自行安装 lockfile 依赖及固定 DSH/Codex runtime，不借用其他工作树的 node_modules。
- 完整 `npm run gate` exit 0，包含全 workspace 类型、相关测试、Web 和 Expo Web/iOS JS bundle；不是原生 IPA 验收。
- 集成后卡片 18 组通过（320/390/1000px，亮/暗/Frost 扩展主题，中/英），检查真实 computed 颜色、几何、键盘、减少动态效果；资源生命周期 4 组、既有布局 8 组通过。截图 `/tmp/opencraft-codex-change-card-I0FrRE`，人工检查中文窄屏 Frost。
- staged docs-impact 与 diff check 通过，文档校验 errors/warnings 均为空。已按 staged diff 检查现存 Git 凭据无匹配，不输出任何值。
