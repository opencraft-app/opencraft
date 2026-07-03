# 大同 AI 埋点 Skill（datong-ai-tracker）

> **v2** —— 大同数据能力一站式技能。帮用户完成「埋点代码接入」和「指标看板创建」两大能力。

---

## v2 简介

相比 v1，v2 做了 **4 项核心改造**：

1. **3 主线 + 1 收尾的分流模型**：
   - **B 路径**（从零开始接入）—— 默认主流程，业务初始化场景
   - **A 路径**（流程单接入）—— 深度使用场景
   - **C 路径**（看板独立）
   - **D 路径**（联调收尾）
2. **删除「埋点信息码（Datong_XXXX）」路径**：v1 的 `get_dt_tracking_info` 工具已废弃
3. **Plan 必须 + Checklist + state.json 续跑**：任务中断后能从断点接上
4. **md 产物保留 + 导入只走 mcp**：所有产物集中在 `{项目根}/dt_tracking_plan/`

> 📖 完整方案 → [`OPTIMIZATION_PROPOSAL_v2.md`](./OPTIMIZATION_PROPOSAL_v2.md)
> 📖 详细使用 → [`SKILL.md`](./SKILL.md)

---

## 目录结构

```
datong-ai-tracker/
├── SKILL.md                         # Skill 主入口（v2 改造版）
├── OPTIMIZATION_PROPOSAL_v2.md      # v2 优化方案完整文档
├── README.md                        # 本文件
│
├── references/                      # 详细参考文档
│   ├── tracking-plan.md             # B 路径主文档（从零开始）
│   ├── flow-doc-tracking.md         # A 路径主文档（流程单）
│   ├── execution-plan.md            # Plan 必须范本
│   ├── code-generation.md           # 代码生成详细规则（A 路径专用）
│   ├── mcp-tools.md                 # MCP 工具接口说明
│   ├── sdk-detection.md             # SDK 检测规则
│   ├── app-registration.md          # appkey 检测与注册
│   ├── custom-specs.md              # custom-specs 读取合并规则
│   ├── custom-styles.md             # custom-styles 读取合并规则
│   ├── realtime-debug.md            # 可视化联调独立指令
│   ├── mcp-init.md                  # MCP 环境初始化
│   ├── test-data-link.md            # 样例数据测试
│   ├── api-report.md                # API 上报兜底
│   └── tracking-table-format.md     # 埋点事件表格格式
│
├── dashboard/                       # 看板子 skill
│   ├── dashboard.md
│   └── references/...
│
├── sdk/                             # 各平台 SDK 文档
│   ├── h5/...
│   ├── android/...
│   ├── ios/...
│   └── mp/...
│
├── scripts/                         # 工具脚本
│   └── mcp-caller.py                # MCP 工具 Python 兜底
│
├── custom-specs/                    # 业务自定义指标/埋点方案规范（外部扩展点）
├── custom-styles/                   # 业务自定义上报代码风格（外部扩展点）
├── hooks/                           # skill hooks
├── tools/                           # 上报工具
├── trackmate/                       # trackmate 平台相关
│
└── 附：业务如何扩展埋点 Skill 能力.md   # 业务方使用指引
```

---

## 关键概念

