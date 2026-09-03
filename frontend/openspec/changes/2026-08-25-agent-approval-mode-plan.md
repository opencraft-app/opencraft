# Agent Approval Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a domestic-only Approval Mode selector to Agent Advanced Settings with typed Hermes persistence, confirmation before disabling approvals, and no unnecessary Gateway restart.

**Architecture:** Extend the existing typed common-settings model with one string-union field and a per-field apply policy. Reuse the current snapshot, save, reset, feedback, and unsupported-version paths; render the field as a Radix Select in a new top-level Security group. Keep the existing six settings on their restart-and-reread path while `approvals.mode` uses config-set/unset plus reread only.

**Tech Stack:** React 19, TypeScript 5.9 strict mode, Radix Select, Tailwind CSS v4, Vitest 4, Testing Library, Hermes CLI, generated LightVela i18n dictionaries.

## Global Constraints

- Only the domestic `/agents/settings` page changes; the global build must continue to omit the navigation entry and return 404 for direct access.
- Expose exactly `smart`, `manual`, and `off`; never accept an arbitrary config key, enum value, or shell fragment.
- Switching to `off` requires an explicit destructive confirmation; loading an Agent whose current value is already `off` must not open a dialog.
- `approvals.mode` changes take effect immediately and must not obtain or execute a Gateway restart command.
- Existing memory and context settings must retain their current `config set/unset -> Gateway restart -> reread` behavior.
- Restoring the Security group removes explicit `approvals.mode` and verifies the Hermes default `smart`; it does not restore the LightVela image preset `off`.
- Do not change the Hermes image preset, add other Safety settings, add dependencies, use TypeScript `any`, or broaden the MR beyond Advanced Settings, tests, i18n, and OpenSpec.
- Follow TDD: observe each focused test fail before writing the corresponding production change.
- Before every commit or push, show the exact staged scope and obtain explicit user confirmation as required by the repository instructions.

---

## File Map

**Production files**

- `frontend/src/pages/marketing/agent-common-settings.ts`: owns setting keys, value types, groups, Hermes key mapping, read command, validation, command construction, and apply policy.
- `frontend/src/pages/marketing/agent-common-settings-save.ts`: conditionally restarts Gateway based on the target field's apply policy, then rereads and verifies.
- `frontend/src/pages/marketing/agent-common-settings-reset.ts`: filters unsupported fields and conditionally restarts once when any successfully unset field requires it.
- `frontend/src/pages/marketing/agent-common-settings-panel.tsx`: renders the Security group and controlled Select, manages pending `off` confirmation, and preserves existing concurrency/error behavior.

**Tests**

- `frontend/src/pages/marketing/__tests__/agent-common-settings.test.ts`: typed values, reader, validation, group scope, command allowlist, and apply policy.
- `frontend/src/pages/marketing/__tests__/agent-common-settings-save.test.ts`: immediate save without restart plus regression coverage for existing restart behavior.
- `frontend/src/pages/marketing/__tests__/agent-common-settings-reset.test.ts`: immediate Security reset without restart plus regression coverage for existing groups.
- `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`: three groups, seven rows, select behavior, destructive confirmation, disabled/unsupported states, and reset result.
- `frontend/src/pages/marketing/__tests__/agent-common-settings-page-boundary.test.ts`: unchanged production boundary, rerun as a regression gate.
- `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`: domestic navigation regression.
- `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.global.test.tsx`: global navigation regression.

**Generated i18n files**

- `frontend/src/i18n/generated/zh-to-key.json`
- `frontend/src/i18n/generated/zh-CN.json`
- `frontend/src/i18n/generated/zh-Hant.json`
- `frontend/src/i18n/generated/en-US.json`
- `frontend/src/i18n/generated/id-ID.json`

---

### Task 1: Extend the typed Hermes settings contract

**Files:**
- Modify: `frontend/src/pages/marketing/agent-common-settings.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-common-settings.test.ts`

**Interfaces:**
- Produces: `HermesApprovalMode = "smart" | "manual" | "off"`.
- Produces: `HermesCommonSettingValue = boolean | number | HermesApprovalMode`.
- Produces: `requiresHermesCommonSettingGatewayRestart(key): boolean` for save/reset tasks.
- Extends: `HermesCommonSettingsValues.approvalMode` and group `security`.

- [ ] **Step 1: Add failing contract tests**

