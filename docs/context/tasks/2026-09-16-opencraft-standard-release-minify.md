## goal

保留 OpenCraft release 的标准生产压缩，移除导致 Electron Renderer 白屏死循环的 ultra 压缩与二次高强度混淆。

## non_goals

- 不取消 Oxc minify、内容哈希或 release 打包。
- 不改变 AppServer、DSH、Hermes 或产品路由。

## requirement_refs

- 用户：“不要混淆了”；随后明确“要 MINIFY，但是可能 ultra 是不太行了，降一档”。

## interface_refs

- `OPENCRAFT_RELEASE_MINIFY=standard` 选择 release 命名与 source-map 策略。
- `build.minify: "oxc"` 是唯一 Renderer 压缩层。
- Electron Main/Preload/Daemon 保持 esbuild bundle，不再运行 `javascript-obfuscator`。

## history_context

- ultra 模式额外启用顶层名称改写、多轮 aggressive compress，并对 Electron host 再执行 high-obfuscation preset。

## acceptance

- release 仍然压缩，且不包含 ultra/toplevel/sequences/maxIterations 或 Electron 二次 obfuscator。
- release 测试与 Electron release build 通过。
- 打包后的 Renderer 完成加载、DevTools 可响应且不持续占用 CPU。

## affected_paths

- `opencraft/package.json`、`package-lock.json`
- `opencraft/apps/workbench-web/vite.config.ts`
- `opencraft/tests/workbench-web-release.test.mjs`
- release/build 文档。

## required_context

- OpenCraft maintenance context；沿用当前 Task Pack 的宿主/Renderer 所有权。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/apps/workbench-web/vite.config.ts` | Renderer build owner | 区分标准与 ultra 压缩 |
| `opencraft/scripts/obfuscate-electron-host.mjs` | 二次混淆 owner | 删除 high-obfuscation 链 |
| `opencraft/tests/workbench-web-release.test.mjs` | release contract | 防止 ultra 回归 |

## evidence

- ultra 打包版 Renderer 持续约 99–100% CPU，DOM/DevTools Runtime 无响应；关闭窗口时的 `ERR_FAILED (-2)` 是 loadURL 被中止的次生错误。
- 同源码普通 Oxc build 正常加载，Renderer CPU 约 0%。
- 改为 standard 后 `test:web-release` 9/9、`build:electron:release` 通过。
- 基于最终并行工作区重新完整打包后，standard preview 完成到 `ready=complete`，路由进入本地 draft，DevTools 返回标题 `OpenCraft`、Electron 平台和实际页面文本；Renderer CPU 约 0.3%，不再白屏。产物位于 `opencraft/apps/workbench-electron/release/preview/mac-arm64/OpenCraft Preview.app`。

## risks

- 产物比 ultra 稍大、源码结构更容易分析；以运行正确性优先，源代码和 source map 仍不随公开发布树分发。

## validation

- release contract、Electron release build、macOS preview package、真实 packaged Renderer DOM/CPU。

## decisions

- 采用标准 Oxc minify，不采用“完全不压缩”，也不保留不可预测的 high-obfuscation。

## scan_scope

- release scripts、Vite build options、Electron host obfuscator 及 release test。

## handoff

- 实现和 packaged runtime 验证完成；未提交、未发布。
