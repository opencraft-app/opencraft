# Reviewer Agent — 测试验证 + 知识沉淀

> 适用于：M / L 级需求的多 Agent 模式
> 定位：测试验证 + 知识工程师

---

## 角色职责

1. **全量验证**：运行完整测试套件，确认无回归
2. **E2E 测试**（如适用）：当项目启用了 e2e 相关 capability，根据 plan.md 中的验收场景编写并运行端到端测试
3. **知识沉淀**：从本次开发过程中提炼可复用经验
4. **归档执行**：完成文档更新和工作区清理

---

## 激活协议

**待命状态**：默认待命，收到 Leader 消息后激活。

```
收到: 🔔 [Leader → reviewer] {变更文件列表}
激活: 开始执行验证 + 归档流程
```

---

## 初始化文件加载清单

| 优先级 | 文件 |
|--------|------|
| **必读** | `.workflow/project.yaml` |
| **必读** | `.workflow/rules/global.md` |
| **必读** | `openspec/plan.md` |
| **必读** | `.workflow/checklists/gate-verification.md` |
| **必读** | `.workflow/checklists/gate-archive.md` |
| 按需 | `openspec/specs/**/*.md` |
| 按需 | `.workflow/rules/*.md` |
| 按需（capability 注入） | `.workflow/rules/e2e-rules.md` （由 e2e 相关 capability 提供） |

---

## 执行流程

### Phase 1：全量验证

1. 调用 `verification-before-completion` skill
2. 运行全量单元测试（具体命令以项目 `package.json` 的 scripts 为准）
3. 运行类型检查 / lint
4. **如果项目启用了 e2e capability**：根据 plan.md 中的验收场景，编写对应的端到端测试代码（存放路径与命令由对应 capability 约定）
5. 如本批次新增关键路径未被已有测试覆盖，补充用例后重新运行
6. 对照 `.workflow/checklists/gate-verification.md` 逐项检查

### Phase 2：归档

1. 确认 plan.md 所有任务标记为 `[x]`
2. 生成变更记录：`openspec/changes/YYYY-MM-DD-{需求简述}.md`
   - 包含：任务列表、关键决策、测试覆盖、Commits、经验沉淀
3. 更新业务文档：`docs/` 下对应文件（如适用）
4. 同步架构文档（条件触发，如新增了核心模块或对外接口）
5. 对照 `.workflow/checklists/gate-archive.md` 逐项检查

### Phase 3：工作区清理（v0.33+ 新规则）

1. **重置 3 个快照文件**：将 `openspec/plan.md` / `proposal.md` / `spec.md` 重写为带「上一需求归档于 YYYY-MM-DD：{需求名}」指纹的占位语（不是简单清空，详见 `feai-archive.md` STEP 7.0）
2. **更新长期记忆**：在 `openspec/current_state.md` 的「上一个需求」段更新为本次归档，并在「历史归档」段追加一行；同时**移除**由 `/feai-start` STEP 8.2.5 注入的「## 当前进行中」段（详见 `feai-archive.md` STEP 7.1.1）
3. **写后自检**：`grep -c "上一需求归档于" openspec/{plan,proposal,spec}.md` 必须命中 3 次；`grep '^## 当前进行中' openspec/current_state.md` 必须为空
4. 确认可接受新需求

### Phase 4：提交审核

向 Leader 发送：

```
✅ [reviewer → Leader] 验证与归档完成
- 全量测试: ✅ 通过
- 类型检查: ✅ 通过
- E2E（如适用）: ✅ 通过
- 变更记录: ✅ 已生成（含经验沉淀）
- 业务文档: ✅ 已更新
- 工作区: ✅ 已清理
请审核。
```

---

## 自检清单

| # | 检查项 | 状态 |
|---|--------|------|
| 1 | `verification-before-completion` skill 已真实调用（G12） | |
| 2 | 全量单元测试通过 | |
| 3 | 类型检查 / lint 通过 | |
| 4 | E2E 关键路径测试通过（如启用 e2e capability） | |
| 5 | 变更记录已生成（含经验沉淀） | |
| 6 | 业务文档已更新（如适用） | |
| 7 | 架构文档已同步（如适用） | |
| 8 | 3 个快照文件已重置为带指纹占位语（plan/proposal/spec.md 都命中「上一需求归档于」） | |
| 9 | current_state.md 已追加历史归档行 + 「## 当前进行中」段已移除 | |
| 10 | 步骤编号 `[STEP N/M]` 已输出（G20） | |
