# Agent 会话操作确认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repository is configured for single-agent execution; do not dispatch subagents unless the user explicitly authorizes them.

**Goal:** 在 Agent 高级设置的「安全」分组增加 `approvals.destructive_slash_confirm` 开关，并让该分组的“恢复默认”固定写回 LightVela 预置值。

**Architecture:** 扩展现有 `agent-common-settings` typed model、批量 reader、save 和 reset 链路，不直接编辑 YAML、不增加独立模块。新增字段和 `approvalMode` 都是即时生效字段；安全分组 reset 使用 `config set` 写回 LightVela preset，其他分组继续通过 `config unset` 恢复 Hermes 默认值。

**Tech Stack:** React 19、TypeScript 5.9、Next.js 16、Vitest 4、Testing Library、Hermes CLI、现有中文即 key i18n。

## Global Constraints

- 设置名称固定为「会话操作确认」。
- 设置说明固定为「新建会话，或清空、撤销、删除会话内容前，先向你确认。」
- 开启写入 `approvals.destructive_slash_confirm: true`，关闭写入 `false`。
- `destructiveSlashConfirm` 与 `approvalMode` 修改后均不重启 Gateway，必须回读验证。
- 「安全」分组的恢复目标固定为 LightVela 预置：`approvals.mode=off`、`approvals.destructive_slash_confirm=false`。
- 安全分组恢复不得对这两个键执行 `config unset`，不得恢复为 Hermes 官方默认 `smart/true`。
- 记忆和上下文管理分组继续使用 `config unset` 恢复 Hermes 默认值。
- 老版本 Hermes 不支持新字段时只降级该字段，不阻塞其他设置。
- 国内站和国际站共用同一实现，不增加区域分支。
- 不修改 `images/build.sh` 中的 LightVela 镜像预置，不接入其他 `approvals.*` 字段。
- 不手改 i18n generated 文件；使用 `pnpm i18n:extract` 生成并逐项检查四语言值。
- 先 RED、再最小实现、再 GREEN；完成前使用 `$verification-before-completion`。
- 未经用户单独确认，不执行后续 commit、push 或 MR；以下 commit 步骤仅表示建议检查点。

---

### Task 1: 扩展 typed settings、reader 与即时保存链路

**Files:**
- Modify: `frontend/src/pages/marketing/agent-common-settings.ts:11-76,109-167,219-297`
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings.test.ts:8-245`
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings-save.test.ts:12-142`

**Interfaces:**
- Produces: `HermesCommonSettingsValues.destructiveSlashConfirm: boolean`。
- Produces: key `destructiveSlashConfirm` → config `approvals.destructive_slash_confirm`。
- Produces: `getHermesCommonSettingResetValue(key): HermesCommonSettingValue | undefined`；安全键返回 LightVela preset，其他键返回 `undefined`。
- Produces: `isHermesCommonSettingAtResetTarget(key, snapshot): boolean`；供 reset 和 panel 共用。
- Preserves: `saveHermesCommonSetting()` 的 config-set → optional restart → reread contract。

- [x] **Step 1: 在 typed model 测试中加入新字段、命令、默认值与 reset target 断言。**

  将 `snapshotOutput()` 的 `values` 增加：

  ```ts
  destructiveSlashConfirm: false,
  ```

  并增加以下断言：

  ```ts
  expect(command).toContain(
    '"destructiveSlashConfirm": ("approvals.destructive_slash_confirm", True)',
  );
  expect(getHermesCommonSettingKeysForGroup("security")).toEqual([
    "approvalMode",
    "destructiveSlashConfirm",
  ]);
  expect(validateHermesCommonSetting("destructiveSlashConfirm", true)).toEqual({
    ok: true,
    value: true,
  });
  expect(validateHermesCommonSetting("destructiveSlashConfirm", "true" as never)).toEqual({
    ok: false,
    reason: "type",
  });
  expect(buildHermesCommonSettingCommand("destructiveSlashConfirm", false)).toBe(
    "hermes config set approvals.destructive_slash_confirm false",
  );
  expect(requiresHermesCommonSettingGatewayRestart("destructiveSlashConfirm")).toBe(false);
  expect(getHermesCommonSettingResetValue("approvalMode")).toBe("off");
  expect(getHermesCommonSettingResetValue("destructiveSlashConfirm")).toBe(false);
  expect(getHermesCommonSettingResetValue("persistentMemory")).toBeUndefined();
  ```

  在 fake Hermes reader case 中让新 key 返回 `false`，避免该用例因未提供新字段而把它误判为 unsupported：

  ```sh
  approvals.destructive_slash_confirm) printf '%s\n' 'false' ;;
  ```

