# 账号页模型积分使用率颜色分级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让账号页模型积分使用率的百分比文字与进度条按四档统一着色，并在高使用率时区分展示“即将用尽”和“已用尽”的模型配置提示。

**Architecture:** 保留现有 `usedPercent` 计算，在账号页组件内新增单个共享颜色变量；百分比文字和进度条填充共同消费该变量。提示直接读取 `usedPercent` 与 `credit_available`，使用现有 `AppLink` 进入模型页；通过现有账号页渲染测试覆盖颜色和提示边界，不引入公共抽象或依赖。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- `< 50%` 使用 `var(--lw-accent)`。
- `50%–79%` 使用 `#C67B1E`。
- `80%–95%` 使用 `#CF3D4C`。
- `> 95%` 使用 `#991B1B`；由于显示值为整数，该档对应 `96%–100%`。
- 百分比文字和进度条填充色必须一致。
- `usedPercent <= 95` 不显示模型积分提示。
- `usedPercent > 95` 且 `credit_available > 0` 显示“模型积分即将用尽，为避免智能体停止响应，请尽快配置自有模型”，仅“配置自有模型”可点击。
- `credit_total > 0` 且 `credit_available <= 0` 显示“模型积分已用尽，如未配置自有模型，智能体将无法继续响应。立即配置模型”，仅“立即配置模型”可点击。
- `credit_total <= 0` 不显示积分进度或模型积分提示。
- 两种链接都进入 `/agents/models`；不显示使用率小数。
- 不改变积分计算、进度宽度、接口或其他套餐行为。
- 不新增依赖；新增文案通过仓库 i18n 脚本提取、批量翻译和生成，不手工修改 hash 映射。
- 先 RED、再最小实现、再 GREEN；未经用户单独确认，不执行 commit、push 或 MR。

---

### Task 1: 统一积分使用率的四档颜色

**Files:**
- Modify: `src/pages/marketing/account-page.tsx:868-1008`
- Test: `src/pages/marketing/__tests__/account-page-name-audit.test.tsx`

**Interfaces:**
- Consumes: `usedPercent: number`，范围由现有计算限制在 `0–100`。
- Produces: 组件内 `creditUsageColor: string`，同时供百分比文字 `color` 与进度条 `background` 使用。

- [x] **Step 1: 写入失败的边界渲染测试**

在 `account-page-name-audit.test.tsx` 中增加表驱动测试，使用总积分 `100` 和不同 `credit_available` 生成 `49 / 50 / 79 / 80 / 95 / 96` 六个显示值：

```tsx
it.each([
  { usedPercent: 49, expectedColor: "var(--lw-accent)" },
  { usedPercent: 50, expectedColor: "#C67B1E" },
  { usedPercent: 79, expectedColor: "#C67B1E" },
  { usedPercent: 80, expectedColor: "#CF3D4C" },
  { usedPercent: 95, expectedColor: "#CF3D4C" },
  { usedPercent: 96, expectedColor: "#991B1B" },
])("uses $expectedColor for $usedPercent% credit usage", ({ usedPercent, expectedColor }) => {
  activePass = {
    ...buildActivePass(),
    credit_total: 100,
    credit_available: 100 - usedPercent,
  };

  const { container } = renderAccountPage();
  const percentage = screen.getByText(`${usedPercent}%`);
  const progressFill = container.querySelector<HTMLElement>(`[style*="width: ${usedPercent}%"]`);

  expect(percentage).toHaveStyle({ color: expectedColor });
  expect(progressFill).not.toBeNull();
  expect(progressFill).toHaveStyle({ background: expectedColor });
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/account-page-name-audit.test.tsx --api.host 127.0.0.1
```

Expected: 新增用例在 `49% / 50% / 79% / 96%` 至少一项失败；失败原因是百分比与进度条尚未使用统一四档颜色。

- [x] **Step 3: 写入最小实现**

在 `usedPercent` 后增加共享颜色变量，并替换百分比与进度条的独立判断：

