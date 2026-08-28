# 国际站 Agent 与页脚问题修复设计

## 范围

- 国际站英文构建中，`/agents` 与 `/agents/[section]` 的静态页面标题使用 `My Agent`；切换语言后标题跟随运行时语言，中文为 `我的智能体伙伴`。
- `/agents` 左侧菜单在国内站和国际站都保留 24px 底部空间，避免最后一项贴近容器底部。
- 国际站页脚“相关产品”新增 `Tencent EdgeOne`，外链固定为 `https://edgeone.ai/`。

## 方案

Agent 路由继续使用 Next.js 静态 `metadata` 提供区域默认标题，并由应用壳根据 `i18next` 当前语言同步唯一的 `<title>` 节点；这样英文首屏为 `My Agent`，切换中文后也不会被 Next head 管理重新覆盖成英文。侧栏在既有 `.lv-agents-sidebar` 上增加底部内边距，不改变导航分组或点击行为。页脚复用现有 `FooterLink` 外链模型，不新增组件或依赖。

## 验收

- global 路由默认 metadata 为 `My Agent`，cn 路由 metadata 保持中文；国际站运行时切换中英文后 title 与 `<html lang>` 同步，且 head 中只有一个 title。
- 侧栏 CSS 明确包含 24px 底部空间，桌面和移动端共用。
- 国际站页脚展示 `Tencent EdgeOne`，链接在新窗口安全打开；国内站不增加“相关产品”栏目。
- 定向 Vitest、`pnpm check`、`pnpm i18n:check`、`git diff --check` 和国际站浏览器 smoke 通过。
