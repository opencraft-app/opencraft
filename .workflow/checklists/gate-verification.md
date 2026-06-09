# Gate: 验证阶段门禁

> 实现阶段全部任务完成后，进入验证阶段。本 checklist 检查代码已经写完，但是否真的"能交付"。
> 全部通过才能进入归档阶段（提交 / 提 MR / 关闭 plan）。

---

## 一、单元测试（按需）

> 单元测试不是所有项目都要求；以 plan.md 中的任务声明为准。

- [ ] 涉及的工具函数 / 自定义 hook / 业务逻辑已编写单元测试
- [ ] 单测覆盖率达到项目要求（默认建议：行覆盖 ≥ 70%、分支覆盖 ≥ 60%）
- [ ] 单测断言有效（无 `expect(true).toBe(true)` 之类的形式化断言）
- [ ] Mock 数据贴近真实业务场景，不使用占位符

---

## 二、E2E 测试（启用 e2e-playwright capability 时必须）

> 详细要求见 `.workflow/checklists/gate-e2e.md`（capability 提供）。

- [ ] P0 级关键路径 E2E 测试全部通过
- [ ] 新增功能的 E2E 场景已实现
- [ ] 测试用例标题包含优先级标签（@p0 / @p1 / @p2）

---

## 三、视觉回验（启用 figma-fidelity capability 时必须）

> 详细要求见 `.workflow/checklists/gate-figma-implementer.md`（capability 提供）。

- [ ] 已通过 Playwright MCP 截图与 Figma 截图对比
- [ ] 视觉差异 ≤ 5px 且无元素缺失
- [ ] 视觉回验结果已追加到对应 spec 文件

---

## 四、回归测试（必须）

- [ ] 改动周边的页面 / 功能未受影响
- [ ] 关键用户路径仍可正常工作
- [ ] 控制台无新增报错或警告

---

## 五、文档与配置（按需）

- [ ] 涉及配置变更已同步到 `openspec/spec.md` 或 README
- [ ] 新增依赖已写入 package.json，版本号合理
- [ ] 公共 API / hook 的入参变更已通知调用方

---

## 六、Git 检查（必须）

- [ ] commit message 符合 Conventional Commits + 中文描述格式
- [ ] 不在 master 直接提交（已切到 feat / fix 分支）
- [ ] 无敏感信息（API Key / Token）被提交

---

## 门禁结论

- [ ] **通过**：所有必须项已满足，可进入归档阶段
- [ ] **打回**：存在质量问题，需补充修复
- [ ] **有条件通过**：列出后续跟进项（如"E2E 留待下个迭代补齐"）

**结论**：________
**理由**：________