Update every snapshot fixture in `agent-common-settings.test.ts` to include `approvalMode: "off"`, then add these assertions:

```ts
it("reads approval mode and keeps security reset scope isolated", () => {
  const command = buildHermesCommonSettingsReadCommand();

  expect(command).toContain('"approvalMode": ("approvals.mode", "smart")');
  expect(command).toContain('field == "approvalMode"');
  expect(getHermesCommonSettingKeysForGroup("security")).toEqual(["approvalMode"]);
  expect(parseHermesCommonSettingsSnapshot(snapshotOutput()).values.approvalMode).toBe("off");
});

it("accepts only the three documented approval modes", () => {
  expect(validateHermesCommonSetting("approvalMode", "smart")).toEqual({ ok: true, value: "smart" });
  expect(validateHermesCommonSetting("approvalMode", "manual")).toEqual({ ok: true, value: "manual" });
  expect(validateHermesCommonSetting("approvalMode", "off")).toEqual({ ok: true, value: "off" });
  expect(validateHermesCommonSetting("approvalMode", "always")).toEqual({ ok: false, reason: "type" });
  expect(validateHermesCommonSetting("approvalMode", true)).toEqual({ ok: false, reason: "type" });
});

it("builds approval commands from the static allowlist", () => {
  expect(buildHermesCommonSettingCommand("approvalMode", "smart")).toBe(
    "hermes config set approvals.mode smart",
  );
  expect(buildHermesCommonSettingUnsetCommand("approvalMode")).toBe(
    "hermes config unset approvals.mode",
  );
  expect(() => buildHermesCommonSettingCommand("approvalMode", "always" as never)).toThrow("invalid");
});

it("marks only approval mode as immediate", () => {
  expect(requiresHermesCommonSettingGatewayRestart("approvalMode")).toBe(false);
  expect(requiresHermesCommonSettingGatewayRestart("persistentMemory")).toBe(true);
  expect(requiresHermesCommonSettingGatewayRestart("compressionThreshold")).toBe(true);
});
```

Also change the existing reader description from “six” to “seven” and add `expect(command).toContain('"approvals.mode"')`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd frontend
pnpm vitest run --config vitest.config.ts --api.host 127.0.0.1 src/pages/marketing/__tests__/agent-common-settings.test.ts
```

Expected: FAIL because `approvalMode`, `security`, and `requiresHermesCommonSettingGatewayRestart` do not exist.

- [ ] **Step 3: Implement the minimal typed contract**

Apply these complete type/mapping changes in `agent-common-settings.ts`:

```ts
export const HERMES_APPROVAL_MODES = ["smart", "manual", "off"] as const;
export type HermesApprovalMode = (typeof HERMES_APPROVAL_MODES)[number];

export const HERMES_COMMON_SETTING_KEYS = [
  "approvalMode",
  "persistentMemory",
  "userProfile",
  "autoCompression",
  "compressionThreshold",
  "compressionTarget",
  "protectedRecentMessages",
] as const;

export type HermesCommonSettingKey = (typeof HERMES_COMMON_SETTING_KEYS)[number];
export type HermesCommonSettingValue = boolean | number | HermesApprovalMode;

export const HERMES_COMMON_SETTING_KEYS_BY_GROUP = {
  security: ["approvalMode"],
  memory: ["persistentMemory", "userProfile"],
  context: [
    "autoCompression",
    "compressionThreshold",
    "compressionTarget",
    "protectedRecentMessages",
  ],
} as const satisfies Record<string, readonly HermesCommonSettingKey[]>;

export interface HermesCommonSettingsValues {
  approvalMode: HermesApprovalMode;
  persistentMemory: boolean;
  userProfile: boolean;
  autoCompression: boolean;
  compressionThreshold: number;
  compressionTarget: number;
  protectedRecentMessages: number;
}

const HERMES_CONFIG_KEY_BY_SETTING: Record<HermesCommonSettingKey, string> = {
  approvalMode: "approvals.mode",
  persistentMemory: "memory.memory_enabled",
  userProfile: "memory.user_profile_enabled",
  autoCompression: "compression.enabled",
  compressionThreshold: "compression.threshold",
  compressionTarget: "compression.target_ratio",
  protectedRecentMessages: "compression.protect_last_n",
};

