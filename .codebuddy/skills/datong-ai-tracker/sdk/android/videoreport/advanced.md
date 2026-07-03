# 大同采集 SDK（VideoReport）高级功能

## 设置公共参数

### 静态公参

对于取值固定的参数，直接设置即可：

```java
VideoReport.setPublicParam("platform", "Android");
VideoReport.setPublicParam("language", "java");
```

### 动态公参

对于会变化的参数（如网络状态、用户 ID），实现 `IDTParamProvider` 接口：

```java
public class SampleDTParamsProvider implements IDTParamProvider {
    @Override
    public int getStartType() { return sStartType; }        // dt_starttype

    @Override
    public String getCallFrom() { return "callFromIcon"; }  // dt_callfrom

    @Override
    public String getActiveInfo() { return "activeInfo"; }   // dt_active_info

    @Override
    public String getGuid() { return "guid-1"; }             // dt_guid

    @Override
    public String getQQ() { return "qq-1"; }                 // dt_qq

    @Override
    public String getAccountID() { return "account-id"; }    // dt_accountid

    // 设置实时事件的动态公参
    @Override
    public void setRealtimePublicDynamicParams(Map<String, Object> params) {
        params.put("realtime", "public");
    }

    // 设置非实时事件的动态公参
    @Override
    public void setNonRealtimePublicDynamicParams(Map<String, Object> params) {
        params.put("nonRealtime", "public");
    }

    // 根据不同事件设置不同的动态参数
    @Override
    public void setEventDynamicParams(String event, Map<String, Object> params) {
        switch (event) {
            case EventKey.PG_IN:
                params.put("pagein", "pagein");
                break;
            case EventKey.CLICK:
                params.put("click", "click");
                break;
            // ... 其他事件
        }
    }
}
```

### IDTParamProvider 公参对照表

| 方法 | 对应公参 key |
|------|-------------|
| `getStartType()` | dt_starttype |
| `getCallFrom()` | dt_callfrom |
| `getActiveInfo()` | dt_active_info |
| `getCallScheme()` | dt_callschema |
| `getOmgbzid()` | dt_omgbzid |
| `getModifyChannelId()` | dt_mchlid |
| `getFactoryChannelId()` | dt_fchlid |
| `getSIMType()` | dt_simtype |
| `getAdCode()` | dt_adcode |
| `getTid()` | dt_tid |
| `getOaid()` | dt_oaid |
| `getGuid()` | dt_guid |
| `getQQ()` | dt_qq |
| `getQQOpenID()` | dt_qqopenid |
| `getWxOpenID()` | dt_wxopenid |
| `getWxUnionID()` | dt_wxunionid |
| `getWbOpenID()` | dt_wbopenid |
| `getMainLogin()` | dt_mainlogin |
| `getAccountID()` | dt_accountid |

## 页面高级功能

### 区分页面重复曝光

SDK 通过 `pgin` 事件的 `dt_pg_isreturn` 参数区分首次/重复曝光：

- `dt_pg_isreturn:0` → 首次曝光
- `dt_pg_isreturn:1` → 重复曝光

对于可复用页面，通过内容 ID 区分：

```java
VideoReport.setPageContentId(this, "content01");
```

> 调用 `VideoReport.pageLogicDestroy` 后，页面再次曝光为首次曝光。

### 半自动上报

`reportPgIn()` / `reportPgOut()` 只关注当前页面，不涉及 page 链和其他页面：

```java
// 自定义 pgin 事件上报
VideoReport.reportPgIn(page);

// 自定义 pgout 事件上报
VideoReport.reportPgOut(page);
```

### 独立 PageOut 事件

默认行为：一个页面的 PageOut 需要下一个页面的 PageIn 来触发。开启独立 PageOut 后，页面不可见即触发 PageOut：

```java
DTReportComponent.builder(new SampleDTParamsProvider())
    .independentPageOut(true)
    .build();
```

### 获取当前页面信息

```java
// 获取指定 view 关联的 PageInfo
PageInfo pageInfo = VideoReport.getPageInfo(view);

// 获取当前页面的 ReportData
VideoReportPageInfo reportPageInfo = VideoReport.getPageInfo();
```

