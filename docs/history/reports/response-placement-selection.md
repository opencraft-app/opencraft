# Web 回答定位策略：显式选择与状态所有权

日期：2026-09-08。后续 Web 策略调整见 [自然贴底选择](web-natural-scroll-policy-switch.md)。

## 本次选择

用户当时明确选择回答定位分支。Web 主入口显式传入
`scrollPolicy="response-placement"`；`ConversationProps.scrollPolicy` 改为必填，
避免遗漏接线时悄悄退回自然模式。自然分支仍作为独立、互斥的基线实现保留，
不与回答定位分支同时取得视口控制权。

这取代当时 Web 选择自然模式的产品决定，
不撤销父子组件、测量事务、滚动控制器和 Composer 高度的所有权拆分。

## 状态边界

- 本地提交的定位快照允许定位时，由回答策略定位；定位完成进入 `static`。
- `prework_watch` 只在工作过程跟随内容溢出且满足既有观测条件时取得 `prework_follow`。
- `prework_follow` 转入最终回答时继承为 `user_follow`；否则转为 `static`。
- 显式贴底取得跟随权；最终正文增长本身不能从 `static` 取得该权利。
- 用户向上滚动超过既有距离阈值时退出相应跟随状态。
- 阶段由协议 Item 的语义决定，不能用正文长度猜测：非 commentary
  agentMessage 出现时就进入 `final_answer`，即使尚未收到首个非空 delta。

本次对照增加了逐事件的 phase/follow 状态断言，发现并删除下游产品阶段分类中的
`text.trim().length > 0` 条件。以前只比较几何位置的测试没有暴露这一差异。

## 验证范围

- 单测涵盖空最终 Item、空 commentary、正文持续增长不接管、贴底接管、向上阅读退出。
- 发布属于单独步骤，本次代码接线不表示已上线。

本次记录：189 项单测和 Web 类型检查通过；滚动 smoke 覆盖连续提交、长 Turn 与恢复。
当时出现 2 次暂态 ResizeObserver 通知告警，未发现空闲循环；后续观察器所有权修正见
[观察器修正](resize-observer-ownership.md)。本记录不代表新的线上验收。