export function requiresHermesCommonSettingGatewayRestart(
  key: HermesCommonSettingKey,
): boolean {
  return key !== "approvalMode";
}
```

Add approval mode to the embedded Python `fields` and validation:

```py
fields = {
    "approvalMode": ("approvals.mode", "smart"),
    "persistentMemory": ("memory.memory_enabled", True),
    "userProfile": ("memory.user_profile_enabled", True),
    "autoCompression": ("compression.enabled", True),
    "compressionThreshold": ("compression.threshold", 0.5),
    "compressionTarget": ("compression.target_ratio", 0.2),
    "protectedRecentMessages": ("compression.protect_last_n", 20),
}

def valid_value(field, value):
    if field == "approvalMode":
        return isinstance(value, str) and value in ("smart", "manual", "off")
    if field in ("persistentMemory", "userProfile", "autoCompression"):
        return isinstance(value, bool)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if field == "compressionThreshold":
        return 0 <= value <= 1
    if field == "compressionTarget":
        return 0.1 <= value <= 0.8
    return isinstance(value, int) and value >= 1
```

Inside the Python loop, distinguish an invalid supported Approval Mode from an unsupported CLI key:

```py
        resolved_value = json.loads(result.stdout.strip())
        if not valid_value(field, resolved_value):
            if field == "approvalMode":
                raise ValueError("Hermes approvals.mode returned an invalid value")
            unsupported_keys.append(field)
            continue
        values[field] = resolved_value
