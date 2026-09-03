# 命令细则

`ENGINE` 指本 skill 目录下的 `scripts/engine.mjs`；全局 `feai native <cmd>` 与之等价。所有命令在**项目根**执行（引擎以 cwd 为项目根）。输出本为 JSON，`--json` 建议常带以显式声明。

## new — 启动 change

```bash
node ENGINE new --name <kebab-slug> --json
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--name` | 是 | change 名，kebab-case（小写字母/数字/中划线） |

- 已有 active change → 65（先归档或处理完）；发现已共享、但尚未在本工作树选择恢复的 brief → 65（先 `resume`）；change 目录已存在 → 65。
- 成功后进入首个阶段（shape），指针写入 `.workflow/native/current.json`。

## status — 当前状态

```bash
node ENGINE status --json
```

无参数。开工/恢复第一步；只读（外加指针自愈），不加锁，任何时候都安全。

- 无 active change 且无共享候选：`active: false`，continuation 为 `await-user / no-active-change`。
- 无本地指针但存在 `changes/<name>/brief.md`：返回候选列表，continuation 为 `await-user / resume-selection-required`；先显式选择 `resume`，避免误接管别人的进行中需求。
- 指针指向已消失的 change（如 archive 崩溃残留）：自动删指针自愈，返回 `healed: true`；若仍有共享 brief，同样显示为候选。

## resume — 在当前工作树恢复已共享 change

```bash
node ENGINE resume --name <kebab-slug> --json
```

- 需要 `changes/<name>/brief.md` 存在；它是跨工作树共享的最小契约。
- 当前工作树存在另一 active change 时拒绝，不会覆盖指针。
- 若本地 `state.yaml` 不存在（正常：它被 Git 忽略），引擎从 brief 重建状态到 shape，响应含 `reconstructed: true`，之后必须重新确认 brief 才会进入 build。
- 若 state 已在本地存在，直接恢复原阶段，响应为 `reconstructed: false`。

## next — 推进

```bash
node ENGINE next [--summary "..."] [--outcome pass|fail] [--signature <tag>] [--report "..."] [--confirmed] [--expect-revision N] --json
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--summary` | 视阶段 | 推进摘要。build 步必填（`require_field: summary`）；shape/verify 建议带 |
| `--outcome` | 视阶段 | 当前步有分支时必传（verify: `pass`\|`fail`；archive: `done`）；无分支的步传了报 64 |
| `--report` | verify 且 outcome=pass 时必填 | 验证结论摘要（verify 步 `require_field: report`）。`--outcome fail` 的回退不查 guards，不需要 |
| `--signature` | outcome=fail 时必填 | 失败类别短标签（如 `login-test-timeout`），用于重复失败追踪 |
| `--confirmed` | 否 | 布尔开关。① 批准 contract（按 brief.md 当前内容 hash）；② repair 停止时 override 一次 |
| `--expect-revision` | 否 | 乐观并发：与当前 revision 不符 → 73，重新 status 后重试 |
| `--json` | 建议 | 显式声明 JSON 输出（输出本即 JSON） |

行为要点：

- guards（require_field / require_approval）只在**完成性推进**时检查；`--outcome fail` 的回退不查（失败声明无需防伪，由失败追踪把关）。
- shape→build 需 brief.md 已批准：未批准或批准后内容漂移 → `await-user / approval-required`；向用户确认后带 `--confirmed` 重发。
- 重复失败（fail 边带 repeated-failure）：
  - 同签名连续 2 次 → 警告：照常 `continue`，findings 带 `repair-warn`；
  - 连续 3 次 → 停止：退出码 75，`blocked / repair-stopped`。有新假设可 `--confirmed` override 一次（每个签名仅一次）；
  - 累计 12 次 → 硬停：75，`blocked / repair-hard-stop`，必须找用户。
- 终态步（archive）也接受 `next --outcome done`：phase 停留本步，步状态置 done，返回 `done / complete`。常规路径仍是等用户明确要求后直接 `archive`。

