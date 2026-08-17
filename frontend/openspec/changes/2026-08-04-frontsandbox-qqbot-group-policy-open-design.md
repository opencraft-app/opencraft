# QQ Bot Group Chat Auto-Open Design

**Status:** 设计稿，待确认后实施。

**Branch:** `frontsandbox/qqbot-group-policy-open`

**Goal:** 用户在 LightVela 通道配置 SDK 的 QQ 配置卡片中，通过扫码或 AppID / Secret 完成 QQ Bot 绑定后，自动通过实例 `debug/exec` 执行 Hermes 配置命令，把 QQ 群聊策略切到 `open`，使群内用户可以直接 @ Hermes Agent 对话。

## 背景与现状

- 目标命令：

```bash
hermes config set platforms.qqbot.extra.group_policy open
```

- 当前前端实际渲染通道配置页的是 `TeaSdkSettingsPanel`，它动态加载 `@tencent/tea-sdk-lightclaw@1.10.1`，并把宿主侧的 `runCommand` / `getInvocationTask` 注入 SDK。
- SDK 的命令最终由 `frontend/src/pages/marketing/agent-tat-adapter.ts` 解码 Base64 后下发到 mono 后端：
  - `POST /v1/instances/:botId/debug/exec`
  - `body.command` 为明文命令
- SDK 1.10.1 的 QQ 绑定路径：
  - 扫码：`acli gateway qr-url --platform qqbot --wait true`
  - AppID / Secret：`acli configure gateway qqbot --app-id ... --client-secret ...`
  - 两条成功路径都会调用 `onConnectSuccess('qqbot')`
- SDK 对 Hermes 通道配置默认不再前端重启网关，因为 `acli configure gateway ...` 内部会处理重启。若在 `onConnectSuccess('qqbot')` 后再执行 `hermes config set ... group_policy open` 并重启，会导致 AppID / Secret 绑定路径出现两次 gateway restart。

## 推荐方案

宿主侧在 debug/exec 适配器内改写 SDK 下发的 QQ 绑定命令，把 group policy 设置并入同一次远端命令执行，不改 SDK 包、不等待 SDK 发版，并避免 AppID / Secret 路径重复重启。

### 1. 增加 QQ 群聊策略 helper

新增文件：

```text
frontend/src/pages/marketing/agent-qqbot-group-policy.ts
```

建议职责：

- 导出常量：
  - `QQBOT_GROUP_POLICY_OPEN_COMMAND`
  - `QQBOT_MANUAL_BIND_COMMAND_PATTERN`
  - `QQBOT_QR_BIND_COMMAND_PATTERN`
- 导出纯函数：
  - `isQqbotConnectCommand(command: string): boolean`
  - `isQqbotGroupPolicyOpenCommand(command: string): boolean`
  - `buildQqbotGroupPolicyInjectedCommand(command: string): string`

主路径不再走成功后的 `runQqbotGroupPolicyOpen + restart`。`buildQqbotGroupPolicyInjectedCommand` 生成同一次 debug/exec 里的包装命令：

```bash
set -e
hermes config set platforms.qqbot.extra.group_policy open
<SDK 原始 QQ 绑定命令>
```

因此 AppID / Secret 路径等价于：

```bash
set -e
hermes config set platforms.qqbot.extra.group_policy open
acli configure gateway qqbot --app-id '...' --client-secret '...'
```

`set -e` 保证 group policy 写入失败时不会继续执行 QQ 绑定命令。`acli configure gateway qqbot` 继续负责它内部已有的配置写入与 gateway restart，避免前端额外再重启一次。

实施前必须在测试实例验证：

```bash
hermes config set platforms.qqbot.extra.group_policy open
acli configure gateway qqbot --app-id '...' --client-secret '...'
hermes config get platforms.qqbot.extra.group_policy
```

如果最终仍是 `open`，说明 `acli configure gateway qqbot` 不覆盖 `platforms.qqbot.extra`，可以采用该前置注入方案；如果被覆盖，则前端包装命令无法做到“只重启一次且稳定生效”，需要推动 `acli configure gateway qqbot` 原生支持 `group_policy=open`，或接受兜底路径的二次重启。

如果未来 SDK 回调路径绕过 debug/exec 适配器，可再补一个兜底函数。兜底顺序才是 `hermes config set ... open` 后再 `acli gateway restart`。