```

Place the approval-mode branch first in `validateHermesCommonSetting`:

```ts
if (key === "approvalMode") {
  return typeof input === "string" && HERMES_APPROVAL_MODES.includes(input as HermesApprovalMode)
    ? { ok: true, value: input as HermesApprovalMode }
    : { ok: false, reason: "type" };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command again.

Expected: all tests in `agent-common-settings.test.ts` PASS.

- [ ] **Step 5: Review and prepare the Task 1 commit**

Run `git diff --check`, show the two-file diff to the user, and request confirmation. After confirmation:

```bash
git add frontend/src/pages/marketing/agent-common-settings.ts frontend/src/pages/marketing/__tests__/agent-common-settings.test.ts
git commit -m "支持审批模式配置 / feat(frontend): type Hermes approval mode"
```

---

### Task 2: Apply immediate save and reset semantics

**Files:**
- Modify: `frontend/src/pages/marketing/agent-common-settings-save.ts`
- Modify: `frontend/src/pages/marketing/agent-common-settings-reset.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-common-settings-save.test.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-common-settings-reset.test.ts`

**Interfaces:**
- Consumes: `requiresHermesCommonSettingGatewayRestart(key): boolean` from Task 1.
- Preserves: `SaveHermesCommonSettingOptions` and `ResetHermesCommonSettingsGroupOptions`; callers still pass `getGatewayRestartCommand`.
- Produces: immediate `approvalMode` save/reset without invoking the restart callback.

- [ ] **Step 1: Add failing save-policy tests**

Add `approvalMode: "off"` to all snapshot helpers in both test files. Add this test to `agent-common-settings-save.test.ts`:

```ts
it("writes and verifies approval mode without restarting Gateway", async () => {
  const approvalSnapshot: HermesCommonSettingsSnapshot = {
    ...snapshot(),
    values: { ...snapshot().values, approvalMode: "smart" },
  };
  const execDebugCommand = vi.fn()
    .mockResolvedValueOnce(succeeded())
    .mockResolvedValueOnce(succeeded([
      HERMES_COMMON_SETTINGS_JSON_START,
      JSON.stringify(approvalSnapshot),
      HERMES_COMMON_SETTINGS_JSON_END,
    ].join("\n")));
  const getGatewayRestartCommand = vi.fn(async () => "hermes gateway restart");

  const result = await saveHermesCommonSetting({
    bots: { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository,
    botId: "bot-a",
    key: "approvalMode",
    value: "smart",
    getGatewayRestartCommand,
  });

  expect(result).toMatchObject({ status: "success", snapshot: { values: { approvalMode: "smart" } } });
  expect(execDebugCommand).toHaveBeenNthCalledWith(
    1,
    "bot-a",
    "hermes config set approvals.mode smart",
    { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
  );
  expect(execDebugCommand).toHaveBeenCalledTimes(2);
  expect(getGatewayRestartCommand).not.toHaveBeenCalled();
});
```

Add this test to `agent-common-settings-reset.test.ts`:

```ts
it("restores the security group without restarting Gateway", async () => {
  const verified = snapshot(["approvalMode"]);
  verified.values.approvalMode = "smart";
  const execDebugCommand = vi.fn()
    .mockResolvedValueOnce(succeeded())
    .mockResolvedValueOnce(succeeded([
      HERMES_COMMON_SETTINGS_JSON_START,
      JSON.stringify(verified),
      HERMES_COMMON_SETTINGS_JSON_END,
    ].join("\n")));
  const getGatewayRestartCommand = vi.fn(async () => "hermes gateway restart");

  const result = await resetHermesCommonSettingsGroup({
    bots: botsWith(execDebugCommand),
    botId: "bot-a",
    group: "security",
    snapshot: snapshot(),
    getGatewayRestartCommand,
  });

  expect(result).toMatchObject({ status: "success", snapshot: { values: { approvalMode: "smart" } } });
  expect(execDebugCommand).toHaveBeenNthCalledWith(
    1,
    "bot-a",
    "hermes config unset approvals.mode",
    { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
  );
  expect(execDebugCommand).toHaveBeenCalledTimes(2);
  expect(getGatewayRestartCommand).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd frontend
pnpm vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
  src/pages/marketing/__tests__/agent-common-settings-reset.test.ts
```

Expected: both new tests FAIL because the restart callback is called.

- [ ] **Step 3: Make save conditional on apply policy**

Import `requiresHermesCommonSettingGatewayRestart` in `agent-common-settings-save.ts`, then replace the unconditional restart block with:

```ts
if (requiresHermesCommonSettingGatewayRestart(key)) {
  const restartCommand = await getGatewayRestartCommand();
  const restartResult = await bots.execDebugCommand(
    botId,
    restartCommand,
    { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
  );
  if (!isExecCommandSucceeded(restartResult)) {
    throw commandError("restart", restartResult.output, restartResult.status);
  }
}
```

Do not change the subsequent full snapshot reread or exact-value comparison.

- [ ] **Step 4: Make reset filter unsupported fields and restart only when required**

Import `requiresHermesCommonSettingGatewayRestart` in `agent-common-settings-reset.ts`. Replace target selection with:

```ts
const targetKeys = getHermesCommonSettingKeysForGroup(group)
  .filter((key) => !snapshot.unsupportedKeys.includes(key))
  .filter((key) => !snapshot.defaultedKeys.includes(key));
```

Replace the unconditional restart block with:

```ts
if (succeededKeys.some(requiresHermesCommonSettingGatewayRestart)) {
  const restartCommand = await getGatewayRestartCommand();
  const restartResult = await bots.execDebugCommand(
    botId,
    restartCommand,
    { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
  );
  if (!isExecCommandSucceeded(restartResult)) {
    return { status: "partial", error: commandError("restart", restartResult.output, restartResult.status) };
  }
}
```

Keep one full reread after unset/restart and retain the current `defaultedKeys` verification.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command again.

Expected: save/reset tests PASS, including existing assertions that memory and context restart exactly once.

- [ ] **Step 6: Review and prepare the Task 2 commit**

Run `git diff --check`, show the four-file diff, and request confirmation. After confirmation:

```bash
git add \
  frontend/src/pages/marketing/agent-common-settings-save.ts \
  frontend/src/pages/marketing/agent-common-settings-reset.ts \
  frontend/src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
  frontend/src/pages/marketing/__tests__/agent-common-settings-reset.test.ts
git commit -m "区分审批模式生效策略 / feat(frontend): apply approval mode immediately"
```

---

### Task 3: Render the Security group and risk confirmation

**Files:**
- Modify: `frontend/src/pages/marketing/agent-common-settings-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`

**Interfaces:**
- Consumes: `HermesApprovalMode`, `HermesCommonSettingsSnapshot.values.approvalMode`, group `security`, and existing `saveSetting`/`resetSettings` injection points.
- Produces: controlled Select with accessible name `审批模式` and pending destructive transition state.

- [ ] **Step 1: Update fixtures and add failing layout/select tests**

Add `approvalMode: "smart"` to `baseSnapshot().values`. Update existing structural assertions from six rows/two groups to seven rows/three groups, and address groups by heading rather than fixed historical indexes:

```ts
const groups = await screen.findAllByTestId("common-setting-group");
expect(groups).toHaveLength(3);

const securityGroup = groups.find((group) => within(group).queryByRole("heading", { name: "安全" }));
const memoryGroup = groups.find((group) => within(group).queryByRole("heading", { name: "记忆" }));
const contextGroup = groups.find((group) => within(group).queryByRole("heading", { name: "上下文管理" }));

expect(securityGroup).toBeTruthy();
expect(memoryGroup).toBeTruthy();
expect(contextGroup).toBeTruthy();
expect(within(securityGroup!).getAllByTestId("common-setting-row")).toHaveLength(1);
expect(within(memoryGroup!).getAllByTestId("common-setting-row")).toHaveLength(2);
expect(within(contextGroup!).getAllByTestId("common-setting-row")).toHaveLength(4);
```

Add:

```ts
it("renders approval mode first with all three choices", async () => {
  const user = userEvent.setup();
  render(
    <AgentCommonSettingsPanel
      botId="bot-a"
      botStatus="running"
      bots={bots}
      getGatewayRestartCommand={async () => "restart"}
      loadSettings={async () => baseSnapshot()}
      saveSetting={vi.fn()}
    />,
  );

  const trigger = await screen.findByRole("combobox", { name: "审批模式" });
  expect(trigger).toHaveTextContent("智能审批");
  await user.click(trigger);
  expect(screen.getByRole("option", { name: "智能审批" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "始终询问" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "关闭审批" })).toBeTruthy();
});
```

- [ ] **Step 2: Add failing interaction tests**

Add one direct-save and one destructive-confirmation test:

```ts
it("saves smart and manual approval modes without confirmation", async () => {
  const user = userEvent.setup();
  const saveSetting = vi.fn().mockResolvedValue({
    status: "success",
    snapshot: baseSnapshot({ values: { ...baseSnapshot().values, approvalMode: "manual" } }),
  } satisfies HermesCommonSettingSaveResult);

  render(
    <AgentCommonSettingsPanel
      botId="bot-a"
      botStatus="running"
      bots={bots}
      getGatewayRestartCommand={async () => "restart"}
      loadSettings={async () => baseSnapshot()}
      saveSetting={saveSetting}
    />,
  );

  await user.click(await screen.findByRole("combobox", { name: "审批模式" }));
  await user.click(screen.getByRole("option", { name: "始终询问" }));

  await waitFor(() => expect(saveSetting).toHaveBeenCalledWith(expect.objectContaining({
    key: "approvalMode",
    value: "manual",
  })));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("confirms before turning approvals off and restores the controlled value on cancel", async () => {
  const user = userEvent.setup();
  const saveSetting = vi.fn();

  render(
    <AgentCommonSettingsPanel
      botId="bot-a"
      botStatus="running"
      bots={bots}
      getGatewayRestartCommand={async () => "restart"}
      loadSettings={async () => baseSnapshot()}
      saveSetting={saveSetting}
    />,
  );

  const trigger = await screen.findByRole("combobox", { name: "审批模式" });
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: "关闭审批" }));

  expect(saveSetting).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "确认关闭命令审批？" })).toBeTruthy();
  expect(screen.getByText("关闭后，Agent 执行危险命令时将不再请求你的批准。请仅在可信环境中使用。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认关闭" })).toHaveClass("bg-red-600");

  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(saveSetting).not.toHaveBeenCalled();
  expect(trigger).toHaveTextContent("智能审批");

  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: "关闭审批" }));
  await user.click(screen.getByRole("button", { name: "确认关闭" }));
  expect(saveSetting).toHaveBeenCalledWith(expect.objectContaining({ key: "approvalMode", value: "off" }));
});
```

Add the initial-`off`, unsupported, and Security reset regressions:

```ts
it("shows an existing off mode without opening a confirmation dialog", async () => {
  render(
    <AgentCommonSettingsPanel
      botId="bot-a"
      botStatus="running"
      bots={bots}
      getGatewayRestartCommand={async () => "restart"}
      loadSettings={async () => baseSnapshot({
        values: { ...baseSnapshot().values, approvalMode: "off" },
      })}
      saveSetting={vi.fn()}
    />,
  );

  expect(await screen.findByRole("combobox", { name: "审批模式" })).toHaveTextContent("关闭审批");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("disables Security reset when approval mode is unsupported", async () => {
  render(
    <AgentCommonSettingsPanel
      botId="bot-a"
      botStatus="running"
      bots={bots}
      getGatewayRestartCommand={async () => "restart"}
      loadSettings={async () => baseSnapshot({ unsupportedKeys: ["approvalMode"] })}
      saveSetting={vi.fn()}
      resetSettings={vi.fn()}
    />,
  );

  const groups = await screen.findAllByTestId("common-setting-group");
  const securityGroup = groups.find((group) => within(group).queryByRole("heading", { name: "安全" }));
  expect(securityGroup).toBeTruthy();
  expect(within(securityGroup!).queryByRole("combobox", { name: "审批模式" })).toBeNull();
  expect(within(securityGroup!).getByText("当前 Agent 版本不支持")).toBeTruthy();
  expect(within(securityGroup!).getByRole("button", { name: "恢复默认" })).toBeDisabled();
});

it("restores Security to smart approval", async () => {
  const user = userEvent.setup();
  const resetSettings = vi.fn().mockResolvedValue({
    status: "success",
    snapshot: baseSnapshot({
      values: { ...baseSnapshot().values, approvalMode: "smart" },
      defaultedKeys: ["approvalMode"],
    }),
  } satisfies HermesCommonSettingsResetResult);

  render(
    <AgentCommonSettingsPanel
      botId="bot-a"
      botStatus="running"
      bots={bots}
      getGatewayRestartCommand={async () => "restart"}
      loadSettings={async () => baseSnapshot({
        values: { ...baseSnapshot().values, approvalMode: "off" },
      })}
      saveSetting={vi.fn()}
      resetSettings={resetSettings}
    />,
  );

  const groups = await screen.findAllByTestId("common-setting-group");
  const securityGroup = groups.find((group) => within(group).queryByRole("heading", { name: "安全" }));
  await user.click(within(securityGroup!).getByRole("button", { name: "恢复默认" }));
  await user.click(screen.getByRole("button", { name: "确认恢复" }));

  await waitFor(() => expect(resetSettings).toHaveBeenCalledWith(expect.objectContaining({ group: "security" })));
  expect(await screen.findByRole("combobox", { name: "审批模式" })).toHaveTextContent("智能审批");
});
```

- [ ] **Step 3: Run the panel test and verify RED**

Run:

```bash
cd frontend
pnpm vitest run --config vitest.config.ts --api.host 127.0.0.1 src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx
```

Expected: FAIL because the Security group, Select, and confirmation dialog do not exist.

- [ ] **Step 4: Add the Select model and Security group**

Import the existing Radix wrappers and approval type:

```ts
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { HermesApprovalMode } from "@/pages/marketing/agent-common-settings";
```

Extend `SettingCopy.kind` to `"switch" | "number" | "select"`, add `approvalMode: null` to `emptyFeedback`, and add state:

```ts
const [pendingApprovalMode, setPendingApprovalMode] = useState<HermesApprovalMode | null>(null);
```

Reset it to `null` in `refresh()` alongside the existing pending-dialog state. Do not call a state setter from the effect cleanup. Insert this group before Memory:

```ts
{
  id: "security",
  title: t("安全"),
  description: t("管理 Agent 执行危险命令时的审批方式。"),
  settings: [
    {
      key: "approvalMode",
      label: t("审批模式"),
      description: t("设置 Agent 遇到危险命令时如何请求审批。"),
      kind: "select",
    },
  ],
},
```

Use the existing `17rem` control column for select and number rows:

```ts
setting.kind === "switch"
  ? "sm:grid-cols-[minmax(0,1fr)_auto]"
  : "sm:grid-cols-[minmax(0,1fr)_17rem]"
```

- [ ] **Step 5: Render a controlled Approval Mode Select**

Add a typed change handler:

```ts
const changeApprovalMode = (nextValue: string) => {
  if (!snapshot || nextValue === snapshot.values.approvalMode) return;
  const validation = validateHermesCommonSetting("approvalMode", nextValue);
  if (!validation.ok || typeof validation.value !== "string") return;
  if (validation.value === "off") {
    setPendingApprovalMode(validation.value);
    return;
  }
  void commit("approvalMode", validation.value);
};
```

Before the numeric `editing` branch, render:

```tsx
) : setting.kind === "select" ? (
  <Select
    value={snapshot.values.approvalMode}
    disabled={disabled}
    onValueChange={changeApprovalMode}
  >
    <SelectTrigger aria-label={setting.label} className="h-10 w-full max-w-[17rem] rounded-md">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="smart">{t("智能审批")}</SelectItem>
      <SelectItem value="manual">{t("始终询问")}</SelectItem>
      <SelectItem value="off">{t("关闭审批")}</SelectItem>
    </SelectContent>
  </Select>
```

Keep the Select controlled by the verified snapshot; do not mutate the displayed value when opening the confirmation dialog.

- [ ] **Step 6: Add the destructive confirmation dialog**

Render this dialog beside the existing switch/reset dialogs:

```tsx
{pendingApprovalMode === "off" && (
  <Dialog open onOpenChange={(open) => {
    if (!open) setPendingApprovalMode(null);
  }}>
    <DialogContent className="w-[calc(100vw-2rem)] max-w-[28rem] rounded-lg bg-white p-6 shadow-2xl md:w-[28rem]">
      <DialogHeader className="mb-5 pr-8">
        <DialogTitle className="text-balance text-lg font-semibold text-black/90">
          {t("确认关闭命令审批？")}
        </DialogTitle>
        <DialogDescription className="mt-1 text-pretty text-sm leading-6 text-black/55">
          {t("关闭后，Agent 执行危险命令时将不再请求你的批准。请仅在可信环境中使用。")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setPendingApprovalMode(null)}
          className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/65 transition hover:bg-black/[0.04]"
        >
          {t("取消")}
        </button>
        <button
          type="button"
          onClick={() => {
            setPendingApprovalMode(null);
            void commit("approvalMode", "off");
          }}
          className="inline-flex h-9 min-w-[104px] items-center justify-center rounded-md bg-red-600 px-4 text-sm font-semibold text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
        >
          {t("确认关闭")}
        </button>
      </div>
    </DialogContent>
  </Dialog>
)}
```

For group reset disabled state, treat unsupported fields as unavailable/default-equivalent:

```ts
const groupAlreadyDefault = getHermesCommonSettingKeysForGroup(group.id)
  .every((key) => snapshot.defaultedKeys.includes(key) || snapshot.unsupportedKeys.includes(key));
```

- [ ] **Step 7: Run panel tests and verify GREEN**

Run the Step 3 command again.

Expected: all panel tests PASS after updating historical group-index and row-count assertions.

- [ ] **Step 8: Review and prepare the Task 3 commit**

Run `git diff --check`, show the two-file diff, and request confirmation. After confirmation:

```bash
git add frontend/src/pages/marketing/agent-common-settings-panel.tsx frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx
git commit -m "新增审批模式交互 / feat(frontend): add approval mode selector"
```

---

### Task 4: Generate translations and run the full scoped gate

**Files:**
- Modify mechanically: `frontend/src/i18n/generated/zh-to-key.json`
- Modify mechanically: `frontend/src/i18n/generated/zh-CN.json`
- Modify: `frontend/src/i18n/generated/zh-Hant.json`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Regression test: `frontend/src/pages/marketing/__tests__/agent-common-settings-page-boundary.test.ts`
- Regression test: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`
- Regression test: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.global.test.tsx`

**Interfaces:**
- Consumes: the exact Chinese source strings introduced by Task 3.
- Produces: complete four-locale translations and a clean generated i18n check.

- [ ] **Step 1: Extract the new Chinese keys**

Run:

```bash
cd frontend
pnpm i18n:extract
```

Review the generated diff immediately. Restore any unrelated historical deletions by comparing with `origin/master`; keep only keys referenced by this feature plus the already-committed Advanced Settings rename.

- [ ] **Step 2: Fill every locale with exact translations**

Use the hashes generated in `zh-to-key.json` for these source strings and set the corresponding dictionary values exactly as follows:

| zh-CN source | zh-Hant | en-US | id-ID |
|---|---|---|---|
| 安全 | 安全 | Security | Keamanan |
| 管理 Agent 执行危险命令时的审批方式。 | 管理 Agent 執行危險命令時的審批方式。 | Manage how the Agent approves dangerous commands. | Kelola cara Agent menyetujui perintah berbahaya. |
| 审批模式 | 審批模式 | Approval Mode | Mode Persetujuan |
| 设置 Agent 遇到危险命令时如何请求审批。 | 設置 Agent 遇到危險命令時如何請求審批。 | Set how the Agent requests approval for dangerous commands. | Atur cara Agent meminta persetujuan untuk perintah berbahaya. |
| 智能审批 | 智能審批 | Smart | Cerdas |
| 始终询问 | 始終詢問 | Always Ask | Selalu Tanyakan |
| 关闭审批 | 關閉審批 | Off | Nonaktif |
| 确认关闭命令审批？ | 確認關閉命令審批？ | Turn off command approvals? | Nonaktifkan persetujuan perintah? |
| 关闭后，Agent 执行危险命令时将不再请求你的批准。请仅在可信环境中使用。 | 關閉後，Agent 執行危險命令時將不再請求你的批准。請僅在可信環境中使用。 | Once turned off, the Agent will no longer ask for your approval before running dangerous commands. Use this only in a trusted environment. | Setelah dinonaktifkan, Agent tidak lagi meminta persetujuan Anda sebelum menjalankan perintah berbahaya. Gunakan hanya di lingkungan tepercaya. |

Reuse the existing translations for `取消` and `确认关闭`; do not create duplicate source keys.

- [ ] **Step 3: Verify i18n and the focused functional suite**

Run:

```bash
cd frontend
pnpm i18n:check
pnpm i18n:zh-hant:check
pnpm vitest run --config vitest.config.ts --api.host 127.0.0.1 \
  src/pages/marketing/__tests__/agent-common-settings.test.ts \
  src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
  src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
  src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx \
  src/pages/marketing/__tests__/agent-common-settings-page-boundary.test.ts \
  src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx \
  src/pages/marketing/__tests__/agent-settings-renewal-reminder.global.test.tsx
```

Expected: both i18n checks exit 0 and all focused test files PASS.

- [ ] **Step 4: Run static and regional gates**

Run:

```bash
cd frontend
pnpm typecheck
pnpm check
pnpm build:cn
pnpm build:global
```

Expected: all commands exit 0. If a build modifies generated fonts or docs artifacts, compare them with the clean baseline and keep only changes directly required by this feature.

- [ ] **Step 5: Review and prepare the Task 4 commit**

Run `git diff --check`, show the five i18n-file diff and validation results, and request confirmation. After confirmation:

```bash
git add \
  frontend/src/i18n/generated/zh-to-key.json \
  frontend/src/i18n/generated/zh-CN.json \
  frontend/src/i18n/generated/zh-Hant.json \
  frontend/src/i18n/generated/en-US.json \
  frontend/src/i18n/generated/id-ID.json
git commit -m "补充审批模式多语言 / chore(frontend): localize approval mode"
```

---

### Task 5: Final scope audit and MR update

**Files:**
- Verify: all files committed by Tasks 1-4.
- Update remotely after user confirmation: MR !3288 title and description.

**Interfaces:**
- Consumes: all passing tests/builds and the committed design/implementation history.
- Produces: a clean pushed branch and truthful MR scope/verification evidence.

- [ ] **Step 1: Audit the complete diff**

Run:

```bash
git status --short --branch
git diff --check origin/master...HEAD
git diff --stat origin/master...HEAD
git diff --name-only origin/master...HEAD
git log --oneline --decorate origin/master..HEAD
```

Expected: only the Advanced Settings rename, Approval Mode OpenSpec documents, the four production modules, focused tests, and five i18n dictionaries are present. No image defaults, global routes, unrelated generated files, credentials, or build output may appear.

- [ ] **Step 2: Run one final focused verification from the committed tree**

Run the Task 4 Step 3 focused suite once more and record the exact test count and command exit status. Run `pnpm typecheck` again if any source changed after the last typecheck.

- [ ] **Step 3: Present push and MR changes for confirmation**

Show:

- branch: `frontsandbox/advanced-settings-copy`
- commits to push
- exact changed-file list
- proposed MR title: `升级 Agent 高级设置并新增审批模式 / feat: add Agent approval mode`
- proposed MR description: domestic-only Advanced Settings rename; new Security group; `smart/manual/off`; confirmation before `off`; immediate save/reset without Gateway restart; existing six settings unchanged; focused tests, i18n, typecheck, CN/global build evidence.

Wait for explicit confirmation before the remote write.

- [ ] **Step 4: Push and update MR !3288**

After confirmation:

```bash
git push origin frontsandbox/advanced-settings-copy
```

Use the repository Gongfeng skill and configured authentication to update MR !3288. Never print the token. Query the MR after the write and verify:

- source branch is `frontsandbox/advanced-settings-copy`
- source commit equals local `HEAD`
- state is `opened`
- merge status is reported truthfully
- MR title and description match the approved scope

- [ ] **Step 5: Report delivery state**

Return the MR link, pushed commit SHA, focused verification results, and real CI/merge state. Do not describe the feature as merged or deployed unless the corresponding remote evidence exists.
