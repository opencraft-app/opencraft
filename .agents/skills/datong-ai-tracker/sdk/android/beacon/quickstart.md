# Android SDK（beacon-android）快速开始

## 集成 SDK

### 1. 添加 maven 仓库

在 **project** 级别的 **build.gradle** 中添加：

```groovy
allprojects {
    repositories {
        maven { url "https://mirrors.tencent.com/repository/maven/tencent_public" }
        maven { url "https://mirrors.tencent.com/repository/maven/qmsp-oaid2" }
    }
}
```

### 2. 添加依赖

在主 **module** 的 **build.gradle** 中添加（注意修改版本号）：

```groovy
dependencies {
    // Beacon Analytics SDK
    implementation 'com.tencent.beacon:beacon-android-release:4.2.86.7-hf1:official@aar'
    // Qimei SDK（建议自行指定推荐版本）
    implementation 'com.tencent.qimei:qimei:1.2.13.1'
}
```

## 初始化

在 `Application.onCreate()` 中初始化 SDK：

```java
import com.tencent.beacon.event.open.BeaconConfig;
import com.tencent.beacon.event.open.BeaconReport;

// 构建配置
BeaconConfig config = BeaconConfig.builder()
        .setNeedInitQimei(true)  // 是否初始化 qimei
        .build();

// 启动 SDK
BeaconReport.getInstance().start(context, "YOUR_APP_KEY", config);
```

> **appkey** 在 https://datong.woa.com 创建应用后获取。

## 上报事件

### 普通上报（推荐）

SDK 自动聚合后批量发送，性能最优。**绝大多数场景使用此方式。**

```java
import com.tencent.beacon.event.open.BeaconEvent;
import com.tencent.beacon.event.open.EventType;

Map<String, String> params = new HashMap<>();
params.put("key1", "value1");
params.put("key2", "value2");

BeaconEvent event = BeaconEvent.builder()
        .setCode("eventCode")        // 事件编码
        .setType(EventType.NORMAL)   // 普通事件
        .setParams(params)           // 事件参数
        .build();

BeaconReport.getInstance().report(event);
```

### 实时上报

调用后立即上报，不经过聚合。仅在有时效性要求时使用。

```java
BeaconEvent event = BeaconEvent.builder()
        .setCode("eventCode")
        .setType(EventType.REALTIME)  // 实时事件
        .setParams(params)
        .build();

BeaconReport.getInstance().report(event);
```

> **就这么简单！** 三步即可完成埋点上报：添加依赖 → 初始化 → 调用 `report()`

---

## 参数要求

- `eventCode`：必须是 **String** 类型，**不要使用"A 加数字"的 key**（如 A1、A2），Axx 字段保留给灯塔预制字段
- `params`：`Map<String, String>` 类型，key 和 value 均为 **String**
- 该版本 SDK **不采集用户隐私信息**，如业务需要需在用户授权后自行采集并设置

---

## Android 项目关键约束

- **不要修改已有的 SDK 初始化代码**
  - 如 `Application` 中的 SDK init
  - `DTReportComponent.builder` 配置
  - `BeaconReport.getInstance().start()` 等

- **只在对应位置新增上报事件代码**
  - 在 Activity/Fragment/View 中添加 `setPageId`、`setElementId`、`report()` 等调用

- **沿用项目已有的上报封装方式**
  - 如果项目有统一的上报工具类或基类方法，新增代码应使用相同的封装
