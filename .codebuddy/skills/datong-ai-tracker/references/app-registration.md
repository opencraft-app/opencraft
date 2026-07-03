# 大同应用注册与 appkey 检测

> 本文档描述如何检测项目是否已有 appkey（已注册大同应用），以及未注册时如何通过接口自动注册。

---

## 触发时机

在 **Step 1.5（用户路径选择）** 完成后执行。A/B 路径均会进入此步骤，区别在于注册行为不同。

---

## Step 1.2：检测 appkey 与应用注册

### 检测项目中是否已有 appkey

根据 Step 1 识别出的技术栈和 SDK 类型，在 SDK 初始化代码中查找 appkey：

**H5 项目**

| SDK 类型 | 检测关键词 / 模式 | 示例 |
|---------|-----------------|------|
| beacon-web-sdk（轻量版） | `new BeaconAction({ appkey: '...' })` | `appkey: '0WEB06RUYRTDUDYY'` |
| universal-report（标准版） | `new UniversalReport({ beacon: '...' })` | `beacon: '0WEB06RUYRTDUDYY'`（⚠️ 字段名是 `beacon` 不是 `appkey`） |
| autotracker（无埋点版） | `new AutoTrackBeacon({ report: { appkey: '...' } })` | `report: { appkey: '0WEB06RUYRTDUDYY' }` |

**Android 项目**

| SDK 类型 | 检测关键词 / 模式 | 示例 |
|---------|-----------------|------|
| beacon-android（灯塔 SDK） | `BeaconReport.getInstance().start(context, "...", config)` | `start()` 方法的第二个 String 参数 |
| videoreport-DT（采集 SDK） | `DTParamKey.REPORT_KEY_APPKEY` 或 `VideoReportKit.init(this, "...")` | 采集 SDK 自身不直接传 appkey，通过上报回调转发给灯塔 SDK |

**iOS 项目**

| SDK 类型 | 检测关键词 / 模式 | 示例 |
|---------|-----------------|------|
| beacon-ios（灯塔 SDK） | `startWithAppkey:@"..."` | `[BeaconReport.sharedInstance startWithAppkey:@"YOUR_APP_KEY" config:nil]` |
| videoreport-ios（采集 SDK） | `reportEvent.appKey` | 采集 SDK 自身不直接传 appkey，通过上报回调中 `appKey` 属性转发 |

**通用检测位置**

| 检测位置 | 关键词 / 模式 | 说明 |
|---------|-------------|------|
| 环境变量 / 配置文件 | `.env`、`config.ts`、`config.json` 中含 `appkey`、`appKey`、`APP_KEY` 字段 | 如 `VITE_APPKEY=xxx` |
| 对话上下文 | 用户主动提供 appkey | 直接使用 |

### 判断逻辑

| 条件 | 结果 |
|------|------|
| 检测到 appkey | → 记录 appkey，继续后续步骤（A路径进入 Step 2，B路径进入 Step 3） |
| 未检测到 appkey，且当前为 **B路径（从零开始）** | → **自动注册**（无需询问用户），直接执行注册流程 |
| 未检测到 appkey，且当前为非B路径 | → 提示用户确认是否需要注册大同应用 |

---

## B路径自动注册（从零开始时必须执行）

> ⚠️ 当用户选择「从零开始」路径时，注册应用是全流程的必要前置步骤，**直接自动执行，无需询问用户确认**。

### appId 和 name 自动生成规则

| 来源 | 生成规则 | 示例 |
|------|---------|------|
| 项目目录名 / `package.json` 的 `name` 字段 | 取项目名，去除特殊字符（横杠转下划线），截取前 30 字符 | 项目名 `meituan-takeout` → appId: `meituan_takeout` |
| 若项目名含中文 | 使用英文翻译或拼音缩写 | 项目名 `美团外卖` → appId: `meituan_takeout` |
| name（应用名称） | 直接使用项目名（中文优先），不能包含横杠 | `美团外卖` 或 `meituan_takeout` |

### 自动注册执行流程