| 概念 | 说明 |
|------|------|
| **入口（entry）** | 4 种入口：B=from-scratch（默认）/ A=flow-doc / C=dashboard / D=debug |
| **state.json** | 流程状态机文件，存放在 `{项目根}/dt_tracking_plan/` |
| **Checklist 4 维度** | 必读 / 必产物 / 必上报 / 必校验 |
| **Plan 必须** | 任务开始前 Agent 先输出计划，等用户确认后才进入主流程 |
| **dt_tracking_plan/** | 项目级产物目录（含 state.json / 方案 md / events.json / 代码） |
| **schema_version** | state.json 的版本号（v2 = "2.0"） |
| **custom-specs/** | 业务方自定义的指标/埋点方案规范（plugin 形式） |
| **custom-styles/** | 业务方自定义的上报代码风格（plugin 形式） |

---

## 入口识别速查

| 用户输入 | 入口 |
|---------|------|
| "做埋点" / "从零开始" / "新项目埋点" / "规划埋点" | **B（默认主流程）** |
| "流程单 XXX" / "flowId XXX" / 粘贴带 `flowId=` 的 URL | A |
| "做看板" / "指标" / "Dashboard" | C |
| "联调" / "debug" | D |

> ⚠️ 用户输入模糊时**默认走 B**。

---

## 快速开始

### 1. 加载 Skill

在 Claude Code / CodeBuddy 中加载本 Skill：

```
/skill datong-ai-tracker
```

### 2. 触发场景

| 场景 | 触发词 |
|------|--------|
| 业务初始化 | "帮我做埋点"、"新项目接入大同" |
| 流程单 | "按流程单 55073 接入埋点" |
| 看板 | "帮我做个活跃用户看板" |
| 联调 | "开启可视化联调" |

### 3. 完整流程

```
用户输入
  ↓
Stage 0：Plan 必须（输出计划 + 写 state.json + 获用户确认）
  ↓
Stage 1：MCP 环境检查（必过）
  ↓
Stage 2：SDK 检测 + appkey 接入
  ↓
Stage 2b：custom-specs 前置读（B 路径）
  ↓
Stage 3-5：方案设计 + 用户 ack
  ↓
Stage 6-7：代码落盘 + 导入 mcp
  ↓
Stage 8：链路检测 + 样例数据（B 路径）
  ↓
Stage 9：看板生成（B 路径）
  ↓
Stage 10：引导联调
```

> 📖 详细步骤 → `SKILL.md` §「路径 B/A/C/D」

---

## v1 → v2 迁移指引

> ⚠️ **v1 → v2 是破坏性升级**。本节说明 v1 用户如何平滑迁移到 v2。

### 迁移影响范围

| 维度 | v1 行为 | v2 行为 | 迁移影响 |
|------|---------|---------|----------|
| 入口 | 模糊问"流程单还是从零" | **B 默认**，A 流程单独立 | 行为变更，需熟悉新入口 |
| 埋点信息码 | 支持 `get_dt_tracking_info` | ❌ **完全删除** | v1 用户的 `Datong_XXXX` 全部失效 |
| 方案上传 | `upload_tracking_plan`（上传 md） | ❌ **完全删除** | 改为 `import_tracking_data`（上传 JSON） |
| 方案产物 | md 上传后用户本地无副本 | md 落盘到 `dt_tracking_plan/` 给用户看 | ✅ 改进，方案可归档 |
| 计划模式 | 直接执行 | **Plan 必须**（先输出计划，等用户确认） | ⚠️ 行为变更 |
| 续跑 | 上下文记忆 | **state.json 断点续跑** | ✅ 改进 |
| 路径数量 | A 流程单 + B 从零 | B（默认）+ A（独立）+ C + D | ⚠️ 路径重新组织 |

### 迁移步骤

#### Step 1：备份 v1 产物

v1 用户的 `dt_tracking_plan/` 目录可能有历史方案 md，**保留不动**（v2 兼容 v1 的 md 格式）。

v1 用户的 `dt_tracking_info/` 和 `dt_page_structure/` 目录（如果有）也**保留不动**。v2 不再生成新数据，但历史数据可以读：

- `dt_tracking_info/`（埋点信息码） → 已废弃，仅历史
- `dt_page_structure/`（标准版页面结构） → 已废弃，仅历史
- `dt_tracking_plan/`（方案 md） → **继续使用**

#### Step 2：升级 Skill

```
# 重新加载 skill
/skill datong-ai-tracker
```

加载后会自动：
- 入口识别改为 v2 逻辑（B 默认）
- 禁用 `get_dt_tracking_info` / `upload_tracking_plan`
- 启用 Plan 必须 + Checklist + state.json

#### Step 3：v1 → v2 的 state.json 兼容

v1 没有 `state.json` 概念。**v2 不会主动读 v1 的"上下文"**。

如果用户在 v1 跑到一半切到 v2：
- v2 会读 `dt_tracking_plan/state.json`
- 找不到 → 视为新任务，提示用户"未发现历史任务，从头开始？"
- 找到但 `schema_version` 不是 `"2.0"` → 提示用户"skill 升级过，请重做"

> 💡 建议 v1 用户**主动清场**：在 v2 第一次执行前，删除旧的临时文件，重新开始。

#### Step 4：历史 `Datong_XXXX` 的处理

v1 用户的 `Datong_XXXX` 埋点信息码**全部失效**：
- v2 不会再用 `get_dt_tracking_info` 解析这些信息码
- 业务方需要**主动从 v1 迁移到 v2 的流程单模式**（A 路径）

**迁移方案**：
1. 在 trackmate 平台上找到对应的「流程单」或「需求单」
2. 用 v2 的 A 路径重新接入：
   ```
   用户：「按流程单 55073 接入埋点」
   ```
3. v2 会自动拉 `get_flow` 拿到变更，**不需要埋点信息码**

如果 v1 的 `Datong_XXXX` 没有对应的流程单/需求单：
- 这部分历史埋点**无法迁移**到 v2
- 建议保留 v1 的代码不动，仅新功能走 v2

#### Step 5：旧的 `upload_tracking_plan` 路径处理

v1 的"埋点方案上传（md）"在 v2 中改为：
- md 落盘到 `dt_tracking_plan/` 给用户看
- 导入走 `import_tracking_data`（md → JSON → mcp）

**业务方影响**：
- v1 的 trackmate 平台上传入口**已废弃**
- 改为 v2 的 `import_tracking_data`（自动调，无需手动）
- 用户可以前往 trackmate 平台查看导入结果（链接：`https://trackmate.woa.com/#/d/repRegistry/allnode?appId={appId}&trackTerminal=multiFrontend`）

### 升级检查清单

- [ ] 已备份 v1 的 `dt_tracking_plan/` 历史方案
- [ ] 已确认 v1 的 `Datong_XXXX` 是否能映射到流程单（不能映射的需要保留 v1 代码）
- [ ] 已重新加载 v2 skill
- [ ] 已删除旧的临时 state.json（如有）
- [ ] 第一次任务**默认会走 B 路径**（不需要明确说"从零开始"）
- [ ] 已熟悉 Plan 必须模式（任务开始前会输出计划等确认）
- [ ] 已熟悉 state.json 续跑模式（任务中断后说"继续"）

### 回滚方案

如果 v2 出现严重问题需要回滚到 v1：
- v1 的代码在 git HEAD：`git checkout HEAD~1 -- skills/datong-ai-tracker/`
- 联系大同小秘评估 v2 修复方案

> ⚠️ 回滚后 v2 的所有新功能（Plan 必须、state.json 续跑）会失效。

---

## 常见问题（FAQ）

### Q1：v2 为什么不支持 `Datong_XXXX` 埋点信息码？

A：v1 的 `Datong_XXXX` 实质是"流程单的别名"，用户需要主动去 trackmate 平台找代码，再粘贴到对话。v2 改为：

- A 路径直接拉 `get_flow` 拿到流程单变更
- 用户只需要粘贴 URL（含 `flowId=`）或 `flowId`
- AI 自动解析，**不再需要埋点信息码**

这种改造**减少用户的"找码 + 粘贴"动作**，但对老用户不友好（历史 `Datong_XXXX` 失效）。

### Q2：为什么 B 路径是默认？

A：业务方接入大同埋点的典型顺序是：

1. **新项目上线** → 走 B 路径"从零开始规划指标体系"（首次接触）
2. **产品迭代** → 走 A 路径"按流程单补埋点"（深度使用）

B 路径是入口频率最高、用户首次接触必经的路径，因此作为默认主流程。

### Q3：state.json 放项目目录会污染吗？

A：不会。`dt_tracking_plan/` 是**项目级目录**，每个项目独立，不会跨项目污染。Skill 目录保持干净。

### Q4：如何续跑中断的任务？

A：用户说"继续"或任何业务关键词 → Agent 读 `dt_tracking_plan/state.json` → 校验：
- `schema_version == "2.0"`
- `resumable == true`（7 天内）
- 入口匹配

匹配成功 → 从 `current_step` 继续。

### Q5：Plan 必须模式怎么关闭？

A：两种方式：
1. 用户指令："直接干" / "跳过 Plan" → 本次任务跳过
2. 配置文件 `.datong-skill-config.json` 中 `plan_required: false`（未来扩展）

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [SKILL.md](./SKILL.md) | Skill 主入口 |
| [OPTIMIZATION_PROPOSAL_v2.md](./OPTIMIZATION_PROPOSAL_v2.md) | v2 优化方案完整文档（946 行） |
| [references/tracking-plan.md](./references/tracking-plan.md) | B 路径主文档（从零开始） |
| [references/flow-doc-tracking.md](./references/flow-doc-tracking.md) | A 路径主文档（流程单） |
| [references/mcp-tools.md](./references/mcp-tools.md) | MCP 工具接口说明 |
| [dashboard/dashboard.md](./dashboard/dashboard.md) | 看板子 skill |
| [附：业务如何扩展埋点 Skill 能力.md](./附：业务如何扩展埋点 Skill 能力.md) | 业务方使用指引 |

---

## 反馈与支持

- **问题反馈**：联系大同小秘
- **Skill 升级**：关注项目仓库的 CHANGELOG
- **API 文档**：https://trackmate.woa.com
