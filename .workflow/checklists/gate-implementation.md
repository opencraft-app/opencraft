# Gate: 实现阶段门禁

> 实现阶段每完成一个任务（plan.md 中的一条 `- [ ]`）后，对照本 checklist 自检。
> 全部任务都通过才能进入验证阶段。

---

## 一、范围控制（必须）

- [ ] 本次改动严格限定在 plan.md 已声明的范围内
- [ ] 未在 plan.md 范围内的"顺手改"已被记录或撤销（不允许偷偷加塞）
- [ ] 改动文件列表已与 plan.md 任务对应

---

## 二、代码质量（必须）

- [ ] 代码通过 ESLint / Prettier / TypeScript 类型检查
- [ ] 没有 `console.log`（`console.error` 用于错误日志可保留）
- [ ] 没有未使用的导入 / 变量 / 注释掉的死代码
- [ ] 类型定义完整，没有滥用 `any`
- [ ] 复杂逻辑有中文注释说明意图

---

## 三、组件 / 函数设计（按需）

- [ ] 单文件不超过 300 行；超过的已按职责拆分
- [ ] Props 传递不超过 3 层；超过的已使用 Context 或全局状态
- [ ] 重复代码已抽取为公共组件 / 工具函数
- [ ] 命名清晰（组件 PascalCase / hook use 前缀 / 常量 UPPER_SNAKE_CASE）

---

## 四、错误与边界（必须）

- [ ] 异步操作有 try-catch 或 .catch()
- [ ] 数据展示组件处理了 loading / error / empty / success 四态
- [ ] 用户输入有合法性校验
- [ ] 未静默吞掉错误（无空 catch 块）

---

## 五、可访问性 & 性能（必须）

- [ ] `<img>` 有 alt 属性；图标按钮有 aria-label
- [ ] 大列表使用 `React.memo` 或虚拟滚动
- [ ] 重复计算使用 `useMemo`；事件回调按需 `useCallback`
- [ ] 图片使用 `loading="lazy"`

---

## 六、能力扩展门禁（v0.9.0+）

> 如启用了某个 capability，对应的额外门禁会在以下位置查看：
> - figma-fidelity: `.workflow/checklists/gate-figma-implementer.md`
> - e2e-playwright: 验证阶段 `gate-e2e.md`
>
> 启用 capability 后，本 checklist 与对应专项 checklist 必须同时通过。

- [ ] 已查阅本次需求涉及的 capability 专项 checklist
- [ ] capability 专项 checklist 全部通过

---

## 七、本地自验（必须）

- [ ] 改动相关页面在本地 dev server 可正常加载
- [ ] 关键交互路径已手动跑通一遍
- [ ] 未引入新的运行时报错或警告

---

## 门禁结论

- [ ] **通过**：所有必须项已满足，可进入验证阶段
- [ ] **打回**：存在阻塞性问题，需返工
- [ ] **有条件通过**：列出未完成项 + 修复计划

**结论**：________
**理由**：________
