# `/feai-init` — 初始化项目索引级上下文

> 在 `feai install` 之后运行，用只读探测把索引级事实写入 `.workflow/project.yaml`；`AGENTS.md` 已有项目上下文节时同步刷新。
> 只探测稳定且探测成本高的事实：项目标识、包管理器、测试/构建/lint 命令、monorepo 划分。
> 易变的目录/路由/组件等结构细节不探测、不写入——AI 需要时现场查询代码，保证上下文不过期。

---

## 命令格式

```bash
/feai-init [--dry-run]
```

| 参数 | 说明 |
|---|---|
| 无参数 | 只读分析项目，把索引级事实写入 `.workflow/project.yaml`；`AGENTS.md` 已有项目上下文节时同步刷新其中的索引级事实。 |
| `--dry-run` | 只输出计划写入内容，不改文件。 |

历史兼容：如果用户输入 `--agents`、`--section`、`--context` 或 `--specs`，提示“深度上下文与 specs 生成已随 Classic 退役”，改为执行默认的索引级探测；禁止为适配旧参数而重写 `AGENTS.md` 或生成 openspec 产物。

---

## 硬约束

- 禁止越界扫描 `projectRoot` 之外的目录。
- 禁止编造未在代码中实际存在的命令、包划分或项目标识。
- 禁止探测或写入目录/路由/组件等易变结构细节——这些由 AI 按需现场查询。
- 只允许写入 `.workflow/project.yaml` 的索引级字段与 `AGENTS.md` 的项目上下文节；其它文件一律不改。
- 探测不到的字段写 `<待用户补充>`，不凭经验补全。
- 以下编号只描述流程结构，不要求运行时逐步输出；只读探测应批量执行。

---

## 5 步流程

### 阶段 1：路径基准

用脚本解析 `<base>`，不手写 `projectRoot` 公式：

```bash
feai workflow project-root --json
```

`projectRoot` 为空或 `.` 时，`<base>` 为仓库根；否则 `<base>` 为仓库根下的对应子目录。后续读取、扫描和写入都限定在 `<base>`。

### 阶段 2：读取配置

只读加载 `<base>` 下存在的配置：

- `package.json`（含 `packageManager` 与 `workspaces` 字段）
- monorepo 配置（pnpm-workspace.yaml / lerna.json / turbo.json 等）
- 测试 / 构建 / lint 相关配置（Jest / Vitest / ESLint 等，仅用于确认命令真实存在）
- README 或已有项目文档（仅用于佐证项目标识）

读取结果只作为事实来源；不把配置文件全文复制进产物。

### 阶段 3：索引级事实探测

只探测以下索引级事实：

- 项目标识：项目名、仓库地址、默认分支
- 包管理器：按 lockfile 与 `package.json` 的 `packageManager` 字段判定（pnpm / npm / yarn）
- 测试 / 构建 / lint 命令：按 `package.json` 的 `scripts` 与包管理器拼接
- monorepo 划分：workspaces / pnpm-workspace 的包边界（只写包路径与一句话用途，不写包内结构）

结构细节（目录划分、页面、模块内部构成等）一律不探测、不写入——AI 需要时现场查询代码。
大型仓库优先读取清单文件与关键索引，避免全量灌入上下文。

### 阶段 4：写入 project.yaml 与 AGENTS.md

更新 `.workflow/project.yaml` 的索引级字段（`name` / `repository` / `default-branch` / `package-manager` / `commands` / `monorepo` / `generated-at`），其余内容不动；`generated-at` 刷新为当前时间。

`AGENTS.md` 存在项目上下文节时，把同一组索引级事实同步刷新进该节；没有该节则不新建。

用户手工补充的内容应保留；自动探测字段可按最新代码覆盖更新。

### 阶段 5：输出总结

输出：

```text
✅ 初始化分析完成

路径基准: <base>
project.yaml 索引级事实: 已更新 / dry-run
AGENTS.md 项目上下文节: 已更新 / 跳过 / dry-run

需要用户确认:
  - <待用户补充> 字段
  - AI 无法从配置确定的事实
```

---

## 合并策略

| 文件 | 策略 |
|---|---|
| `.workflow/project.yaml` | 只改索引级字段；其余内容与注释原样保留。 |
| `AGENTS.md` | 只刷新项目上下文节中的索引级事实；其余节与 managed 块不动。 |
| `openspec/`（如存在） | 不读写。它是历史业务档案，init 不再生成 specs。 |
| `.workflow/native/**` | 不写。init 不碰运行时状态。 |

---

## 与其他命令的关系

```text
feai install
  ↓
/feai-init（可选，刷新索引级事实）
  ↓
/feai-start <需求>
  ↓
按 feai-native skill 的 continuation 推进
```

`/feai-init` 沉淀的是稳定、低变的索引级事实；当前需求状态由 feai-native 运行时（`.workflow/native/`）承载。
