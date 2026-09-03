---
name: feai-native
description: FE-AI Native 工作流。当用户启动新需求（/feai-start、/feai-native、提到 native 模式）、需要继续一个进行中的 change，或 AGENTS.md 含 FE-AI:native-resume 块时使用。引擎驱动 shape→build→verify→archive 四阶段，方法论由你自主决定。
---

# FE-AI Native 工作流

本 skill 与引擎 `scripts/engine.mjs` 配合工作。引擎负责状态与边界；你负责理解、实现、验证。

## 铁律

1. 一切推进经过引擎命令；**禁止**手写/手改 `.workflow/native/` 下任何文件（state.yaml、current.json、.lock）。
2. 每条命令返回 `continuation`：`continue` 直接继续；`await-user` 停下来向用户提指定问题；`blocked` 按 findings 修复或求助；`done` 收尾汇报。
3. **方法论自由**：不强制 Plan/TDD/Debug/Review 任何套路，按需求风险自决。但证据必须真实——brief/report 不许编造，verify 必须实际运行过验证命令。
4. 不引用 superpowers、不读写 `openspec/`。
5. 同一时刻只有一个 active change；开工前先 `status`。

## 命令

以下 `ENGINE` 指本 skill 目录下的 `scripts/engine.mjs`（也可直接用全局 `feai native <cmd>`，等价）。

| 命令 | 用途 |
|---|---|
| `node ENGINE new --name <kebab-slug> --json` | 启动 change（有 active 会被拒） |
| `node ENGINE status --json` | 当前状态 + continuation（开工/恢复第一步） |
| `node ENGINE next --summary "..." [--outcome pass\|fail --signature <tag>] [--report "..."] [--confirmed] [--expect-revision N] --json` | 推进 |
| `node ENGINE archive --json` | 归档（仅在用户明确要求后） |

退出码：0 正常（含 await-user）/ 64 用法错误 / 65 状态无效 / 73 锁或 revision 冲突（重试）/ 75 repair 停止。细则见 `references/commands.md`。

**幂等**：同一参数的请求可安全重试（中断恢复场景）。返回含 `replayed: true` 表示"返回的是上次存储的结果"——凡 `replayed: true` 均非新推进（无论 phase 是否变化），应意识到上次请求已生效过。

## 阶段契约

### shape — 想清楚
- 获取需求：TAPD 链接 → 读 `../team-extensions/tapd-requirement-fetch.md`；文字描述 → 直接澄清。
- 澄清目标、成功标准、范围、约束；现场调查相关代码（有 code graph 类工具可用则用）。
- 写 `brief.md`：需求、方案、关键上下文发现、验证口径。
- `next --summary` → 引擎要求用户批准（`approval-required`）：向用户展示 brief 摘要并请确认 → 用户同意 → `next --confirmed`。
- **批准后 brief 再被改动，hash 漂移，引擎会要求重新批准**——不要悄悄改需求。

### build — 做
- 按 brief 实现；任务拆分与工作笔记自决（可在 change 目录写 `plan.md`）。
- 完成时 `next --summary "做了什么、打算怎么验证"`。

### verify — 验证
- 实际运行验证（测试/构建/lint/手工），把执行的命令、结果、遗留风险写进 `report.md`。
- 通过：`next --outcome pass --report "验证结论摘要（详见 report.md）" --summary "..."`——pass **必须带 `--report`**（引擎对 verify 步有 `require_field: report`，缺了会被 await-user 拦下）。
- 失败：`next --outcome fail --signature <短标签> --summary "..."`——fail 是回退、不查 guards，**不需要 `--report`**，但 `--signature` 必传，标记失败类别（如 `login-test-timeout`）：
  - 同签名连续 2 次 → 引擎警告（继续，但注意换思路）
  - 连续 3 次 → **停止（75）**：有新假设时可 `--confirmed` override 一次，否则停下来找用户
  - 累计 12 次 → 硬停，必须找用户

### archive — 归档
- verify pass 后进入 archive 阶段，引擎返回 `await-final-action`。**等用户明确说归档**，再运行 `archive`。
- 完成后向用户汇报：需求摘要、验证结论、遗留事项。

## 团队约定

commit 规范、分支命名、MR 与 CR、TAPD 与用量上报、终端输出与上下文预算、多 Agent 协作的团队约定，统一见 `references/team-conventions.md`；涉及对应动作前必读。
