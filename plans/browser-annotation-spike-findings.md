# 浏览器批注：空实现调研结论

分支 `spike/browser-annotation`。骨架已打通类型：`browser-core/annotation.ts`（类型）、
preview-bridge 新增 `annotate-pick` / `annotate-highlight`（运行时抛 `ANNOTATION_NOT_IMPLEMENTED`）、
远程 worker 白名单放行、`BrowserSurfaceHost.annotate?()` 可选能力。tsc 全部通过。

## 矛盾点 / 不确定性

| # | 问题 | 依据 | 影响 / 待定 |
|---|---|---|---|
| U1 | 点击坐标对不上用户看到的帧 | worker `encode-frame` 只带 `timestamp`，不带滚动位置或帧 id；页面在出帧和点击之间滚动会选错元素 | 需要 worker 给帧打 scroll/epoch 标签，或接受“按当前页面状态选” |
| U2 | 页内高亮会被编进视频流，也会改 DOM | 远程浏览器是 offscreen `paint` → 编码；高亮注入 DOM 后 agent 截图、`inspect` revision 都受影响 | **已定**：页内叠层（preload + closed shadow root，`annotation-overlay` 命令），随页面合成、滚动；bridge 的 `inspect` 和 revision 忽略它；agent 截图**保留**框，让 agent 看到用户指的元素。实测见 `smoke-annotation-overlay.mjs` |
| U3 | iframe 不覆盖 | bridge 只注入 `wc.mainFrame`，桌面端同样只装主文档 | P1 只做主 frame，跨 frame 返回明确错误 |
| U4 | selector 稳定性 | 页面重渲染、shadow DOM、hash 类名都会让 selector 失效 | anchor 以 role/name/text + rect 为主，selector 只作参考 |
| U5 | 坐标换算 | `force-device-scale-factor=1`、移动仿真 dsf=1，但 `zoom` 走 `setZoomFactor`，CSS px ≠ 帧 px | pick 前需按 zoom 换算，或在页内用 `elementFromPoint` 前除以 zoom |
| U6 | 源码位置 | 没有现成的 `data-oc-source` 注入 | 只对自家 dev 构建有意义，P1 返回 `null` |
| U7 | 消息里怎么表达批注 | composer `ContentBlock` 无批注类型；`contentBlocksToPrompt` 把 resource 拍平成 markdown 链接 | 新增 block 类型要改所有穷举 switch；或用 text + attachment 编码。需拍板 |
| U8 | 脱敏 | `fill` 拒绝敏感控件，但 anchor.text 会带出密码框附近文本 | pick 必须复用 `inspect` 的脱敏逻辑 |
| U9 | SPA 内跳转 | worker 只在非 in-place 主 frame 导航时换 generation；SPA 路由不换 | anchor 的 `revision` 只能做弱校验 |

## 类型层的小坑（已修）

`PreviewBridgeCallMap` 参数要求 `Record<string, unknown>`，`interface` 没有索引签名会报错，
请求参数改成 `type` 别名。

## 建议的决策顺序

1. U7（消息表达）和 U2（高亮放哪）先定，决定改动面。
2. U1/U5 决定 pick 准确性，做真实现前先在 worker 加帧标签实验。
3. U3/U6 明确不在 P1。
