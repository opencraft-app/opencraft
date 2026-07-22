# `/feai-init` — 初始化项目上下文

> 在 `feai install` 之后运行，用只读分析结果补齐项目上下文。`AGENTS.md` 保持薄入口，不再写入业务目录、路由、API、状态树或代码风格长表；项目深度信息统一写入 `.workflow/project.yaml` 的 `context:` 段、`openspec/current_state.md` 项目地图和 `openspec/specs/**`。

---

## 命令格式

```bash
/feai-init [--context | --specs | --dry-run]
```

| 参数 | 说明 |
|---|---|
| 无参数 | 分析项目，更新 `.workflow/project.yaml` `context:` 段、`openspec/current_state.md` 项目地图，并新增缺失的 `openspec/specs/**`。 |
| `--context` | 只更新 `.workflow/project.yaml` 的 `context:` 段和 `openspec/current_state.md` 项目地图。 |
| `--specs` | 只生成缺失的 `openspec/specs/**` 模块规范。 |
| `--dry-run` | 只输出计划写入内容，不改文件。 |

历史兼容：如果用户输入 `--agents` 或 `--section`，提示“AGENTS 深度信息已废弃”，改为执行 `--context` 的只读分析；禁止为适配旧参数而重写 AGENTS。

---

## 硬约束

- 禁止越界扫描 `projectRoot` 之外的目录。
- 禁止编造未在代码中实际存在的模块、路由、API、组件或命令。
- 禁止把业务深度上下文写入 `AGENTS.md`。
- 禁止覆盖已有 `openspec/specs/*.md`；只新增缺失模块，除非用户明确指定覆盖。
- 只允许写入 `.workflow/project.yaml` 的 `context:` 段、`openspec/current_state.md` 项目地图和 `openspec/specs/**`。
- 探测不到的字段写 `<待用户补充>`，不凭经验补全。
- 以下编号只描述流程结构，不要求运行时逐步输出；只读探测应批量执行。

---

## 6 步流程

### 阶段 1：路径基准

用脚本解析 `<base>`，不手写 `projectRoot` 公式：

```bash
feai workflow project-root --json
```

`projectRoot` 为空或 `.` 时，`<base>` 为仓库根；否则 `<base>` 为仓库根下的对应子目录。后续读取、扫描和写入都限定在 `<base>`。

### 阶段 2：读取配置

只读加载 `<base>` 下存在的配置：

- `package.json`
- `tsconfig.json` / `jsconfig.json`
- ESLint / Prettier 配置
- Vite / Webpack / Jest / Vitest 配置
- monorepo 配置
- README 或已有项目文档

读取结果只作为事实来源；不把配置文件全文复制进产物。

### 阶段 3：结构扫描

只扫描 `<base>` 下的前端源码和包目录，识别：

- 入口与初始化链路
- 路由结构
- 状态管理
- API / service 层
- 公共组件
- 功能模块边界
- 测试与验证命令

大型仓库优先读取目录索引和关键入口文件，避免全量灌入上下文。

### 阶段 4：生成 context 与项目地图草案

更新 `.workflow/project.yaml` 的 `context:` 段，保留其它 workflow 配置不动；同时生成/更新 `openspec/current_state.md` 项目地图。

`project.yaml context:` 建议结构：

```yaml
context: |
  # 项目概述
  ...

  # 技术栈
  ...

  # 常用命令
  ...

  # 入口与初始化
  ...

  # 路由结构
  ...

  # 状态管理
  ...

  # API 请求层
  ...

  # 公共组件
  ...

  # 模块索引
  ...

  # 待用户补充
  ...
```

用户自定义子段应保留；自动生成子段可按最新代码覆盖更新。

`current_state.md` 用于低频项目地图，建议保留：

- 项目概览
- 顶层结构
- 核心模块索引
- 架构边界与约束
- 常用入口与关键链路

禁止在 `current_state.md` 写入需求历史、上一个需求摘要或当前会话状态。

### 阶段 5：生成缺失 specs

为识别到但尚无 spec 的核心模块新增 `openspec/specs/<module>.md`。

每个 spec 至少包含：

- 概述
- 页面 / 路由
- 核心组件
- 数据流
- 业务规则
- 待用户补充

已有 spec 默认只读，不覆盖。

### 阶段 6：输出总结

输出：

```text
✅ 初始化分析完成

路径基准: <base>
project.yaml context: 已更新 / dry-run
current_state 项目地图: 已更新 / dry-run
新增 specs:
  - openspec/specs/<module>.md
  - ...

需要用户确认:
  - <待用户补充> 字段
  - AI 无法从代码确定的业务规则
```

---

## 合并策略

| 文件 | 策略 |
|---|---|
| `AGENTS.md` | 不修改。它只是薄入口和索引。 |
| `.workflow/project.yaml` | 只改 `context:` 段；其它段原样保留。 |
| `openspec/current_state.md` | 更新低频项目地图；不写需求历史、上一个需求或会话状态。 |
| `openspec/specs/*.md` | 缺失则新增；存在则不覆盖。 |
| `.workflow/runtime/**` | 不写。init 不是会话恢复流程。 |

---

## 与其他命令的关系

```text
feai install
  ↓
/feai-init
  ↓
/feai-start
  ↓
/feai-review
  ↓
/feai-archive
```

`/feai-init` 沉淀的是长期项目事实；当前需求状态仍由 `openspec/plan.md` 和 `.workflow/runtime/current-task.summary.md` 承载。
