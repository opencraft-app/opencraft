# SDK 检测与选型详细规则

本文档详细说明如何检测项目技术栈和已引入的大同 SDK。

## 判断项目技术栈

扫描项目结构判断技术栈类型：

| 检测规则 | 技术栈 | 后续流程 |
|---------|--------|---------|
| `package.json` 中包含 `@tarojs/taro` 依赖 | Taro 小程序项目 | → 走小程序 SDK 流程 |
| 存在 `package.json` 且 **不存在** `app.json` / `project.config.json`，且无 `@tarojs/taro` 依赖 | H5 项目 | → 走 H5 SDK 选型 |
| 存在 `build.gradle` 或 `build.gradle.kts`，且包含 `com.android` 插件 | Android 项目 | → 走 Android SDK 流程 |
| 存在 `Podfile` 或 `.xcodeproj`，且包含 `.m`/`.mm`/`.swift` 源码 | iOS 项目 | → 走 iOS SDK 流程 |
| 存在 `app.json` / `project.config.json` / `app.js` / `app.ts` / `app.config.ts` / `app.config.js`，且无 `build.gradle` / `Podfile` | 小程序项目（含 Taro） | → 走小程序 SDK 流程 |
| 以上均不匹配（后端服务等） | 其他 | → 使用 API 上报方式兜底 |

---

## H5 项目：SDK 检测

扫描 `package.json` 及源代码中的 import 语句：

| 检测目标 | 包名 / 关键词 | SDK 类型 |
|---------|-------------|---------|
| 轻量版 | `@tencent/beacon-web-sdk` 或 `BeaconAction` | beacon-web-sdk |
| 标准版 | `@tencent/universal-report` 或 `UniversalReport` | universal-report |
| 无埋点版 | `autotracker-beacon-oa` 或 `AutoTrackBeacon` | autotracker |

**选型规则**：
1. 项目已引入某种 SDK → 使用已有的，不要更换
2. 项目未引入任何 SDK → 默认使用 @tencent/universal-report （标准版）
3. 如果检测到用户有自定义封装（如统一的上报工具函数），记录封装方法名，后续生成代码时复用

---

## Android 项目：SDK 检测

> **核心原则**：Android 端大部分业务方已经集成了大同相关 SDK，只需检测项目中已引入的 SDK 类型，加载对应文档即可。**不要主动推荐更换 SDK，不要改动业务已有的 SDK 初始化代码**，Android 端的需求通常只是**新增上报事件**。

扫描 `build.gradle` 依赖和源代码中的 import 语句：

| 检测目标 | 包名 / 关键词 | SDK 类型 |
|---------|-------------|---------|
| 灯塔 Android SDK（上报） | `com.tencent.beacon:beacon-android-release` 或 `BeaconReport` | beacon-android |
| 大同采集 SDK | `com.tencent.qqlive.modules:videoreport-DT` 或 `VideoReport` | videoreport-DT |
| 大同插桩插件 | `videoreport-plugin-DT` 或 `videoreport-plugin-gradle` | videoreport-plugin |

**选型规则**：
1. **只检测、不推荐更换**：扫描项目中已引入的大同相关 SDK，直接使用项目已有的 SDK
2. 项目同时引入了采集 SDK 和灯塔 SDK → 加载采集 SDK 文档，使用采集 SDK 接口
3. 项目仅引入了灯塔 SDK → 加载灯塔 SDK 文档
4. 如果检测到用户有自定义封装，记录封装方式，后续生成代码时复用
5. 项目未引入任何大同 SDK → **询问用户**使用哪个 SDK，不要自行决定

**⚠️ 重要约束**：
- **不要改动 SDK 初始化代码**：业务方的 SDK 初始化已配置好，不要修改
- **聚焦新增上报事件**：只需要在对应位置添加上报调用代码
- **保持现有代码风格**：新增代码要与已有上报代码风格一致

---

## iOS 项目：SDK 检测

> **核心原则**：iOS 端大部分业务方已经集成了大同相关 SDK，只需检测项目中已引入的 SDK 类型，加载对应文档即可。**不要主动推荐更换 SDK，不要改动业务已有的 SDK 初始化代码**，iOS 端的需求通常只是**新增上报事件**。

扫描 `Podfile` 依赖和源代码中的 import 语句：

