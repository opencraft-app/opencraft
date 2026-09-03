---
name: unit-test-development
description: '团队扩展 Skill - 单元测试开发，整合 TDD 理念和团队单测规范'
---

# 单元测试开发规范

## 概述

此 Skill 整合团队的单元测试规范和最佳实践；是否采用 TDD 由你按需求风险自决（native 工作流不强制方法论）。

## 适用场景

1. **TDD 开发**：在编写功能代码前，先编写测试用例（推荐）
2. **补充测试**：为现有代码补充单元测试
3. **测试维护**：修改或优化现有测试用例

---

## 技术栈

> 以下为推荐配置，实际以项目 `package.json` 中的依赖为准。
> 请参考 `AGENTS.md` 中的「测试约定」章节获取项目具体配置。

| 项目     | 说明                                              |
| -------- | ------------------------------------------------- |
| 测试框架 | 从项目 `package.json` 自动探测（Jest / Vitest 等）|
| 项目框架 | 从项目 `package.json` 自动探测（React / Vue 等）  |
| 语言     | TypeScript (优先) / JavaScript                    |
| 测试库   | @testing-library/react 或项目已有测试工具         |

---

## 目录结构规范

测试文件必须放在 `__tests__` 目录下，与被测文件同级：

```
src/
├── pages/
│   └── user-list/
│       ├── components/
│       │   └── UserTable/
│       │       ├── index.tsx           ← 被测文件
│       │       └── __tests__/          ← 测试目录
│       │           └── index.test.tsx  ← 测试文件
│       ├── hooks/
│       │   ├── useUserList.ts
│       │   └── __tests__/
│       │       └── useUserList.test.ts
│       └── utils/
│           ├── formatter.ts
│           └── __tests__/
│               └── formatter.test.ts
```

---

## TDD 开发流程（推荐）

推荐遵循 **RED-GREEN-REFACTOR** 循环，视需求复杂度灵活选择：

1. 🔴 **RED**：先写测试，描述期望行为，运行确认测试失败
2. 🟢 **GREEN**：写最少的代码让测试通过
3. ♻️ **REFACTOR**：优化代码，确保测试仍然通过，补充边界用例

> 💡 具体的 TDD 节奏和代码示例由你按项目测试框架与需求复杂度自行把握。

---

## 核心规范

### 断言有效性

- ✅ 所有断言必须验证代码的**实际输出或副作用**
- ❌ 禁止形式化断言（如 `expect(true).toBe(true)`）
- ❌ 禁止循环论证（如 `expect(func()).toBe(func())`）
- ❌ 禁止仅检查存在性而不验证值

### 边界场景覆盖

每个函数**必须覆盖**以下边界场景：

| 场景类型     | 测试用例示例                                | 优先级 |
| ------------ | ------------------------------------------- | :----: |
| **空值输入** | `null`, `undefined`, `''`, `[]`, `{}`       | 🔴 高  |
| **极值输入** | `Number.MAX_VALUE`, `Number.MIN_VALUE`, `0` | 🔴 高  |
| **业务边界** | 最小/最大金额、日期范围、权限边界           | 🔴 高  |
| **类型边界** | 字符串最大长度、数组最大元素数              | 🟡 中  |
| **格式边界** | 特殊字符、Unicode、换行符                   | 🟡 中  |

### Mock 数据规范

- ✅ Mock 数据必须符合**真实业务场景**，禁止无意义占位数据
- ✅ Mock API 响应必须符合接口规范（包含 code、message、data 结构）
- ✅ 必须覆盖正常和异常两种 Mock 场景

### 测试命名规范

- ✅ 使用**中文描述**（推荐）
- ✅ 顶层 `describe` 使用被测模块/函数名
- ✅ `test` 描述应清晰表达期望行为

```typescript
describe('formatDate', () => {
  test('空输入应该返回空字符串', () => {});
  test('应该正确格式化标准日期', () => {});
  test('格式无效时应该抛出异常', () => {});
});
```

---

## 覆盖率要求

| 指标       | 最低要求 | 权重 |
| ---------- | :------: | :--: |
| 语句覆盖率 |   80%    | 0.40 |
| 分支覆盖率 |   70%    | 0.35 |
| 函数覆盖率 |   80%    | 0.20 |
| 行覆盖率   |   80%    | 0.05 |

**整体覆盖率** = (语句×0.4) + (分支×0.35) + (函数×0.2) + (行×0.05)

运行覆盖率检查的具体命令以项目 `package.json` 中的 `scripts` 为准。

---

## 与其他 Skills 的协作

```
shape 阶段（任务拆分，写 brief.md）
         │
         ▼
┌─────────────────────────────────────┐
│  unit-test-development (本 Skill)   │
│  ├─ 🔴 RED: 先写测试（推荐）        │
│  ├─ 🟢 GREEN: 实现功能              │
│  └─ ♻️ REFACTOR: 优化重构           │
└─────────────────┬───────────────────┘
         │
         ▼
   build 实现 → git commit（参考 ai-usage-tracking 的 FE-AI 标记规范 + `../feai-native/references/team-conventions.md` 的「commit 规范」）
```

---

## 参考资料

- 📖 [Jest 官方文档](https://jestjs.io/docs/getting-started)
- 📖 [Vitest 官方文档](https://vitest.dev/guide/)
- 📖 [Testing Library 文档](https://testing-library.com/docs/react-testing-library/intro)
- 📖 项目 `AGENTS.md` 中的「测试约定」章节