```
1. 根据项目信息自动生成 appId（code）和 name
2. 调用 create_app(code=appId, name=appName) 注册
3. 如果返回 code/name 重复 → 自动在 appId 末尾追加随机后缀（如 _01、_02）重试
4. 最多重试 3 次
5. 注册成功 → 记录 appkey，写入 SDK 初始化代码，继续流程
6. 3 次均失败 → 降级为占位符 YOUR_APPKEY，提醒用户手动注册
```

### 自动重试策略

| 重试次数 | appId 变化 | 示例 |
|:--------:|-----------|------|
| 第 1 次（首次） | 原始 appId | `meituan_takeout` |
| 第 2 次 | 追加 `_01` | `meituan_takeout_01` |
| 第 3 次 | 追加 `_02` | `meituan_takeout_02` |

> ⚠️ name 重复时同理，在 name 后追加数字后缀（如 `美团外卖2`、`美团外卖3`）。

### 自动注册成功后

直接告知用户注册结果并继续流程，不需要等待用户确认：

```markdown
✅ 大同应用已自动注册！

- 应用标识：{appId}
- 应用名称：{appName}
- appkey：`{appkey}`

已将 appkey 配置到 SDK 初始化代码中，继续为你设计埋点方案...
```

---

## 非B路径的注册（需用户确认）

### 未检测到 appkey 时的处理

向用户确认：

```markdown
未检测到项目中的大同 appkey，需要先注册一个大同应用才能使用上报功能。

是否帮你自动注册一个大同应用？注册后会获得 appkey，用于 SDK 初始化。
```

| 用户选择 | 后续 |
|---------|----- |
| 是 / 注册 | → 调用注册接口获取 appkey → 写入 SDK 初始化代码 → 继续后续步骤（Step 2） |
| 已有 appkey | → 等用户提供 → 记录后继续后续步骤（Step 2） |
| 否 / 跳过 | → 使用占位符 `YOUR_APPKEY` 继续流程（见下方"注册失败或跳过"章节） |

---

## 注册大同应用

### 调用方式
** MCP 工具直接调用 **

调用 `create_app` 工具进行创建应用
注意： 该tool需要提供code参数为大同应用的标识appId，只能有字母、数字、下划线组成，不能出现其他符号；可以根据项目名起，或者由用户提供；若返回结果表明code已重复，可尝试换新code值(也需满足字母、数字、下划线组成，不能出现其他符号原则)进行注册。如果出现三次注册存在重复，可以咨询用户提供。 name参数为应用名称，不能出现横杆，同样code一样，如果返回结果表明name重复，可以重新其他name注册， 或咨询用户提供。


### 返回值

接口返回注册成功的应用信息，包含 `appkey`。

### 注册后操作

1. **记录返回的 appkey**
2. **写入 SDK 初始化代码**：将 appkey 填入 SDK 初始化配置中（如果 Step 1 已生成初始化代码）
3. **告知用户**：

```markdown
✅ 大同应用注册成功！

- 应用名称：{appName}
- appkey：`{appkey}`

已将 appkey 配置到 SDK 初始化代码中。
```

4. 继续后续步骤（A路径进入 Step 2 获取埋点信息，B路径进入 Step 3 从零设计方案）

---

## 注册失败或跳过的处理

### 情况一：appId 或 name 重名

当 `create_app` 返回错误提示 appId 或 name 已存在时：

> ⚠️ **无论 A/B 路径，遇到重名一律先自动换名重试，不立即询问用户。**

**自动换名重试策略（适用于所有路径）：**

```
1. 第 1 次注册失败（code/name 重复）→ 自动在原始值末尾追加 _01 重试
2. 第 2 次注册失败 → 追加 _02 重试
3. 第 3 次注册失败 → 追加 _03 重试
4. 3 次均失败 → 询问用户提供新的 appId / name
```

| 重试次数 | appId（code）变化 | name 变化 | 示例 |
|:--------:|-----------------|----------|------|
| 第 1 次（首次） | 原始值 | 原始值 | code: `meituan_takeout`, name: `美团外卖` |
| 第 2 次 | 追加 `_01` | 追加 `2` | code: `meituan_takeout_01`, name: `美团外卖2` |
| 第 3 次 | 追加 `_02` | 追加 `3` | code: `meituan_takeout_02`, name: `美团外卖3` |
| 第 4 次 | 追加 `_03` | 追加 `4` | code: `meituan_takeout_03`, name: `美团外卖4` |

