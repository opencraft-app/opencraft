# 可视化联调独立指令 — 详细执行流程

> 本文档描述用户直接要求「开启可视化联调」时的完整执行步骤。行为树入口见 `SKILL.md` 的「联调指令」章节。

---

## 触发条件

用户的指令中包含"联调"、"debug"、"可视化联调"等关键词，且意图是开启实时联调（而非完整的埋点接入流程）。

---

## 第 1 步：检测项目 SDK 类型

扫描项目中的 `package.json` 和源代码 import 语句，判断使用的 SDK 类型：

| 检测关键词 | SDK 类型 | `sdkType` 参数值 |
|-----------|---------|-----------------|
| `@tencent/beacon-web-sdk` 或 `BeaconAction` | 轻量版 | `beacon` |
| `@tencent/universal-report` 或 `UniversalReport` | 标准版 | `universal_report` |
| 未检测到 | — | 默认 `beacon` |

---

## 第 2 步：收集联调所需参数

`start_realtime_debug_mode` 工具需要 `appId` 和 `appkey` 两个必填参数。按以下优先级获取：

### 优先级 1：从对话上下文中获取

用户在之前的对话中已经提供过 appId / appkey / 埋点信息码等。

### 优先级 2：从本地已保存的埋点信息中提取

- 扫描 `dt_tracking_plan/state.json` → 从 `app_id` 字段直接获取（v2 方案：所有产物集中在 `dt_tracking_plan/`）
- 扫描项目根目录 → 查找 `package.json` 中的 appId 配置（如果有自定义配置）

### 优先级 3：从项目 SDK 初始化代码中提取

- 搜索项目源码中 `BeaconAction` / `UniversalReport` 的初始化代码，提取 `appkey`
- 有 `appkey` 但缺 `appId` 时 → 调用 `get_by_appkey(appKey)` 通过 appkey 获取 appId
  - ⚠️ 该工具使用 `https://datong-test.mcp.it.woa.com` 网关
  - 调用失败时再询问用户提供 appId

### 优先级 4：询问用户

以上途径均无法获取时，直接询问用户提供 `appId` 和 `appkey`。

---

## `source` 参数自动推断

> **v2 改造**：v1 的 `dt_tracking_info/` 目录（埋点信息码）已废弃，A 路径统一走 `get_flow` / `list_page_structure` / `get_page_structure` / `list_event_node` 拉取变更，**默认都是 `datong` 链接**。

| appId 来源 | `source` 值 |
|-----------|------------|
| `dt_tracking_plan/state.json` | `datong` |
| 项目 SDK 初始化代码 | `datong` |
| 无法确认 | 不传（工具默认使用 datong 链接） |

---

## 第 3 步：调用工具获取 debugId

收集到参数后，调用 `start_realtime_debug_mode(appId, appkey, sdkType, source)` 获取 debugId 和联调链接。

#### 📡 [TRACK] 独立联调入口 → 上报 `debug_session_started`

> ⚠️ 本上报点遵循 `SKILL.md` 顶部「🔒 埋点上报硬性约束」的全部规则（静默执行、绝对路径、数据脱敏、失败容忍）。

**触发时机**：用户从「联调指令独立入口」进入（非主流程衔接），调用 `start_realtime_debug_mode` 之后**立即**上报。
**说明**：本上报点与 `SKILL.md` Step 4（主流程衔接）共用同一事件名 `debug_session_started`，用 `entry` 字段区分入口；本入口固定填 `standalone`。
**字段**：
- `entry` = `standalone`（本入口固定为这个值；主流程衔接入口请走 `SKILL.md` Step 4）
- `debug_id_obtained` ∈ `true | false`（调用是否成功拿到 debugId）
- `sdk_kind` ∈ `beacon | universal_report | none`

```bash
bash "${CLAUDE_SKILL_DIR}/tools/report.sh" event debug_session_started '{"entry":"standalone","debug_id_obtained":"<true|false>","sdk_kind":"<beacon|universal_report|none>"}'
```

---

## 第 4 步：配置 debugId 并启动本地应用

> ⚠️ **联调必须在本地应用运行状态下进行**，否则联调页面无法接收到任何上报数据。

### 4.1 将 debugId 配置到 SDK 初始化代码

> 🚨🚨🚨 **严格格式约束**：修改用户 SDK 初始化代码时，**必须严格遵循以下模板**，不允许自由发挥格式。核心原则：**增量插入字段，不重写初始化块**。

#### 修改策略（适用于所有 SDK 类型）

1. **定位**：在用户项目中找到 SDK 初始化代码（`new UniversalReport({...})` 或 `new BeaconAction({...})`）
2. **增量插入**：仅在对应位置添加联调字段，保持用户原有代码的缩进风格、引号风格、尾逗号风格不变
3. **添加注释**：每个联调字段末尾必须加 `// 联调模式，上线前删除`
4. **禁止重写**：不要删除或替换用户已有的初始化代码块，只做字段插入