## 元素高级功能

### 元素上报策略

SDK 提供丰富的点击、曝光、反曝光上报策略：

| 点击策略 (ClickPolicy) | 曝光策略 (ExposurePolicy) | 反曝光策略 (EndExposurePolicy) |
|---|---|---|
| REPORT_ALL（上报每次） | REPORT_ALL（上报每次） | REPORT_ALL（上报每次） |
| REPORT_NONE（不上报） | REPORT_FIRST（仅首次） | REPORT_NONE（不上报） |
| | REPORT_NONE（不上报） | |

**全局设置：**

```java
DTReportComponent.builder(new SampleDTParamsProvider())
    .elementClickPolicy(ClickPolicy.REPORT_ALL)
    .elementExposePolicy(ExposurePolicy.REPORT_ALL)
    .elementEndExposePolicy(EndExposurePolicy.REPORT_ALL)
    .build();
```

**单个元素设置（优先级高于全局）：**

```java
VideoReport.setElementClickPolicy(mButton, ClickPolicy.REPORT_ALL);
VideoReport.setElementExposePolicy(mButton, ExposurePolicy.REPORT_ALL);
VideoReport.setElementEndExposePolicy(mButton, EndExposurePolicy.REPORT_ALL);
```

### 元素有效曝光比例

```java
// 设置单个元素的有效曝光比例，默认 0.01，范围 0.0 ~ 1.0
VideoReport.setElementExposureMinRate(view, 0.5);
```

### 元素复用处理

RecyclerView/ListView 场景下，itemView 复用会导致曝光计算错误。通过设置复用标志解决：

```java
Object data = dataList.get(position);
long hashCode = data.hashCode();

VideoReport.setElementId(itemView, "line_item");
VideoReport.setElementReuseIdentifier(itemView, "line_item_" + hashCode);

VideoReport.setElementId(leftPosterView, "poster");
VideoReport.setElementReuseIdentifier(leftPosterView, "poster_left_" + hashCode);
```

> 复用标志不需要产品给出，只要能将复用的情况区分出来即可。

### 元素抽样上报

以元素 ID 为维度，设置抽样上报率：

```java
// 设置单个元素的抽样率
VideoReport.setElementSamplingRate("elementId_01", 0.1f);

// 批量设置
Map<String, Float> samplingRateTable = new HashMap<>();
samplingRateTable.put("element_01", 0.1f);
samplingRateTable.put("element_02", 80.0f);
VideoReport.setElementSamplingRate(samplingRateTable);
```

上报出口根据抽样结果过滤：

```java
public class MyDTReporter implements IReporter {
    @Override
    public void report(ReportEvent reportEvent) {
        if (reportEvent.isSamplingUpload()) {
            // 使用灯塔 SDK 上报
        }
    }
}
```

## 检测黑名单/白名单

### 检测模式设置

```java
// 默认模式：所有 Activity 都检测
VideoReport.setDetectionMode(DetectionMode.DEFAULT);

// 黑名单：黑名单内的 Activity 不检测
VideoReport.setDetectionMode(DetectionMode.BLACKLIST);
VideoReport.addToDetectionBlacklist(activity);

// 白名单：只有白名单内的 Activity 才检测
VideoReport.setDetectionMode(DetectionMode.WHITELIST);
VideoReport.addToDetectionWhitelist(activity);
```

### APP 事件上报拦截

拦截特定页面的 APP 事件（act、vst）上报：

```java
IVideoReportComponent component = DTReportComponent.builder(new SampleDTParamsProvider())
    .setDetectionInterceptor(new IDetectionInterceptor() {
        @Override
        public boolean ignoreAppEvent(Activity activity) {
            return activity instanceof HomeActivity;
        }
    })
    .build();
```

## 视频播放自动采集

大同 SDK 支持自动采集视频播放数据（针对 ThumbPlayer 中台播放器），自动上报 `dt_video_start` 和 `dt_video_end` 事件。

### 第一步：打开开关

```java
VideoReport.supportPlayerReport(true);         // 视频上报总开关（必须）
VideoReport.supportSeekReport(true);           // 进度条拖动数据（可选）
VideoReport.supportSpeedRatioReport(true);     // 倍速播放数据（可选）
```

