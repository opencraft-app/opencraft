# Gate: 规划阶段门禁

> 在进入实现阶段（编码）之前，必须对照本 checklist 逐项自检。
> 全部通过才能进入下一阶段。

---

## 一、需求理解（必须）

- [ ] 已与用户确认需求范围与边界（不在范围内的需求已明确排除）
- [ ] 已识别需求规模：S / M / L（参见 `.workflow/project.yaml` 的 `workflow.size_levels`）
- [ ] 已按 `.workflow/rules/flow-cost.md` 的唯一路由顺序记录规模触发理由；信息不足不能直接判为 L
- [ ] 已识别此需求是否依赖未实现的前置依赖（如新接口、新设计稿、新基础组件）
- [ ] 用户验收标准已写入 `openspec/proposal.md` 或 plan.md 顶部

---

## 二、上下文加载（必须）

- [ ] 已读取 `.workflow/project.yaml`，确认工作流模式与规模分级
- [ ] 已加载 P0 文件（参见 `.workflow/project.yaml` 的 `context_loading.P0`）
- [ ] 已按需读取 `.workflow/project.yaml`，识别项目当前技术栈与公共组件清单
- [ ] 已按 `.workflow/rules/flow-cost.md` 判定 S/M/L 流程强度（review / archive / metrics）；S 级门禁可 quick 降级
- [ ] 普通已有页面的文案、样式、间距或小交互调整未误触发 Figma；只有设计稿还原需求才进入 Figma 能力
- [ ] 计划确认后已初始化/刷新 `.workflow/runtime/current-task.summary.md`（首批 active slice + planHash/branch）
- [ ] 如涉及只读调查 / 追问反证，已按 `.workflow/rules/agent-dispatch.md` 明确 Investigation Brief 与验证预算
- [ ] 已确认是否有相关已存在 Spec（避免重复设计）

---

## 三、规划产物（必须）

- [ ] `openspec/plan.md` 已生成（M / L 级需求强制要求）
- [ ] plan.md 中至少有一条 `- [ ]` 任务项
- [ ] 任务数匹配真实工作量，**未过度拆解**（单个 bug / 小需求不得展开成十几个任务；相邻可合并子任务已合并）
- [ ] 每个任务都标注：所属角色 / 实际影响文件（仅作归属与验证证据）/ 验收方式
- [ ] L 级需求：已识别需要派发给哪些 Agent（leader/implementer/developer/reviewer）
- [ ] 多人 / 多 Agent 需求已规划文件归属，且共享状态文件只有单写者
- [ ] 不在 plan.md 范围内的修改已明确排除

---

## 四、技术方案（中大型需求必须）

- [ ] 已选择主要技术方案（如选 Redux 还是 Context、选 Tailwind 还是 CSS Module）
- [ ] 已识别 2-3 个备选方案并简述取舍理由
- [ ] 已确认方案不会引入额外的重型依赖（包大小、维护成本）
- [ ] 已考虑边界场景（空态 / 错误态 / 加载态）

---

## 五、能力声明（v0.9.0+）

- [ ] 已确认本次需求是否需要某个 capability（如 `figma-fidelity` / `e2e-playwright`）
- [ ] 如需 capability 但未启用，已通过 `feai cap enable <id>` 启用
- [ ] 已知晓本次任务受哪些 capability 提供的规则约束

---

## 门禁结论

- [ ] **通过**：所有必须项已满足，可进入实现阶段
- [ ] **打回**：存在阻塞性问题，需补充信息或重新规划
- [ ] **有条件通过**：列出未完成项 + 推迟到何时补齐

**结论**：________
**理由**：________