```tsx
const creditUsageColor = usedPercent > 95
  ? "#991B1B"
  : usedPercent >= 80
    ? "#CF3D4C"
    : usedPercent >= 50
      ? "#C67B1E"
      : "var(--lw-accent)";
```

```tsx
<span className="text-xs font-semibold" style={{ color: creditUsageColor }}>
  {usedPercent}%
</span>
```

```tsx
style={{
  width: `${usedPercent}%`,
  background: creditUsageColor,
}}
```

- [x] **Step 4: 运行定向测试并确认 GREEN**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/account-page-name-audit.test.tsx --api.host 127.0.0.1
```

Expected: `account-page-name-audit.test.tsx` 全部通过，包含新增的六个颜色边界用例。

- [x] **Step 5: 运行质量门禁和差异检查**

Run:

```bash
cd frontend
pnpm check
cd ..
git diff --check -- frontend/src/pages/marketing/account-page.tsx frontend/src/pages/marketing/__tests__/account-page-name-audit.test.tsx frontend/openspec/plan.md frontend/openspec/changes/2026-08-29-account-credit-usage-colors-design.md frontend/openspec/changes/2026-08-29-account-credit-usage-colors-implementation-plan.md
```

Expected: 类型检查通过，`git diff --check` 无输出。

- [x] **Step 6: 浏览器 smoke**

在可用的账号页预览中验证 `95%` 保持红色、`96%` 变为深红色，且百分比与进度条同色。若无法构造对应登录态或积分数据，则以渲染测试作为边界验收证据，并明确记录浏览器验证限制。

- [x] **Step 7: 等待用户确认远端操作**

展示目标文件差异、验证结果和风险。只有用户明确确认后，才执行 `git commit`、`git push` 或创建 MR。

## Result

- RED：新增边界用例在 `49% / 50% / 79% / 96%` 因现有颜色不匹配而失败；`80% / 95%` 保持现有红色并通过。
- GREEN：最小实现后账号页定向测试 26/26 通过。
- Quality gate：`pnpm check` 通过，TypeScript diagnostics 为 207 current / 276 baseline / 0 new；目标文件 `git diff --check` 通过。
- Full suite：使用 `--api.host 127.0.0.1` 启动后，`origin/master` 基线在模型配置、文档摘要、字体、站点用量等无关测试中出现失败并挂起；本次未扩大范围修复。
- Browser smoke：隔离 worktree 没有可直接构造 `95% / 96%` 生产账号数据的登录态，本次以真实组件渲染测试同时验证百分比文字与进度条颜色。
- Remote：未执行 commit、push 或 MR，等待用户单独确认。

---

### Task 2: 增加高使用率模型配置提示

**Files:**
- Modify: `src/pages/marketing/account-page.tsx:870-1030`
- Test: `src/pages/marketing/__tests__/account-page-name-audit.test.tsx`

**Interfaces:**
- Consumes: `usedPercent: number`、`operablePass.credit_available: number`、现有 `AppLink`。
- Produces: 进度条下方的句内提示与 `/agents/models` 链接。

- [x] **Step 1: 写入失败的提示边界测试**

```tsx
it("shows no model prompt at 95% credit usage", () => {
  activePass = { ...buildActivePass(), credit_total: 100, credit_available: 5 };
  renderAccountPage();

  expect(screen.queryByText(/模型积分即将用尽/)).not.toBeInTheDocument();
  expect(screen.queryByText(/模型积分已用尽/)).not.toBeInTheDocument();
});

it("links to model settings when credits are almost exhausted", () => {
  activePass = { ...buildActivePass(), credit_total: 100, credit_available: 4 };
  renderAccountPage();

  expect(screen.getByText(/模型积分即将用尽/).parentElement).toHaveTextContent(
    "模型积分即将用尽，为避免智能体停止响应，请尽快配置自有模型",
  );
  expect(screen.getByRole("link", { name: "配置自有模型" })).toHaveAttribute("href", "/agents/models");
});