页面数据开关（可选）：

```java
DTReportComponent.builder(new SampleDTParamsProvider())
    .setVideoPageSwitch(PageSwitch.ALL_OPEN)   // start 和 end 都携带页面数据
    .build();
```

### 第二步：绑定播放数据

**开始播放前绑定：**

```java
HashMap<String, String> customParams = new HashMap<>();
customParams.put(customKey, customValue);

VideoEntity entity = new VideoEntity.Builder()
    .setContentId(contentId)                         // 视频唯一标识
    .setPage(page)                                    // 页面标识（用于区分跨页面续播）
    .setContentType(ContentType.CONTENT_TYPE_VIDEO)   // 内容类型
    .setVideoDuration(videoDuration)                   // 视频总时长
    .setVideoView(videoView)                           // 播放器所在 view
    .addCustomParams(customParams)                     // 自定义参数
    .build();
VideoReport.bindVideoPlayerInfo(player, entity);

player.start();
```

**中断播放前解绑：**

```java
VideoReport.unbindVideoPlayerInfo(player);
player.stop();
```

**播放过程中更新参数（延迟上报场景）：**

```java
VideoBaseEntity updateEntity = new VideoBaseEntity.Builder(videoEntity)
    .bizReady(true)
    .addCustomParams(newParams)
    .build();
VideoReport.updateVideoPlayerInfo(player, updateEntity);
```

### 播放开始事件参数（dt_video_start）

| 参数 | 含义 | 类型 | 说明 |
|------|------|------|------|
| dt_start_type | 启播方式 | string | 1:首次播放 2:重播 |
| dt_start_reason | 启播原因 | string | 1:非续播 2:当前页续播 3:跨页面续播 |
| dt_content_type | 播放内容 | string | 1:广告 2:视频 |
| dt_video_contentid | 视频 ID | string | 业务指定 |
| dt_play_start_state_time | 播放开始位置 | string | 单位毫秒 |
| dt_video_length | 视频时长 | string | 单位毫秒 |
| dt_video_starttime | 播放开始时间 | long | 时间戳毫秒 |
| dt_video_index | 播放次数 | int | 冷启动周期内累计（>= v2.2.3.0） |

### 播放结束事件参数（dt_video_end）

| 参数 | 含义 | 类型 | 说明 |
|------|------|------|------|
| dt_video_contentid | 视频 ID | string | 业务指定 |
| dt_end_reason | 结束原因 | string | 1:错误 2:正常结束 3:暂停 4:暂存补报 |
| dt_play_duration | 播放时长 | string | 物理时长，单位毫秒 |
| dt_play_start_state_time | 播放开始位置 | long | 单位毫秒 |
| dt_play_end_state_time | 播放结束位置 | long | 单位毫秒 |
| dt_video_starttime | 播放开始时间 | long | 时间戳毫秒 |
| dt_video_endtime | 播放结束时间 | long | 时间戳毫秒 |
| dt_seek_record | 拖动记录 | string | >= v2.2.2.0 |
| dt_speed_ratio | 倍速记录 | string | >= v2.2.2.0 |
| dt_medium_play_duration | 介质播放时长 | long | >= v2.3.7.3，受倍速影响 |

## 音频播放上报

### 音频进程初始化

```java
IVideoReportComponent component = DTReportComponent.builder(new SampleDTParamsProvider())
    .audioEventPolicy(AudioEventPolicy.REPORT_AUDIO_ALL)
    .audioTimeReportHeartBeatInterval(60)   // 心跳间隔（秒）
    .audioTimePinInterval(5)                // 打点间隔（秒）
    .build();

if (!isAudioService) {
    VideoReport.startWithComponent(this, component);
} else {
    // 音频进程单独初始化
    VideoReport.startWithComponent(this, component, ModuleInitPolicy.INIT_AUDIO);
}
VideoReport.supportAudioReport(true);  // 全局开关
```

### 绑定音频数据