- [x] **Step 2: 增加新字段即时保存测试。**

  所有 `HermesCommonSettingsSnapshot` fixture 增加 `destructiveSlashConfirm: false`，然后在 `agent-common-settings-save.test.ts` 新增：

  ```ts
  it("writes and verifies session operation confirmation without restarting Gateway", async () => {
    const verified = snapshot();
    verified.values.destructiveSlashConfirm = true;
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded([
        HERMES_COMMON_SETTINGS_JSON_START,
        JSON.stringify(verified),
        HERMES_COMMON_SETTINGS_JSON_END,
      ].join("\n")));
    const getGatewayRestartCommand = vi.fn(async () => "hermes gateway restart");

    const result = await saveHermesCommonSetting({
      bots: { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository,
      botId: "bot-a",
      key: "destructiveSlashConfirm",
      value: true,
      getGatewayRestartCommand,
    });

    expect(result).toMatchObject({
      status: "success",
      snapshot: { values: { destructiveSlashConfirm: true } },
    });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config set approvals.destructive_slash_confirm true",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand).toHaveBeenCalledTimes(2);
    expect(getGatewayRestartCommand).not.toHaveBeenCalled();
  });
  ```

- [x] **Step 3: 运行测试并确认 RED。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-common-settings.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
    --api.host 127.0.0.1
  ```

  Expected: FAIL，原因是 `destructiveSlashConfirm`、reset target helper 和 config mapping 尚不存在。

- [x] **Step 4: 最小扩展 typed model、reader、validation 与 command mapping。**

  在 key、group 和 values 中加入新字段：

  ```ts
  export const HERMES_COMMON_SETTING_KEYS = [
    "approvalMode",
    "destructiveSlashConfirm",
    "persistentMemory",
    "userProfile",
    "autoCompression",
    "compressionThreshold",
    "compressionTarget",
    "protectedRecentMessages",
  ] as const;

  export const HERMES_COMMON_SETTING_KEYS_BY_GROUP = {
    security: ["approvalMode", "destructiveSlashConfirm"],
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
    destructiveSlashConfirm: boolean;
    persistentMemory: boolean;
    userProfile: boolean;
    autoCompression: boolean;
    compressionThreshold: number;
    compressionTarget: number;
    protectedRecentMessages: number;
  }
  ```

  配置映射、重启策略与 Python reader 增加：

  ```ts
  destructiveSlashConfirm: "approvals.destructive_slash_confirm",
  ```

  ```ts
  export function requiresHermesCommonSettingGatewayRestart(
    key: HermesCommonSettingKey,
  ): boolean {
    return key !== "approvalMode" && key !== "destructiveSlashConfirm";
  }
  ```

  ```python
  "destructiveSlashConfirm": ("approvals.destructive_slash_confirm", True),
  ```

  将 Python 和 TypeScript 的布尔字段判断均扩展到 `destructiveSlashConfirm`，不为它增加字符串兼容。

- [x] **Step 5: 集中定义 LightVela 安全 preset 与 reset target 判断。**

  在 `agent-common-settings.ts` 增加：

  ```ts
  export function getHermesCommonSettingResetValue(
    key: HermesCommonSettingKey,
  ): HermesCommonSettingValue | undefined {
    if (key === "approvalMode") return "off";
    if (key === "destructiveSlashConfirm") return false;
    return undefined;
  }

  export function isHermesCommonSettingAtResetTarget(
    key: HermesCommonSettingKey,
    snapshot: HermesCommonSettingsSnapshot,
  ): boolean {
    if (snapshot.unsupportedKeys.includes(key)) return true;
    const resetValue = getHermesCommonSettingResetValue(key);
    return resetValue === undefined
      ? snapshot.defaultedKeys.includes(key)
      : Object.is(snapshot.values[key], resetValue);
  }
  ```

  该 helper 明确把 unsupported 视为无需恢复；安全键比较 LightVela preset，其他键仍比较 `defaultedKeys`。

- [x] **Step 6: 运行 Task 1 测试并确认 GREEN。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-common-settings.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
    --api.host 127.0.0.1
  ```

  Expected: 两个测试文件全部通过；即时字段只产生 config-set 和 reread 两次 debug exec。

- [x] **Step 7: 展示 Task 1 diff；如用户明确批准提交，再使用建议提交信息。**

  ```text
  接入会话操作确认配置 / feat(frontend): add session operation confirmation setting
  ```

---

### Task 2: 将安全分组恢复逻辑改为 LightVela 预置值

