# 大同采集 SDK（VideoReport）Android 快速开始

大同 SDK 自动采集页面/元素的曝光、点击、停留等事件，并通过 `IReporter`（老版本 `IDTReport`）回调将采集结果交给业务上报通道（灯塔、公司内部通道等均可）。

## STEP 0：先确认大同 AppKey（必须前置）

修改任何工程文件前，先确认当前业务的大同 AppKey（在 [https://datong.woa.com](https://datong.woa.com) 创建应用后获取）。

| 条件 | 处理 |
|------|------|
| 已拿到 AppKey | 继续后续步骤 |
| 未拿到 AppKey | ⛔ 暂停接入，请先获取 AppKey；缺 AppKey 时无法配置可视化联调 Scheme，回调里也无法区分多 AppKey 上报目标 |

---

## 集成 SDK

### 1. 添加 maven 仓库

在 **project** 级别的 **build.gradle** 中添加：

```groovy
allprojects {
    repositories {
        maven { url "https://mirrors.tencent.com/repository/maven/tencentvideo" }
        maven { url "https://mirrors.tencent.com/repository/maven/tencentvideo-snapshot" }
    }
}
```

### 2. 添加插件依赖

在 **app 模块的 build.gradle** 中引入大同插桩插件（**必须在 application 模块**）：

```groovy
buildscript {
    repositories {
        maven { url "https://mirrors.tencent.com/repository/maven/tencentvideo" }
        maven { url "https://mirrors.tencent.com/repository/maven/tencentvideo-snapshot" }
    }
    dependencies {
        classpath "com.tencent.qqlive.videoreport.plugin:videoreport-plugin-DT:${sdkVersion}"
    }
}

apply plugin: "com.android.application"
// 建议放在所有自定义插件最前面
apply plugin: "videoreport-plugin-gradle"
```

### 3. 添加 SDK 依赖

在 app 模块的 **build.gradle** 中添加：

```groovy
dependencies {
    implementation "com.tencent.qqlive.modules:videoreport-DT:${sdkVersion}"
}
```

### ⚠️ Gradle 接入三条铁律（demo 已踩坑验证）

| # | 铁律 | 违反后果 |
|---|------|---------|
| 1 | `videoreport-plugin-DT` 的 classpath **必须放在 app 模块的 build.gradle**，不能放在 project 根 build.gradle | 编译能过，但 AOP 不生效，自动采集失效 |
| 2 | `apply plugin: "videoreport-plugin-gradle"` **必须在 application 模块**应用 | 没有自动 hook 行为 |
| 3 | `videoreport-plugin-DT` 与 `videoreport-DT` **版本必须完全一致** | 编译/运行兼容性问题 |

> 📌 排查：在 `gradle.properties` 加 `VideoReportDebugLog=true` 重新构建即可在编译日志里看到插桩详情。

---

## 初始化

在 `Application.onCreate()` 中初始化 SDK（**各个子进程也应初始化，否则 app 时长统计会严重偏小**）：

```java
import com.tencent.qqlive.module.videoreport.VideoReport;
import com.tencent.qqlive.module.videoreport.dtreport.DTReportComponent;

DTReportComponent component = DTReportComponent.builder(new SampleDTParamsProvider())
        .enableDebug(BuildConfig.DEBUG)
        .independentPageOut(false)
        .elementFormatMode(DTConfigConstants.ElementFormatMode.FLATTEN)
        .addReporter(new SimpleReporter())   // 采集回调，业务在这里把事件投递到上报通道
        .build();

VideoReport.startWithComponent(this, component);
```

> ✅ 上述代码在大同 Android Demo 工程中已跑通。

> 📌 **老 SDK 兼容**：`SDK < 2.3.0.0` 的 builder 没有 `addReporter()`，需用 `.dtReport(new SimpleDTReport())` + `IDTReport` 接口。详见下文「配置采集回调」末尾的折叠示例。

---

## 配置采集回调（关键）

大同 SDK 把采集到的每一条事件通过 `IReporter` 回调出来，业务在回调里把事件接入自家的上报通道（灯塔、公司内部通道、网关，或本地日志做调试均可）。

### 最小骨架（SDK >= 2.3.0.0）

```java
public class SimpleReporter implements IReporter {
    @Override
    public void report(ReportEvent event) {
        String eventKey = event.getKey();              // 事件名（如 pgin / clck / 自定义）
        Map<String, Object> params = event.getParams();// 事件参数
        String appKey = event.getAppKey();             // 多 AppKey 场景下回调出来的 appkey
        EventAgingType aging = event.getType();        // 时效性：NORMAL / REALTIME / IMMEDIATE

        // TODO: 在这里把事件投递到上报通道
        //   - 灯塔（BeaconReport）
        //   - 公司内部上报通道 / 网关
        //   - 调试期可只 Log 查看数据
    }
}
```

> 📌 **附：对接灯塔的示例**（业务可按所用通道自行替换）：
>
> ```java
> private EventType convertBeaconType(EventAgingType aging) {
>     switch (aging) {
>         case REALTIME:  return EventType.REALTIME;
>         case IMMEDIATE: return EventType.IMMEDIATE_WNS;
>         default:        return EventType.NORMAL;
>     }
> }
>
> @Override
> public void report(ReportEvent event) {
>     BeaconEvent beaconEvent = BeaconEvent.builder()
>             .withCode(event.getKey())
>             .withParams(event.getParams())
>             .withAppKey(event.getAppKey())
>             .withType(convertBeaconType(event.getType()))
>             .build();
>     BeaconReport.getInstance().report(beaconEvent);
> }
> ```
>
> 灯塔 SDK 的安装/初始化请参考灯塔接入文档。

### 老 SDK 兼容写法（SDK < 2.3.0.0）

```java
class SimpleDTReport implements IDTReport {
    @Override
    public boolean dtEvent(Object object, String eventKey,
                           Map<String, String> params, boolean isImmediatelyUpload) {
        // 业务投递到自己的上报通道
        return true;
    }

    @Override
    public boolean dtEvent(Object object, String eventKey,
                           Map<String, String> params, boolean isImmediatelyUpload,
                           String appKey) {
        // 多 AppKey 场景下使用 appKey
        return true;
    }
}
```

初始化时用 `.dtReport(new SimpleDTReport())` 替代 `.addReporter(...)`。

---

## 配置 Scheme（可视化联调）

在 `AndroidManifest.xml` 中注册大同 SDK 自带的 `SchemeRouterActivity`，scheme 规则：**`txdt` + 小写的大同 AppKey**。

```xml
<activity
    android:name="com.tencent.qqlive.module.videoreport.scheme.SchemeRouterActivity"
    android:configChanges="orientation|screenSize"
    android:exported="true"
    android:launchMode="singleTask">
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.BROWSABLE" />
        <category android:name="android.intent.category.DEFAULT" />
        <!-- 替换 {lowercase_appkey} 为你自己的 AppKey 转小写后的字符串 -->
        <data android:scheme="txdt{lowercase_appkey}" />
    </intent-filter>
</activity>
```

例：AppKey 为 `0AND0MCJAT4WIRDW`，scheme 即 `txdt0and0mcjat4wirdw`。

> **版本要求**：2.0 版本 >= 2.3.1.0，3.0 版本 >= 3.0.2.1。

---

## 设置页面信息

给页面设置 PageId，SDK 会自动采集页面曝光（`pgin`）和离开（`pgout`）事件：

```java
@Override
protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_main);

    // 设置页面 ID
    VideoReport.setPageId(this, "MainPageId");

    // 设置页面参数（可选）
    Map<String, Object> pageParams = new HashMap<>();
    pageParams.put("tab", "home");
    VideoReport.setPageParams(this, new PageParams(pageParams));
}
```

## 设置元素信息

给元素设置 ElementId，SDK 会自动采集曝光（`imp`）、点击（`clck`）和反曝光（`imp_end`）事件：

```java
// 设置元素 ID
VideoReport.setElementId(mButton, "submitButton");

// 设置元素参数（可选）
Map<String, Object> elementParams = new HashMap<>();
elementParams.put("buttonType", "submit");
VideoReport.setElementParams(mButton, elementParams);
```

> **就这么简单！** 集成 SDK → 初始化 → 实现采集回调 → 设置页面/元素 ID，SDK 就会自动采集事件并通过回调交给业务，业务再按自家上报通道发送。

---

## 标准事件说明

| 事件 | event_code | 触发时机 |
|------|------------|----------|
| 激活 | act | 首次启动 app 时 |
| 访问 | origin_vst | 冷启动或后台停留超 30s 后切前台 |
| 有效访问 | vst | 同 origin_vst，但过滤了被拦截页面 |
| 进前台 | appin | 冷启动或后台切前台 |
| 退后台 | appout | 所有 Activity 均已 stop |
| 页面曝光 | pgin | 页面进入可视状态 |
| 页面结束曝光 | pgout | 下一个页面曝光时触发（或 Activity.onDestroy） |
| 元素曝光 | imp | 元素进入可视区域 |
| 元素点击 | clck | 元素被点击 |
| 元素反曝光 | imp_end | 元素离开可视区域 |

## 检测项目是否已集成

检查以下特征判断项目是否已集成大同采集 SDK：

| 检测目标 | 包名 / 关键词 | SDK 类型 |
|---------|-------------|---------|
| 大同采集 SDK | `com.tencent.qqlive.modules:videoreport-DT` 或 `VideoReport` | videoreport-DT |
| 大同插桩插件 | `videoreport-plugin-DT` 或 `videoreport-plugin-gradle` | videoreport-plugin |
| VideoReport API 调用 | `VideoReport.setPageId` / `VideoReport.setElementId` / `VideoReport.startWithComponent` | — |

---

## 采集 SDK 项目特殊处理

**如果项目中已集成大同采集 SDK**：
- 使用采集 SDK 的接口进行事件采集：
  - `VideoReport.setPageId()` — 设置页面信息
  - `VideoReport.setElementId()` — 设置元素信息
- 采集 SDK 会自动处理页面/元素的曝光、点击等事件检测
- 数据通过 `IReporter` 回调转发给业务上报通道（无需在业务代码中再单独调用上报 SDK）

---

## P0 集成验证清单

完成上述步骤后，按下表自查（来自 demo 实测验收点）：

```text
□ AppKey 已确认，未使用占位符
□ Gradle plugin 与 runtime 依赖版本完全一致
□ Application.onCreate() 中调用了 VideoReport.startWithComponent(...)
□ Reporter 回调能收到事件（先 Log 验证，再对接业务通道）
□ ./gradlew :app:assembleDebug 构建通过
□ Demo 页面设了 pageId、Demo 元素设了 elementId
□ 运行时能观察到 pgin / pgout / clck / imp 事件或调试日志
```

排查思路：自动采集不生效 → 在 `gradle.properties` 加 `VideoReportDebugLog=true`，按 `./gradlew clean && ./gradlew :app:assembleDebug --stacktrace > log.txt` 抓日志，确认目标类是否被插桩、插件日志是否产生。