it("links to model settings when credits are exhausted", () => {
  activePass = { ...buildActivePass(), credit_total: 100, credit_available: 0 };
  renderAccountPage();

  expect(screen.getByText(/模型积分已用尽/).parentElement).toHaveTextContent(
    "模型积分已用尽，如未配置自有模型，智能体将无法继续响应。立即配置模型",
  );
  expect(screen.getByRole("link", { name: "立即配置模型" })).toHaveAttribute("href", "/agents/models");
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/account-page-name-audit.test.tsx --api.host 127.0.0.1
```

Expected: 两个提示展示用例因页面尚未渲染对应文案而失败，`95%` 无提示用例通过。

- [x] **Step 3: 写入最小提示实现**

在积分进度条后根据余额渲染一个段落：

```tsx
{usedPercent > 95 && (
  <p className="mt-3 text-xs leading-relaxed" style={{ color: "#991B1B" }}>
    {operablePass?.credit_available > 0 ? (
      <>
        {t("模型积分即将用尽，为避免智能体停止响应，请尽快")}
        <AppLink to="/agents/models" className="font-semibold underline underline-offset-2">
          {t("配置自有模型")}
        </AppLink>
      </>
    ) : (
      <>
        {t("模型积分已用尽，如未配置自有模型，智能体将无法继续响应。")}
        <AppLink to="/agents/models" className="font-semibold underline underline-offset-2">
          {t("立即配置模型")}
        </AppLink>
      </>
    )}
  </p>
)}
```

- [x] **Step 4: 运行定向测试并确认 GREEN**

Run:

```bash
cd frontend
pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/account-page-name-audit.test.tsx --api.host 127.0.0.1
```

Expected: 颜色边界与新增提示用例全部通过。

- [x] **Step 5: 运行质量门禁与差异检查**

Run:

```bash
cd frontend
pnpm i18n:extract
pnpm i18n:check
pnpm check
cd ..
git diff --check -- frontend/src/pages/marketing/account-page.tsx frontend/src/pages/marketing/__tests__/account-page-name-audit.test.tsx frontend/src/i18n/generated frontend/openspec/plan.md frontend/openspec/changes/2026-08-29-account-credit-usage-colors-design.md frontend/openspec/changes/2026-08-29-account-credit-usage-colors-implementation-plan.md
```

Expected: 定向测试、i18n 和类型检查通过，目标文件 `git diff --check` 无输出。

- [x] **Step 6: 等待用户确认远端操作**

展示目标文件差异、验证结果和风险。只有用户明确确认后，才执行 `git commit`、`git push` 或创建 MR。

## Task 2 Result

- RED：首次新增提示测试时，“即将用尽”和“已用尽”两个展示用例因页面无对应链接而失败；`95%` 无提示用例通过。
- 已用尽用例使用 `credit_total = 100`、`credit_available = 0`，验证有积分额度的套餐在余额归零时进入已用尽状态。
- GREEN：账号页定向测试 29/29 通过，覆盖四档颜色、95% 无提示、96% 即将用尽、有额度套餐零余额已用尽及两个链接目标。
- i18n：`pnpm i18n:check` 通过；新增文案已覆盖英文、繁体中文、印尼语、西班牙语、日语和韩语，未增加既有翻译欠账。
- Quality gate：`pnpm check` 通过，TypeScript diagnostics 为 207 current / 276 baseline / 0 new / 69 resolved。
- Remote：未执行 commit、push 或 MR，等待用户单独确认。

---

### Task 3: 为模型配置链接增加右箭头图标

**Files:**
- Modify: `src/pages/marketing/account-page.tsx:1028-1050`
- Test: `src/pages/marketing/__tests__/account-page-name-audit.test.tsx:404-434`
- Modify: `openspec/plan.md`

**Interfaces:**
- Consumes: 已有 `ChevronRight`、两处 `AppLink` 和 `/agents/models` 跳转。
- Produces: 两处保持原可访问名称的“文字 + 右箭头”句内链接。

- [x] **Step 1: 写入失败的图标断言**

在“即将用尽”和“已用尽”两个现有用例中分别增加：

```tsx
expect(modelLink).toHaveClass("inline-flex", "items-center", "gap-0.5");
expect(modelLink.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd frontend
pnpm vitest run src/pages/marketing/__tests__/account-page-name-audit.test.tsx --api.host 127.0.0.1
```

Expected: 两个提示用例都因链接中没有 `svg` 而失败；其余用例通过。

- [x] **Step 3: 写入最小图标实现**

两处 `AppLink` 使用相同结构：

```tsx
<AppLink
  to="/agents/models"
  className="inline-flex items-center gap-0.5 font-semibold underline underline-offset-2 transition-opacity hover:opacity-80"
  style={{ color: "inherit" }}
>
  {t("配置自有模型")}
  <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0" />
</AppLink>
```

“已用尽”分支只把文字替换为 `t("立即配置模型")`，图标与链接属性保持一致。

- [x] **Step 4: 运行定向测试并确认 GREEN**

Run:

```bash
cd frontend
pnpm vitest run src/pages/marketing/__tests__/account-page-name-audit.test.tsx --api.host 127.0.0.1
```

Expected: 账号页定向测试 29/29 通过，两处链接仍可按原可访问名称查询。

- [x] **Step 5: 运行质量门禁和本地预览**

Run:

```bash
cd frontend
pnpm check
cd ..
git diff --check -- frontend/src/pages/marketing/account-page.tsx frontend/src/pages/marketing/__tests__/account-page-name-audit.test.tsx frontend/openspec
```

刷新 `http://localhost:5174/account/`，确认无错误覆盖层；若当前账号没有订阅套餐，则以组件渲染测试作为图标状态证据，并记录登录态限制。

- [x] **Step 6: 等待用户确认远端操作**

展示改动与验证结果。未经用户单独确认，不执行 commit、push 或创建 MR。

## Task 3 Result

- RED：两处链接用例都因缺少 `inline-flex / items-center / gap-0.5` 和 SVG 图标而失败，其余 27 个用例通过。
- GREEN：复用账号页已有的 `ChevronRight`，两处链接均增加 `12px`、`aria-hidden="true"` 的右箭头；定向测试 29/29 通过。
- Quality gate：`pnpm check` 通过，TypeScript diagnostics 为 207 current / 276 baseline / 0 new / 69 resolved。
- Local preview：刷新 `http://localhost:5174/account/` 后页面正常、无错误覆盖层和浏览器错误；当前登录账号无套餐，图标状态以组件测试为验收证据。
- Remote：未执行 commit、push 或 MR，等待用户单独确认。

---

### Task 4: 修复零积分套餐误报已用尽

**Files:**
- Modify: `src/pages/marketing/account-page.tsx:874`
- Test: `src/pages/marketing/__tests__/account-page-name-audit.test.tsx:426-456`

- [x] 将已用尽用例固定为 `credit_total = 100`、`credit_available = 0`。
- [x] 新增 `credit_total = 0`、`credit_available = 0` 不显示提示的失败测试，并确认 RED。
- [x] 为 `creditsExhausted` 增加 `creditsTotal > 0` 条件。
- [x] 运行账号页定向测试并确认 GREEN。
- [x] 运行 `pnpm check` 与 `git diff --check`。

## Task 4 Result

- RED：零积分套餐用例因实际渲染“模型积分已用尽”而失败，其余 29 个用例通过。
- GREEN：`creditsExhausted` 仅在套餐总积分大于 `0` 且余额小于等于 `0` 时成立；账号页定向测试 30/30 通过。
- Quality gate：`pnpm check` 与 `git diff --check` 通过，TypeScript diagnostics 为 207 current / 276 baseline / 0 new / 69 resolved。