| 检测目标 | 包名 / 关键词 | SDK 类型 |
|---------|-------------|---------|
| 灯塔 iOS SDK（上报） | `Podfile` 中 `pod 'Beacon'` 或 `#import <BeaconAPI_Base/BeaconReport.h>` 或 `BeaconReport.sharedInstance` | beacon-ios |
| 大同采集 SDK | `Podfile` 中 `pod 'VideoReport'` 或 `#import "UIView+VideoReport.h"` 或 `QLVideoReport` 或 `QLVRDTReportComponent` | videoreport-ios |

**选型规则**：
1. **只检测、不推荐更换**：扫描项目中已引入的大同相关 SDK，直接使用项目已有的 SDK
2. 项目同时引入了采集 SDK 和灯塔 SDK → 加载采集 SDK 文档，使用采集 SDK 接口
3. 项目仅引入了灯塔 SDK → 加载灯塔 SDK 文档
4. 如果检测到用户有自定义封装，记录封装方式，后续生成代码时复用
5. 项目未引入任何大同 SDK → **询问用户**使用哪个 SDK，不要自行决定

**⚠️ 重要约束**：
- **不要改动 SDK 初始化代码**：业务方的 SDK 初始化已配置好，不要修改
- **聚焦新增上报事件**：只需要在对应位置添加上报调用代码
- **保持现有代码风格**：新增代码要与已有上报代码风格一致

---

## 小程序项目：SDK 检测

> **核心原则**：小程序项目通常为全新接入或升级 SDK，需检测项目中是否已引入 universal-report-mp SDK。

扫描 `package.json` 依赖和源代码中的 require/import 语句：

| 检测目标 | 包名 / 关键词 | SDK 类型 |
|---------|-------------|---------|
| 小程序标准版 SDK | `@tencent/universal-report-mp` 或 `UniversalReport` | universal-report-mp |

**选型规则**：
1. 项目已引入 `@tencent/universal-report-mp` → 使用已有的，不要更换
2. 项目未引入任何 SDK → 默认使用 `@tencent/universal-report-mp`
3. 如果检测到用户有自定义封装（如统一的上报工具函数），记录封装方法名，后续生成代码时复用

**⚠️ 重要约束**：
- **初始化时机**：SDK 必须在 `new App()` 之前初始化，自动采集才能生效
- **system 参数**：原生小程序传 `wx`，Taro 框架传 `Taro`（⚠️ 不是 `wx`）
- **声明式埋点**：小程序使用 `data-dt-pgid` / `data-dt-eid` 属性，不是 HTML 的 `dt-pgid` 属性

---

## 大同采集 SDK 与灯塔上报 SDK 的关系

- **大同采集 SDK（VideoReport）**：负责数据采集，自动检测页面/元素的曝光、点击等行为
- **灯塔 SDK（BeaconReport）**：负责数据上报，将采集到的数据发送到后台
- **Android**：如果项目已集成采集 SDK，应通过 `VideoReport.setPageId()`、`VideoReport.setElementId()` 等接口设置页面/元素信息，由 SDK 自动采集事件。采集到的数据通过 `IReporter`（或 `IDTReport`）回调接口转发给灯塔 SDK 上报
- **iOS**：如果项目已集成采集 SDK，应通过 `vr_pageId`、`vr_elementId` 等属性设置页面/元素信息，由 SDK 自动采集事件。采集到的数据通过 `QLVRDTChannelReportDelegate` 回调转发给灯塔 SDK 上报

---

## 文档加载对照表

| 技术栈 | 方案 | 快速开始 | 高级功能 |
|--------|------|---------|---------|
| H5 | beacon-web-sdk（轻量版） | `sdk/h5/beacon-web-sdk/quickstart.md` | `sdk/h5/beacon-web-sdk/advanced.md` |
| H5 | universal-report（标准版） | `sdk/h5/universal-report/quickstart.md` | `sdk/h5/universal-report/advanced.md` |
| H5 | autotracker（无埋点版） | `sdk/h5/autotrack/quickstart.md` | `sdk/h5/autotrack/advanced.md` |
| Android | beacon-android（灯塔上报 SDK） | `sdk/android/beacon/quickstart.md` | `sdk/android/beacon/advanced.md` |
| Android | videoreport-DT（大同采集 SDK） | `sdk/android/videoreport/quickstart.md` | `sdk/android/videoreport/advanced.md` |
| iOS | beacon-ios（灯塔上报 SDK） | `sdk/ios/beacon/quickstart.md` | `sdk/ios/beacon/advanced.md` |
| iOS | videoreport-ios（大同采集 SDK） | `sdk/ios/videoreport/quickstart.md` | `sdk/ios/videoreport/advanced.md` |
| 小程序 | universal-report-mp（小程序标准版） | `sdk/mp/quickstart.md` | `sdk/mp/advanced.md` |
| 其他 | API 上报（兜底） | `references/api-report.md` | — |

