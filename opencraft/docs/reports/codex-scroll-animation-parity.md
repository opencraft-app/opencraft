# r3562 滚动动画：控制时序与执行起点

日期：2026-09-08。接续 `codex-response-placement-selection.md`。

## 区分测试偏差与实现偏差

原测试两个独立 Page 分别输入、分别等待 RAF、分别采样。其中一侧部分用按钮，
另一侧用 API。即使两侧都运行原版 Codex，仍出现最大 400px 瞬间差异；
因此此前报告的 186px 不能直接归因为 Vela 动画实现。

仅改成同页面 iframe 也不够：Playwright 虚拟 RAF 在不同 document 中存在不同
相位。现在测试在模块加载前统一到父页面 RAF 和 performance 时间原点，
在一次调用中输入并用 flushSync 提交内容，在一次调用中采样两侧。
两侧尺寸、内容、样式一致；每帧断言距离、高度、留白、锚点、渲染行及跟随状态。

对比模式使用相同 API 和合成 wheel 意图；真实按钮和 compositor wheel
仍由 `smoke-conversation-scroll.ts` 覆盖，不把合成输入冒称为真实操作。
`CODEX_SCROLL_REAL_CLOCK=1` 或 `CODEX_SCROLL_INPUT=visible-button` 仅作非受控
时序诊断，其瞬间差异不是严格逐帧一致性结论。

## 修复的实际实现差异

原版 ThreadScrollLayout 的 Ge 在贴底命令开始时读取 u(element)。Vela 原先读取
上次确认距离。浏览器位置已变化、scroll 尚未送达时，缓存不是正确动画起点。

修复后命令取当前平台距离，保留 24px 立即贴底阈值和 260ms 三次 ease-out。
控制器仍拥有跨事件的已确认距离；布局保持与命令开始采样不是同一个责任。

三个先失败再通过的用例：确认距离 0/实际 800、确认 400/实际 800、
确认 400/实际 20。浏览器另覆盖同一任务内改变物理位置并立即贴底。

## 结果与范围

- 原版/原版控制和原版/Vela 对照各通过 143 事件边界、2364 对采样帧；
  最大几何差异均为 0px，渲染行、phase/follow 断言通过。
- 192 项单测、Web 类型检查通过。
- 真实滚动 smoke、连续提交测试通过；仍有 2 次暂态 ResizeObserver 通知告警，
  无空闲循环。未声称告警消除。

后续已定位并修正这两次告警的观察范围越界，见
`codex-resize-observer-ownership.md`。上面的两次告警是修正前的记录。

证据针对 r3562 提取的控制器/虚拟列表/回答策略原版函数体，在共同 renderer、
依赖和受控时序下成立，不是完整 Codex 产品、所有设备的等价证明。本次未发布。