成功判定复用 `isExecCommandSucceeded`，避免重复处理 `SUCCESS / SUCCEEDED / success`。

### 2. 在 debug/exec 适配器中支持命令改写

扩展 `DebugExecCommandLifecycle`：

```ts
export interface DebugExecCommandLifecycle {
  transformCommand?: (context: DebugExecCommandContext) => Promise<string | undefined> | string | undefined;
  beforeExecute?: (context: DebugExecCommandContext) => Promise<unknown>;
  afterExecute?: (context: DebugExecCommandContext & {
    metadata: unknown;
    result: DebugExecCommandResult;
  }) => Promise<void>;
}
```

在 `createMonoDebugExecAdapter.runCommand` 中：

```ts
const decodedCommand = b64.decode(data.Content ?? "");
const transformedCommand = await commandLifecycle?.transformCommand?.({ botId, command: decodedCommand });
const command = transformedCommand ?? decodedCommand;
const metadata = await commandLifecycle?.beforeExecute?.({ botId, command });
```

QQ lifecycle 的 transform 逻辑：

```ts
transformCommand: ({ command }) => {
  if (!isQqbotConnectCommand(command)) return undefined;
  return buildQqbotGroupPolicyInjectedCommand(command);
}
```

这样扫码与 AppID / Secret 两条路径都在原 debug/exec 调用里完成 group policy 写入。

### 3. 组合 command lifecycle 作为保护网

当前 `createMonoDebugExecAdapter` 只接收一个 `commandLifecycle`，而页面已经传入 `automationModelCommandLifecycle`。为避免覆盖模型切换后的自动任务同步，新增组合 helper：

```text
frontend/src/pages/marketing/agent-debug-exec-lifecycle.ts
```

建议 API：

```ts
export function composeDebugExecCommandLifecycles(
  ...lifecycles: Array<DebugExecCommandLifecycle | null | undefined>
): DebugExecCommandLifecycle
```

组合规则：

- `transformCommand` 顺序执行；若多个 lifecycle 都返回新命令，后一个基于前一个结果继续变换。
- `beforeExecute` 顺序执行每个 lifecycle，收集每个返回的 metadata。
- `afterExecute` 顺序执行，并把对应 metadata 传回对应 lifecycle。
- 任一 `beforeExecute` 抛错时保持现有行为：阻止命令执行。
- `afterExecute` 内部错误只影响对应后置动作，不应吞掉原命令结果；业务 helper 自己负责 toast。

QQ lifecycle 是主触发点：

- 命中 `acli configure gateway qqbot ...` 时，改写为 `hermes config set ... open` + 原命令。
- 命中 `acli gateway qr-url --platform qqbot --wait true` 时，改写为 `hermes config set ... open` + 原命令。
- 不命中 QQ 绑定命令时不改写，避免影响微信、飞书、模型切换等其他命令。

### 4. 用户提示与降级策略

默认不把 QQ 绑定成功改成失败。

- 主路径执行成功：SDK 仍展示原 QQ 绑定成功提示；可补充 toast “QQ 群聊已开启，群内 @ Hermes Agent 即可对话。”
- 注入后的组合命令失败：沿用 SDK 的绑定失败表现，因为此时 QQ 绑定命令本身未完成或无法确认完成。
- 兜底路径 group_policy 成功但重启失败：toast warning，例如“QQ 已绑定，群聊配置已保存；网关重启失败，请稍后重试或到诊断页手动重启。”
- 兜底路径 group_policy 命令失败：toast warning，例如“QQ 已绑定，但群聊自动开启失败，请稍后重试。”

原因：QQ 私聊 / 基础绑定已经成功，群聊开启属于增强步骤；失败时不应让用户误以为 QQ 绑定完全失败。

### 5. 文档与文案

更新：

- `frontend/src/content/docs/configuration/channel-qq.md`
- `frontend/src/content/docs/en/configuration/channel-qq.md`

把“暂不建议加入 QQ 群聊”替换为：

- 绑定完成后默认开启群聊 @ 对话。
- 当前策略为 `open`：机器人所在 QQ 群内成员均可 @ 机器人发起对话。
- 若后续要收敛到指定群，应使用 Hermes 的 allowlist 策略。
- 普通不 @ 的群消息仍不作为当前前端能力承诺。