```java
AudioEntity entity = new AudioEntity.Builder()
    .setContentId(contentId)
    .setPage(this)
    .setPlayType(AudioEntity.AudioPlayType.USER_PLAY_TYPE)
    .addCustomParam("info", "helloWorld")
    .build();
VideoReport.bindAudioPlayerInfo(mediaPlayer, entity);
```

> **注意**：每次播放新音频必须重新 new 一个 AudioEntity。目前仅支持 MediaPlayer/AudioTrack 及其子类。

## 自定义事件上报

```java
// 方式一：简单自定义事件
VideoReport.reportEvent("custom_event", params);

// 方式二：带 View 上下文的自定义事件（自动收集 View 上的信息）
VideoReport.reportEvent("clck", view, params);

// 方式三：完整自定义事件（支持 appKey、上报类型等）
EventData data = EventData.builder()
    .withId("custom_event1")
    .withParam("key1", "params1")
    .withAppKey("test_app_key")
    .withSource(view)
    .withType(EventAgingType.IMMEDIATE)
    .build();
VideoReport.reportEvent(data);
```

## 元素/页面事件长链接上报

```java
// 页面事件
VideoReport.setPageId(this, "pg_demo1");
VideoReport.setEventType(this, EventAgingType.IMMEDIATE);

// 元素事件
VideoReport.setElementId(view, "eid1");
VideoReport.setEventType(view, EventAgingType.IMMEDIATE);

// 全局配置（优先级最高）
Map<String, EventAgingType> eventMap = new HashMap<>();
eventMap.put(DTEventKey.CLICK, EventAgingType.REALTIME);
eventMap.put(DTEventKey.PG_IN, EventAgingType.REALTIME);

DTReportComponent.builder(new SampleDTParamsProvider())
    .setMultiEventType(eventMap)
    .build();
```

## 多 AppKey 上报（嵌入型 App）

给元素或页面设置 AppKey，该视图及所有子视图上报都会自动回调 AppKey：

```java
// 元素级别
HashMap<String, Object> params = new HashMap<>();
params.put(DTParamKey.REPORT_KEY_APPKEY, "具体的 appKey");
VideoReport.setElementParams(view, params);

// 页面级别
VideoReport.setPageParams(pageObject, DTParamKey.REPORT_KEY_APPKEY, "具体的 appKey");
```

AppKey 查找规则：从当前元素向上遍历，找到最近有 AppKey 的元素或页面。

## 主动触发检测

在 SDK 无法自动检测的场景下（如 addView、removeView、setVisibility），需手动触发：

```java
// 对 view 所在 Activity 重新扫描页面和元素
VideoReport.traversePage(view);

// 不更改当前页面，但重新扫描元素
VideoReport.traverseExposure();
```

## App 退出处理

如果 App 退出时调用了 `System.exit(0)`，需手动触发退出上报：

```java
VideoReport.doAppOutReport();
```

## Webview JS 桥接上报

打开开关后，可在 H5 侧通过 JS 桥走端内上报：

```java
VideoReport.supportWebViewReport(true);
```

JS 侧调用：

```javascript
DtJsReporter.reportEvent({
    eventId: 'eventKey1',
    params: { key1: 'value1', key2: 'value2' },
    appKey: 'myAppKey',
    onCallback: function(result) { console.log(result); }
});
```

> **注意**：对于在 XML 中声明的 WebView，大同无法自动注入 JavascriptInterface。

## 插桩屏蔽

在 `gradle.properties` 中配置，跳过特定 jar/包名/类的插桩：

```properties
# 跳过指定 jar 包
VideoReportBypass=beacon-android-release MidasPluginSDK_release

# 跳过指定类
VideoReportInjectionSkip=com.example.skip.MyClass

# 只对指定类插桩
VideoReportInjectionOnly=com.example.target.MyClass
```

## 混淆配置

```pro
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
```

## 辅助工具：VideoReportKit

用于接入阶段自查 AOP 插桩、元素埋点、事件流水等：

```groovy
implementation 'com.tencent.qqlive.modules:videoreport-kit:xxx'
```

```java
VideoReportKit.init(this, "灯塔appKey", BuildConfig.DEBUG);
VideoReport.addReporter(new VideoReportKitReporter());
```

## 输入法事件

支持输入框提交事件的自动采集：

