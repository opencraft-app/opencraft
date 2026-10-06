## goal

让 iOS Expo 智能体抽屉可从主内容近乎全宽区域右滑打开，同时保持纵向滚动和轻微触摸稳定。

## non_goals

- 不改抽屉外观、账号页返回手势或 Bot 业务逻辑。
- 不提交、推送或发布。

## requirement_ids / requirement_refs / requirement_excerpt

- 本会话用户：「我希望侧边栏可以几乎全屏触发」。

## interface_refs / data_structure_refs

- `opencraft/apps/workbench-expo/src/components/mobile-bot-host.ios.tsx`：`ReanimatedDrawerLayout` 的 `edgeWidth`、`minSwipeDistance`。
- 安装版 `react-native-gesture-handler/src/components/ReanimatedDrawerLayout.tsx`：关闭时 `edgeWidth` 定义左侧命中宽度；其 Pan 以水平位移激活、竖向位移失败。

## history_context

- 当前抽屉只有左侧 24 dp 可触发；主内容使用本地 DOM 或 OpenCraft RN Chat。

## acceptance

- 抽屉关闭时，从主内容约 90% 宽度的区域右滑可打开。
- 轻微水平抖动不打开抽屉；纵向滚动仍优先。
- Expo 类型检查和 iOS bundle 通过。

## affected_paths

- `opencraft/apps/workbench-expo/src/components/mobile-bot-host.ios.tsx`、`opencraft/docs/mobile-shell.md`。

## required_context

- Context Router 无匹配 Pack；已在 Expo 抽屉文件和安装版手势库源码做有界精确搜索。

## context_receipt

- 已读根与 Expo 局部 `AGENTS.md`、`opencraft/docs/mobile-shell.md` 和安装版 `ReanimatedDrawerLayout.tsx` 的命中范围。

## handoff

- 已把关闭时的右滑命中宽度改为当前窗口的 90%，水平激活位移改为 18 dp；保留安装版手势库的竖向失败阈值。
- Expo typecheck、iOS bundle、`git diff --check`、文档校验和 staged change-impact 通过。现有 Expo Go 外部 manifest 轻量核验通过；按用户要求没有下载完整 bundle。
- 尚未由 iPhone 实际测试手势与横向内容竞争；没有提交、推送或发布。