**渐进式加载策略**：
1. 默认只加载快速开始文档
   - H5 项目：完成安装、初始化和基础上报
   - Android 项目：只需参考事件上报部分，聚焦新增上报事件的代码编写
   - iOS 项目：只需参考事件上报部分，聚焦新增上报事件的代码编写
   - 小程序项目：完成安装、初始化（注意 `new App()` 之前）和声明式埋点
2. 当用户需要高级功能时，再加载对应的高级功能文档

---

## 未检测到大同 SDK 时的处理

> 此步骤在完成技术栈识别和 SDK 检测后执行。当未检测到任何大同 SDK 时，需**询问用户**确认后续路径。

### 触发条件

在 SDK 检测阶段，如果满足以下**全部条件**，则判定为**未检测到大同 SDK**，需要询问用户：

| 序号 | 检测项 | 触发询问的条件 |
|:----:|--------|--------------|
| 1 | 大同 SDK 依赖 | `package.json` / `build.gradle` / `Podfile` 中**未找到**任何大同相关 SDK 包名 |
| 2 | SDK import 语句 | 源码中**未搜索到**任何大同 SDK 的 import/require 语句 |
| 3 | 上报函数调用 | 源码中**未搜索到**任何 `BeaconAction`、`BeaconReport`、`UniversalReport`、`VideoReport`、`onUserAction`、`onDirectUserAction` 等关键词 |
| 4 | 自定义上报封装 | **未发现**任何自定义的上报工具函数/类 |

### 检测关键词汇总

**H5 项目**扫描关键词：
- `@tencent/beacon-web-sdk`, `beacon-web-sdk`, `BeaconAction`
- `@tencent/universal-report`, `UniversalReport`
- `autotracker-beacon-oa`, `AutoTrackBeacon`
- `onUserAction`, `onDirectUserAction`

**Android 项目**扫描关键词：
- `com.tencent.beacon`, `BeaconReport`, `BeaconEvent`
- `videoreport-DT`, `VideoReport`, `DTReportComponent`
- `setPageId`, `setElementId`

**iOS 项目**扫描关键词：
- `pod 'Beacon'`, `BeaconReport`, `BeaconAPI_Base`
- `pod 'VideoReport'`, `QLVideoReport`, `QLVRDTReportComponent`
- `vr_pageId`, `vr_elementId`

**小程序项目**扫描关键词：
- `@tencent/universal-report-mp`, `UniversalReport`
- `wx.universalReport`, `Taro.universalReport`
- `pageSelector`, `exposeSelector`, `autoReport`
- `data-dt-pgid`, `data-dt-eid`, `data-dt-params`

### 询问用户并确认路径

当上述条件全部满足时，**必须向用户展示以下选择**：

```markdown
检测到项目中尚未引入大同 SDK，请确认你的情况：

**A）已有埋点设计** — 埋点事件已在大同平台上定义好，需要拉取埋点信息并生成上报代码
**B）从零开始** — 还没有埋点设计，需要先分析项目页面、设计埋点事件方案，再生成代码
```

| 用户选择 | 后续路径 | 说明 |
|---------|---------|------|
| **A）已有埋点设计** | → Step 2 获取埋点信息 → Step 3 | 用户已在大同平台定义事件，只需拉取信息生成代码 |
| **B）从零开始** | → Step 1b → 2b → 3b → Step 3 | 需要完整的埋点方案设计、事件表格生成和代码框架搭建 |

> ⚠️ 不要自动假设用户的情况。即使项目完全没有 SDK，用户也可能已在大同平台上设计好了埋点方案，只是还没引入 SDK。