```java
// 给输入框设置元素 ID
VideoReport.setElementId(editText, "search_input");

// 将外部按钮绑定到输入框
VideoReport.bindSubmitTarget(submitButton, editText);

// 设置逻辑父节点（自动携带父节点数据）
VideoReport.setLogicParent(editText, parentView);
```

上报参数：
- `dt_eid`：输入框元素 ID
- `dt_submit_way`：1:键盘 2:按钮
- `dt_submit_type`：键盘回车类型

## 常见问题

### Gradle / 依赖类（demo 已踩坑验证）

| 现象 | 原因 / 修复 |
|------|------------|
| 编译能过，但自动 hook 不生效 | `videoreport-plugin-DT` 的 classpath 误放在 project 根 `build.gradle`；必须放在 **app 模块的 build.gradle** |
| 没有任何自动采集行为 | 漏写 `apply plugin: "videoreport-plugin-gradle"`，必须在 **application 模块**应用 |
| 编译/运行兼容性问题 | `videoreport-plugin-DT` 与 `videoreport-DT` 版本不一致，必须**严格相同** |
| 直接依赖找不到 | project / app 的 buildscript repositories 缺 `tencentvideo` / `tencentvideo-snapshot` |
| 传递依赖找不到（`com.tencent.rdelivery:core-sdk` / `kotlin-stdlib:*-mini-*`） | 缺 VideoReport 内部使用的传递仓库：`tmm-snapshot`、`tencent_public`、`thirdparty`、`thirdparty-snapshots`、华为仓、`tab_sdk` |
| `UnknownHostException: devproxy.oa.com` | `gradle.properties` 里的 `systemProp.http(s).proxyHost=devproxy.oa.com` 在外网不可解析；目标工程移除该代理或换网络 |
| AGP 7.4.x + compileSdk 35 报 `RES_TABLE_TYPE_TYPE entry offsets overlap` | 升级 AGP，或把 demo `compileSdk/targetSdk` 降到 33 来验证 AGP 7.4.x |
| Gradle 7.5+ 提示 Transform API 警告 | 在 project `gradle.properties` 添加 `android.experimental.legacyTransform.forceNonIncremental=true` |

### 初始化类

| 现象 | 原因 / 修复 |
|------|------------|
| app 时长统计严重偏小 | 多进程未初始化，每个**贡献生命周期的进程**都需在 `Application.onCreate()` 初始化 SDK |
| 缺失 app/page 生命周期事件 | SDK 初始化太晚，必须在 `Application.onCreate()` 尽早初始化 |
| 编译错 `provider does not implement methods such as isColdStart()` | 选用版本对应的 `IDTParamProvider` 接口方法发生变化，按所选 `videoreport-DT` 版本补齐 |
| 编译错 `ReportEvent` 方法找不到 | Reporter API 随 SDK 版本演进；只用所选 SDK 版本可用的方法（参见 quickstart 老 SDK 兼容写法） |

### Scheme / 联调类

| 现象 | 原因 / 修复 |
|------|------------|
| 扫码联调拉不起 app | 漏配 `SchemeRouterActivity`，按 quickstart「配置 Scheme」补齐 |
| 联调建立不了连接 | scheme 字符串错误，规则是 `txdt` + **小写** AppKey |
| 联调能力不可用 | SDK 版本过低，2.0 版本 >= 2.3.1.0、3.0 版本 >= 3.0.2.1 |

### 1. Android 4.4 机型找不到类

注意 Multidex 初始化顺序，将 Multidex 放在大同 SDK 初始化之前。

### 2. 自定义控件无法自动上报

从源码拷贝且修改包名的控件（如手 Q 的自定义 ListView），SDK 无法插桩，需手动上报：

```java
VideoReport.reportEvent("clck", view, null);
```

### 3. 页面没有自动采集

如果设置了白名单检测模式，需将页面主动添加到白名单：

```java
VideoReport.addToDetectionWhitelist(activity);
```

### 4. 收集调试日志

```properties
# gradle.properties
VideoReportDebugLog=true
```

```bash
./gradlew clean
./gradlew :app:assembleDebug --stacktrace > log.txt
```