**注意事项：**
- 如果返回结果明确指出是 code 重复，则只换 code；如果是 name 重复，则只换 name；如果都重复，则都换
- code 只能由字母、数字、下划线组成，追加后缀时保持此规则
- name 不能包含横杠

**3 次重试均失败后，询问用户：**

```markdown
⚠️ 自动注册多次未成功（应用标识/名称均已被占用）。

请提供一个新的应用标识（appId）和应用名称，我会用新信息重新注册：
- appId 规则：仅字母、数字、下划线
- 应用名称：不能包含横杠

如不确定可用名称，可前往大同平台查看：👉 https://trackmate.woa.com
```

用户提供新信息后，使用新的 appId/name 重新调用 `create_app` 注册（仍遵循上述重试策略）。

### 情况二：其他失败或用户跳过

当注册接口调用失败（网络异常、服务不可用等）或用户选择跳过时：

1. **SDK 初始化代码中使用占位符 `YOUR_APPKEY`**，不阻断后续流程
2. **必须向用户发出以下提醒**：

```markdown
⚠️ 大同应用注册未完成，当前 appkey 使用了占位符 `YOUR_APPKEY`。

埋点代码已正常生成，但上报功能需要真实 appkey 才能生效。
请前往大同平台手动注册应用并替换 appkey：

👉 https://trackmate.woa.com

注册后，将获得的 appkey 替换代码中的 `YOUR_APPKEY` 即可。
```

3. **在生成的初始化代码中添加 TODO 注释**：

```javascript
appkey: 'YOUR_APPKEY', // TODO: 请替换为真实 appkey，前往 https://trackmate.woa.com 注册获取
```

4. 继续 Step 1.5 及后续流程，正常生成埋点代码

#### 📡 [TRACK] 检测/注册流程结束 → 上报 `appkey_register_result`

> ⚠️ 本上报点遵循 `SKILL.md` 顶部「🔒 埋点上报硬性约束」的全部规则（静默执行、绝对路径、数据脱敏、失败容忍）。

**触发时机**：Step 1.2 整个流程结束（不论命中以下任何分支）后**立即**上报一次：
- 项目中检测到 appkey
- 用户主动提供 appkey
- B 路径自动注册成功
- A 路径用户确认后注册成功
- 注册重试 3 次失败、降级为占位符
- 用户主动跳过

**字段**：
- `register_status` ∈ `success | fail | placeholder | skipped`
  - `success`：注册成功 或 检测/用户提供命中
  - `fail`：注册接口本次调用失败（仍可能后续重试）
  - `placeholder`：重试 3 次仍失败，已降级为占位符
  - `skipped`：用户主动跳过注册
- `appkey_source` ∈ `detected | user_provided | registered | none`
- `path_type` ∈ `A | B`
- `fail_reason`（仅 `fail` / `placeholder` 时填）∈ `name_conflict | network | auth | user_skip | other`
- `retry_count` ∈ `0 | 1 | 2 | 3`
- 🚫 禁止上报 appkey / appId 明文，禁止上报 `name` 字段内容

```bash
bash "${CLAUDE_SKILL_DIR}/tools/report.sh" event appkey_register_result '{"register_status":"<success|fail|placeholder|skipped>","appkey_source":"<detected|user_provided|registered|none>","path_type":"<A|B>","fail_reason":"<name_conflict|network|auth|user_skip|other|>","retry_count":"<0|1|2|3>"}'
```

---

## 注意事项

- appkey 是 SDK 初始化的必要参数，没有 appkey 将无法正常上报数据，但不影响代码生成
- 如果用户已有 appkey 但未在代码中配置，直接使用用户提供的即可，无需重复注册
- 注册接口地址：`https://datong-test.mcp.it.woa.com`
- 大同平台（手动注册）：`https://trackmate.woa.com`