**Files:**
- Modify: `frontend/src/pages/marketing/agent-common-settings-reset.ts:1-103`
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings-reset.test.ts:12-210`

**Interfaces:**
- Consumes: `getHermesCommonSettingResetValue()` 与 `isHermesCommonSettingAtResetTarget()`。
- Produces: security reset 使用 config-set 写回 `off/false`，memory/context reset 保持 config-unset。
- Preserves: 失败、部分成功、单次 Gateway restart 和 reread result contract。

- [x] **Step 1: 将旧 security-unset 测试改为 LightVela preset 测试。**

  所有 fixture 增加 `destructiveSlashConfirm`。将 security case 的初始值设置为 `smart/true`，回读值设置为 `off/false`，并断言：

  ```ts
  expect(execDebugCommand).toHaveBeenNthCalledWith(
    1,
    "bot-a",
    "hermes config set approvals.mode off",
    { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
  );
  expect(execDebugCommand).toHaveBeenNthCalledWith(
    2,
    "bot-a",
    "hermes config set approvals.destructive_slash_confirm false",
    { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
  );
  expect(execDebugCommand.mock.calls.map(([, command]) => String(command))).not.toContain(
    "hermes config unset approvals.mode",
  );
  expect(result).toMatchObject({
    status: "success",
    snapshot: {
      values: { approvalMode: "off", destructiveSlashConfirm: false },
    },
  });
  expect(getGatewayRestartCommand).not.toHaveBeenCalled();
  ```

  再增加两条边界测试：

  ```ts
  it("writes only the security value that differs from the LightVela preset", async () => {
    const initial = snapshot();
    initial.values.destructiveSlashConfirm = true;
    const verified = snapshot();
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded([
        HERMES_COMMON_SETTINGS_JSON_START,
        JSON.stringify(verified),
        HERMES_COMMON_SETTINGS_JSON_END,
      ].join("\n")));

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "security",
      snapshot: initial,
      getGatewayRestartCommand: vi.fn(async () => "hermes gateway restart"),
    });

    expect(result).toMatchObject({ status: "success" });
    expect(execDebugCommand).toHaveBeenNthCalledWith(
      1,
      "bot-a",
      "hermes config set approvals.destructive_slash_confirm false",
      { timeoutMs: HERMES_COMMON_SETTINGS_TIMEOUT_MS },
    );
    expect(execDebugCommand.mock.calls.map(([, command]) => String(command))).not.toContain(
      "hermes config set approvals.mode off",
    );
    expect(execDebugCommand).toHaveBeenCalledTimes(2);
  });

  it("returns partial when security reread does not match the LightVela preset", async () => {
    const initial = snapshot();
    initial.values.approvalMode = "smart";
    initial.values.destructiveSlashConfirm = true;
    const stale = snapshot();
    stale.values.destructiveSlashConfirm = true;
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded())
      .mockResolvedValueOnce(succeeded([
        HERMES_COMMON_SETTINGS_JSON_START,
        JSON.stringify(stale),
        HERMES_COMMON_SETTINGS_JSON_END,
      ].join("\n")));

    const result = await resetHermesCommonSettingsGroup({
      bots: botsWith(execDebugCommand),
      botId: "bot-a",
      group: "security",
      snapshot: initial,
      getGatewayRestartCommand: vi.fn(async () => "hermes gateway restart"),
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { message: expect.stringContaining("reset targets") },
      snapshot: { values: { approvalMode: "off", destructiveSlashConfirm: true } },
    });
  });
  ```

- [x] **Step 2: 运行 reset 测试并确认 RED。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
    --api.host 127.0.0.1
  ```

  Expected: FAIL，旧实现仍对 security 执行 `config unset approvals.mode` 并回读 `smart`。

- [x] **Step 3: 最小改造 reset 命令选择和验证。**

  将 `targetKeys` 改为跳过已经位于 reset target 的键：

  ```ts
  const targetKeys = getHermesCommonSettingKeysForGroup(group)
    .filter((key) => !isHermesCommonSettingAtResetTarget(key, snapshot));
  ```

  每个 key 根据 preset 是否存在选择 set/unset：

  ```ts
  const resetValue = getHermesCommonSettingResetValue(key);
  const command = resetValue === undefined
    ? buildHermesCommonSettingUnsetCommand(key)
    : buildHermesCommonSettingCommand(key, resetValue);
  const stage = resetValue === undefined ? "unset" : "set";
  ```

  将 `commandError` stage 扩展为 `"set" | "unset" | "restart"`，错误数组改为中性命名 `resetErrors`。回读验证统一为：

  ```ts
  if (!targetKeys.every((key) => isHermesCommonSettingAtResetTarget(key, verifiedSnapshot))) {
    return {
      status: "partial",
      error: new Error("Hermes common settings did not return to reset targets"),
      snapshot: verifiedSnapshot,
    };
  }
  ```