#### 标准版 SDK（UniversalReport）— 精确模板

找到用户的 `new UniversalReport({...})` 初始化代码，在 `beaconOptions` 对象内添加 `debugId` 和 `appId` 字段：

```javascript
// ✅ 正确格式（在已有 beaconOptions 中插入字段）
const reporter = new UniversalReport({
  beacon: '<用户已有的appkey>',
  enableNoCodeTracking: false,
  beaconOptions: {
    debugId: '<工具返回的debugId>',   // 联调模式，上线前删除
    appId: '<工具返回的appId>',          // 联调模式，上线前删除
  },
})
```

**关键规则：**
- `debugId` 和 `appId` 必须放在 `beaconOptions` 对象内部
- 如果用户代码中没有 `beaconOptions`，则新增该字段
- 如果用户代码中已有 `beaconOptions`，则在其内部追加 `debugId` 和 `appId`
- 保持用户原有的其他配置字段不动（如 `enableNoCodeTracking`、`plugins` 等）

#### 轻量版 SDK（BeaconAction）— 精确模板

找到用户的 `new BeaconAction({...})` 初始化代码，在初始化对象中添加 `debugId` 和 `appId` 字段：

```javascript
// ✅ 正确格式（在已有初始化参数中插入字段）
const beacon = new BeaconAction({
  appkey: '<用户已有的appkey>',
  debugId: '<工具返回的debugId>',   // 联调模式，上线前删除
  appId: '<工具返回的appId>',          // 联调模式，上线前删除
})
```

**关键规则：**
- `debugId` 和 `appId` 直接放在初始化对象的顶层（与 `appkey` 同级）
- 保持用户原有的其他配置字段不动

#### ❌ 常见错误示例（禁止）

```javascript
// ❌ 错误 1：重写整个初始化块（丢失用户已有配置）
const reporter = new UniversalReport({
    beacon: 'xxx',
    beaconOptions: {
        debugId: 'xxx',
        appId: 'xxx'
    }
});

// ❌ 错误 2：debugId 放在 beaconOptions 外面（标准版 SDK）
const reporter = new UniversalReport({
  beacon: 'xxx',
  debugId: 'xxx',   // 错！标准版应放在 beaconOptions 内
})

// ❌ 错误 3：缺少联调注释
beaconOptions: {
  debugId: 'xxx',   // 缺少 "// 联调模式，上线前删除"
}

// ❌ 错误 4：使用 4 空格缩进（应跟随用户项目风格）
```

#### 联调完成后的清理

联调验证通过后，需要移除的字段：
- `beaconOptions.debugId`（标准版）或顶层 `debugId`（轻量版）
- `beaconOptions.appId`（标准版）或顶层 `appId`（轻量版）
- 如果 `beaconOptions` 被清空，可以整个移除

### 4.2 检测并引导本地应用启动

根据项目技术栈检测启动方式并引导用户启动：

| 项目类型 | 检测方式 | 推荐启动命令 |
|---------|---------|------------|
| H5/Web（有 `package.json`） | 读取 `scripts` 字段中的 `dev` / `start` / `serve` | `npm run dev` 或 `npm start` |
| Vite 项目 | 检测到 `vite` 依赖 | `npm run dev`（默认 http://localhost:5173） |
| Webpack 项目 | 检测到 `webpack-dev-server` | `npm start`（默认 http://localhost:8080） |
| Android 项目 | 检测到 `build.gradle` | 提示通过 Android Studio 运行到模拟器/真机 |
| iOS 项目 | 检测到 `.xcodeproj` / `.xcworkspace` | 提示通过 Xcode 运行到模拟器/真机 |

**执行逻辑：**

1. 如果是 Web 项目，**主动帮用户在终端启动应用**（执行对应的 dev/start 命令）
2. 如果是 Android/iOS 项目，提示用户手动通过 IDE 启动
3. 如果检测到项目已有进程在监听对应端口（如 `lsof -i :5173`），则跳过启动，提示"检测到应用已在运行"

### 4.3 返回联调结果

启动完成后，向用户输出：

1. ✅ debugId 已配置到 SDK 初始化代码（说明修改了哪个文件）
2. ✅ 本地应用已启动 / 请启动本地应用
3. 🔗 联调页面链接（用户可打开浏览器查看实时上报数据）
4. ⚠️ 联调完成后记得移除 `debugId` 配置

> ⚠️ 只需要返回工具的结果和上述引导信息，不要额外生成说明文档或 README。
>
> 📖 工具参数详情见 `mcp-tools.md` 的 `start_realtime_debug_mode` 章节。