## 备选方案

### A. SDK 原生扩展

在 `@tencent/tea-sdk-lightclaw` 增加 `onChannelConfigured` 或 channel lifecycle metadata，由 SDK 成功后主动调用宿主动作。

优点：语义最干净，无需命令识别。

缺点：需要改 SDK、发版、升级 `frontend/package.json` 和 lockfile，链路更长。

### B. 后端 `/channels/config` 内置 group_policy

在后端 QQ channel config 接口绑定成功后写入 group_policy。

优点：覆盖所有前端客户端，行为最一致。

缺点：当前实际通道配置页已走 SDK + debug/exec，老的 `configureQQChannel` 不是主路径；后端改动超出本次“SDK QQ 卡片通过 exec/debug 执行”的范围。

## 测试矩阵

### 单元测试

- `agent-qqbot-group-policy.test.ts`
  - `isQqbotConnectCommand` 能识别 `acli configure gateway qqbot ...`
  - 能识别 `acli gateway qr-url --platform qqbot --wait true`
  - 不误判 `weixin / feishu / model switch / group_policy open` 本身
  - `buildQqbotGroupPolicyInjectedCommand` 在原 QQ 命令前注入 `hermes config set platforms.qqbot.extra.group_policy open`
  - 重复包装时保持幂等，不重复注入 group_policy
  - 兜底路径 group_policy 失败返回 failed，不抛出导致主流程失败
  - 兜底路径 restart 失败返回 partial
- `agent-debug-exec-lifecycle.test.ts`
  - transformCommand 能改写 pending command，实际 POST 的 command 是改写后的命令
  - 多个 lifecycle 的 before/after 顺序正确
  - metadata 能对应传回
  - before 抛错阻止命令执行
  - after 某个失败不会破坏其他后置动作的可观测反馈
- `agent-settings-sdk-boundary.test.ts`
  - SDK channel panel 继续通过 stable host 渲染
  - `commandLifecycle` 使用组合后的 lifecycle，不丢失自动任务同步

### 集成/回归测试

- AppID / Secret 绑定成功后：
  - 首次 debug/exec 命令为 `hermes config set platforms.qqbot.extra.group_policy open` + `acli configure gateway qqbot ...`
  - 不额外追加第二次 `acli gateway restart`
- QQ 扫码成功后：
  - debug/exec 流式命令为 `hermes config set platforms.qqbot.extra.group_policy open` + `acli gateway qr-url --platform qqbot --wait true`
  - 二维码 URL 与扫码成功状态仍能正常从流式输出中解析
- 非 QQ 通道绑定不触发 group_policy。
- 模型切换后自动任务同步仍触发。

### 手工验证

1. 启动前端本地环境，进入 `/agents/channel`。
2. 使用 QQ AppID / Secret 完成绑定，观察 Network 中 `/debug/exec` 顺序。
3. 在实例上执行：

```bash
hermes config get platforms.qqbot.extra.group_policy
```

预期输出为 `open`。

4. 将 QQ Bot 加入测试群，在群内 @ 机器人，应能收到回复。
5. 切换到模型设置执行模型切换，确认自动任务同步弹窗/后置 toast 仍工作。

## 风险与边界

- `group_policy=open` 表示机器人所在任意 QQ 群成员均可 @ 机器人对话；这是本需求的目标默认值，但需要在文档中写明权限含义。
- 该能力只保证群内 @ 触发；不承诺普通未 @ 群消息回复。
- Hermes 全局用户记忆不是 per QQ member 隔离，本次只处理群聊开关，不处理群成员身份记忆隔离。
- 若实例 Hermes 版本过旧、不支持该 config key，应展示 warning 并保留 QQ 私聊绑定成功态。
- 不在前端保存 AppSecret，也不在日志、toast、文档中暴露用户密钥。

## 实施步骤

1. 新增 QQ group policy helper 与单测。
2. 新增 lifecycle compose helper 与单测。
3. 修改 `agent-tat-adapter.ts`：支持 `transformCommand`，在命令入队前完成 QQ 命令包装。
4. 修改 `AgentSettingsPage`：组合 automation 与 QQ lifecycle，不覆盖现有模型自动任务同步。
5. 更新 QQ 通道中英文文档。
6. 跑相关 Vitest 与前端 check。
7. 用户验收后再提交 / push / MR。