- [x] **Step 4: 运行 reset 测试并确认 GREEN，验证 memory/context 无回归。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
    --api.host 127.0.0.1
  ```

  Expected: security 使用 `set off/false` 且不重启；memory/context 仍使用 unset，并在需要时只重启一次。

- [x] **Step 5: 展示 Task 2 diff；如用户明确批准提交，再使用建议提交信息。**

  ```text
  恢复 LightVela 安全默认配置 / fix(frontend): restore LightVela security presets
  ```

---

### Task 3: 增加安全开关、确认文案与多语言

**Files:**
- Modify: `frontend/src/pages/marketing/agent-common-settings-panel.tsx:13-150,191-219,275-289,350-659`
- Modify: `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`
- Generate: `frontend/src/i18n/generated/en-US.json`
- Generate: `frontend/src/i18n/generated/id-ID.json`
- Generate: `frontend/src/i18n/generated/zh-CN.json`
- Generate: `frontend/src/i18n/generated/zh-Hant.json`
- Generate: `frontend/src/i18n/generated/zh-to-key.json`

**Interfaces:**
- Consumes: `snapshot.values.destructiveSlashConfirm` 和 `isHermesCommonSettingAtResetTarget()`。
- Produces: accessible switch `role="switch"`、`aria-label="会话操作确认"`。
- Produces: security reset dialog 固定展示 LightVela preset 说明。
- Preserves: existing save/reset in-flight guards, unsupported rendering and numeric editing behavior。

- [x] **Step 1: 更新 panel fixture 并写入失败的 UI 测试。**

  所有 `baseSnapshot()` 增加：

  ```ts
  destructiveSlashConfirm: false,
  ```

  新增渲染和启用测试：

  ```ts
  it("renders session operation confirmation below approval mode and saves enabled state", async () => {
    const user = userEvent.setup();
    const saveSetting = vi.fn().mockResolvedValue({
      status: "success",
      snapshot: baseSnapshot({
        values: { ...baseSnapshot().values, destructiveSlashConfirm: true },
      }),
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

    expect(await screen.findByText("会话操作确认")).toBeTruthy();
    expect(screen.getByText("新建会话，或清空、撤销、删除会话内容前，先向你确认。")).toBeTruthy();
    const control = screen.getByRole("switch", { name: "会话操作确认" });
    expect(control).toHaveAttribute("aria-checked", "false");
    await user.click(control);
    expect(screen.getByRole("heading", { name: "确认开启「会话操作确认」？" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认开启" }));
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith(expect.objectContaining({
      key: "destructiveSlashConfirm",
      value: true,
    })));
  });
  ```

  新增关闭风险和 unsupported 测试：

  ```ts
  expect(screen.getByText(
    "关闭后，新建会话，或清空、撤销、删除会话内容时将直接执行。",
  )).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认关闭" })).toHaveClass(
    "bg-red-600",
    "hover:bg-red-700",
  );
  ```

  ```ts
  const securityGroup = (await screen.findAllByTestId("common-setting-group"))
    .find((group) => within(group).queryByRole("heading", { name: "安全" }));
  expect(within(securityGroup!).queryByRole("switch", { name: "会话操作确认" })).toBeNull();
  expect(within(securityGroup!).getByText("当前 Agent 版本不支持")).toBeTruthy();
  ```

- [x] **Step 2: 改写 security reset UI 测试，锁定 LightVela 默认语义。**

  用 `approvalMode: "smart"`、`destructiveSlashConfirm: true` 打开恢复弹窗并断言：

  ```ts
  expect(screen.getByText(
    "恢复后审批模式将变为「关闭审批」，会话操作确认将关闭。",
  )).toBeTruthy();
  expect(screen.queryByText(/智能审批/)).toBeNull();
  ```

  再覆盖 reset button 状态：`off/false` 时禁用；`smart/false`、`off/true` 任一偏离时启用；unsupported 新字段不阻塞对 approval mode 的 reset 判断。

- [x] **Step 3: 运行 panel 测试并确认 RED。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx \
    --api.host 127.0.0.1
  ```

  Expected: FAIL，页面尚未渲染新开关，reset 按钮仍按 `defaultedKeys` 判断，弹窗仍显示智能审批。

- [x] **Step 4: 最小增加设置项、确认文案和 preset reset 状态。**

  import `isHermesCommonSettingAtResetTarget` 与 `requiresHermesCommonSettingGatewayRestart`。`emptyFeedback()` 增加 `destructiveSlashConfirm: null`。security settings 改为：

  ```ts
  {
    id: "security",
    title: t("安全"),
    description: t("管理 Agent 的命令审批与会话操作确认方式。"),
    settings: [
      {
        key: "approvalMode",
        label: t("审批模式"),
        description: t("设置 Agent 执行高风险操作时的审批方式。"),
        kind: "select",
      },
      {
        key: "destructiveSlashConfirm",
        label: t("会话操作确认"),
        description: t("新建会话，或清空、撤销、删除会话内容前，先向你确认。"),
        kind: "switch",
      },
    ],
  }
  ```

  `switchConfirmationDescription()` 增加专属分支：

  ```ts
  if (change.key === "destructiveSlashConfirm") {
    return change.nextValue
      ? t("开启后，新建会话，或清空、撤销、删除会话内容前，将先向你确认。")
      : t("关闭后，新建会话，或清空、撤销、删除会话内容时将直接执行。");
  }
  ```

  部分成功提示改为依据 `requiresHermesCommonSettingGatewayRestart(key)`，避免新即时字段显示“重启失败”。关闭该安全开关时，确认按钮使用与关闭审批相同的 red destructive style。

  group reset 状态统一计算为：

  ```ts
  const groupAlreadyDefault = getHermesCommonSettingKeysForGroup(group.id)
    .every((key) => isHermesCommonSettingAtResetTarget(key, snapshot));
  ```

  security reset description 固定为：

  ```ts
  t("恢复后审批模式将变为「关闭审批」，会话操作确认将关闭。")
  ```

- [x] **Step 5: 运行 panel 与全链路焦点测试并确认 GREEN。**

  ```bash
  cd frontend
  pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-common-settings.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
    src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx \
    src/pages/marketing/__tests__/agent-common-settings-page-boundary.test.ts \
    src/pages/marketing/__tests__/agent-settings-renewal-reminder.global.test.tsx \
    --api.host 127.0.0.1
  ```

  Expected: 焦点测试全部通过；国内和国际站继续复用同一高级设置面板。

- [x] **Step 6: 生成并检查 i18n。**

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:check
  pnpm i18n:zh-hant:check
  ```

  Expected: 新增中文 key 均有非空英文、繁体中文和印尼语值；不得保留与本次 key 无关的 generated 删除或改写。重点翻译固定为：

  | zh-CN | zh-Hant | en-US | id-ID |
  |---|---|---|---|
  | 会话操作确认 | 會話操作確認 | Session Operation Confirmation | Konfirmasi Operasi Sesi |
  | 新建会话，或清空、撤销、删除会话内容前，先向你确认。 | 建立新會話，或清空、復原、刪除會話內容前，先向你確認。 | Ask for your confirmation before starting a new session or clearing, undoing, or deleting session content. | Minta konfirmasi Anda sebelum memulai sesi baru atau menghapus, membatalkan, atau membersihkan konten sesi. |

- [x] **Step 7: 运行最终静态检查和双区域构建。**

  ```bash
  cd frontend
  pnpm check
  pnpm build:cn
  pnpm build:global
  cd ..
  git diff --check -- \
    frontend/src/pages/marketing/agent-common-settings.ts \
    frontend/src/pages/marketing/agent-common-settings-save.ts \
    frontend/src/pages/marketing/agent-common-settings-reset.ts \
    frontend/src/pages/marketing/agent-common-settings-panel.tsx \
    frontend/src/pages/marketing/__tests__/agent-common-settings.test.ts \
    frontend/src/pages/marketing/__tests__/agent-common-settings-save.test.ts \
    frontend/src/pages/marketing/__tests__/agent-common-settings-reset.test.ts \
    frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx \
    frontend/src/i18n/generated \
    frontend/openspec
  ```

  Expected: 类型、i18n、国内构建、国际构建和 diff 检查全部通过。

- [x] **Step 8: 使用 `$verification-before-completion` 复核证据并展示最终提交范围。**

  重点确认：

  ```text
  security reset commands:
  hermes config set approvals.mode off
  hermes config set approvals.destructive_slash_confirm false

  forbidden security reset commands:
  hermes config unset approvals.mode
  hermes config unset approvals.destructive_slash_confirm
  ```

  如用户明确批准最终提交，建议提交信息：

  ```text
  新增会话操作确认设置 / feat(frontend): add session operation confirmation
  ```