## archive — 归档

```bash
node ENGINE archive --json
```

仅在用户明确要求后运行。仅终态步可归档（否则 65）。change 目录整体原子搬入 `.workflow/native/archive/`，随后清理指针，返回 `done / complete`。

## 退出码

| 码 | 含义 | 应对 |
|---|---|---|
| 0 | 正常（含 await-user——不是错误，是让你停下来问用户） | 按 continuation 行动 |
| 64 | 用法错误（参数缺失、非法 outcome 等） | 修正参数重发 |
| 65 | 状态无效（无 active change、state 损坏/不兼容、当前阶段不可归档等） | 先 status 确认再处理；勿手改文件 |
| 73 | 锁冲突或 revision 冲突 | 锁：稍后重试（残留锁由引擎自动回收）；revision：重新 status 拿新值再试 |
| 75 | repair 停止（重复失败触顶） | 有新假设可 `--confirmed` override 一次；否则停下来找用户 |

## JSON 输出字段

成功响应（new / next）：

| 字段 | 说明 |
|---|---|
| `ok` | `true` |
| `command` | 执行的命令名 |
| `change` | change 名 |
| `phase` | 当前阶段（推进后为目标阶段；回退/终态时可能不变） |
| `revision` | state revision，单调递增 |
| `replayed` | 可选。`true` = 幂等重放，见下节 |
| `continuation` | 下一步指示，结构见下 |

status 额外字段：`active`（有无 active change）、`healed`（发生指针自愈时为 `true`）；无 active 时 continuation 内 change/phase/revision 为 `null`。

archive 成功：`{ok, command, change, continuation}`，continuation 为 `done / complete`。

失败响应：`{ok: false, error: {code, message}}`，`code` ∈ `usage` / `state` / `conflict`，与退出码 64/65/73 对应；锁冲突附带 `owner`（锁持有者：pid、hostname、startedAt、command）。`repair` 错误码当前不可达（`RepairError` 已定义并被 catch，但引擎从未抛出）。

**75 停止响应没有 `error` 字段**：repair 停止（连续 3 次 / 累计 12 次）由 `next` 直接输出 `{ok: false, command, change, phase, revision, continuation}`，退出码 75——以 payload 内 `continuation`（`blocked` / `repair-stopped` 或 `repair-hard-stop`）为准判断。

### continuation

| 字段 | 说明 |
|---|---|
| `schema` | 固定 `feai.native.continuation.v1` |
| `change` / `phase` / `revision` | 当前快照 |
| `disposition` | `continue` 直接继续 / `await-user` 停下来向用户提指定问题 / `blocked` 按 findings 修复或求助 / `done` 收尾汇报 |
| `reason` | continue: `proceed`；await-user: `approval-required` / `field-missing` / `await-final-action` / `no-active-change` / `resume-selection-required`；blocked: `repair-stopped` / `repair-hard-stop`；done: `complete` |
| `findings` | 发现数组。元素含 `kind`（`field` / `approval` / `info` / `resume-candidates` / `repair-warn`）与 `detail`；guard 类另带 `guard`、`field`/`basis` |
| `suggested_command` | 建议的下一条命令（可能为 `null`） |

## 幂等语义

`next` 按请求指纹幂等：指纹 = `command + outcome + signature + summary + confirmed` 的 sha256（`--report`、`--expect-revision` 不参与）。**同一参数的请求可安全重试**（中断恢复场景）。

命中重放（指纹相同且 phase 与上次推进落点一致）时：返回上次存储的完整结果并带 `replayed: true`，**不发生新推进、不重复累计失败次数**。注意重放一律以退出码 0 返回——即使原结果是 75 的 repair 停止，也以 payload 内 `ok` / `continuation` 为准。

凡 `replayed: true` 均非新推进（无论 phase 是否变化）：上次请求已生效过，不要当作新推进。
