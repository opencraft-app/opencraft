# iOS SDK（beacon-ios）快速开始

## 集成 SDK

### 1. CocoaPods 导入（推荐）

在 `Podfile` 中添加腾讯 podspec 源和灯塔 SDK 依赖：

```ruby
source 'http://git.woa.com/T-CocoaPods/Specs.git'

platform :ios, '9.0'

target 'YourTarget' do
  use_frameworks!

  pod 'Beacon', '~> 4.2.75'
end
```

### 2. 手动导入

下载并导入以下 framework：

| Framework | 说明 | 是否必选 |
|-----------|------|:--------:|
| `BeaconAPI_Base.framework` | 基础上报 SDK | ✅ 必选 |
| `QimeiSDK.framework` | 设备指纹采集 SDK | ✅ 必选 |

> **注意**：
> - 如果通过 Catalyst 跨平台支持 Mac，需使用 `.xcframework` 后缀的 framework
> - 在 Other Linker Flags 中加入 `-ObjC` 标志

## 初始化

在 `AppDelegate` 的 `application:didFinishLaunchingWithOptions:` 中初始化 SDK：

```objc
#import <BeaconAPI_Base/BeaconReport.h>

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    // 启动 SDK，填写从灯塔官网申请的 appkey
    [BeaconReport.sharedInstance startWithAppkey:@"YOUR_APP_KEY" config:nil];
    return YES;
}
```

> **appkey** 在 https://datong.woa.com 创建应用后获取。

**初始化规范**：
1. appkey 不能为空或 `@""`，否则会抛异常
2. 只需调用一次，在尽可能早的地方调用，二方 SDK 无需调用
3. 依赖多个二方 SDK 的复杂业务，建议配置 `BeaconInfo.plist` 文件

## 上报事件

### 普通上报（推荐）

SDK 自动聚合后批量发送，性能最优。**绝大多数场景使用此方式。**

```objc
NSDictionary *params = @{
    @"key1" : @"value1",
    @"key2" : @"value2",
};

BeaconEvent *event = [BeaconEvent normalEventWithCode:@"eventCode"
                                               appkey:@"YOUR_APP_KEY"
                                               params:params];
[BeaconReport.sharedInstance reportEvent:event];
```

### 实时上报

调用后立即上报，不经过聚合。仅在有时效性要求时使用。

```objc
BeaconEvent *event = [BeaconEvent realTimeEventWithCode:@"eventCode"
                                                 appkey:@"YOUR_APP_KEY"
                                                 params:params];
[BeaconReport.sharedInstance reportEvent:event];
```

> **就这么简单！** 三步即可完成埋点上报：添加依赖 → 初始化 → 调用 `reportEvent:`

---

## 参数要求

- `eventCode`：**NSString** 类型，**不要使用"A 加数字"的 key**（如 A1、A2），Axx 字段保留给灯塔预制字段
- `params`：`NSDictionary` 类型，key 和 value 均为 **NSString**
- 上报建议携带 `appkey`，避免不必要的数据混淆

## 检测项目是否已集成

检查以下特征判断项目是否已集成灯塔 iOS SDK：

| 检测目标 | 包名 / 关键词 | SDK 类型 |
|---------|-------------|---------|
| CocoaPods 依赖 | `Podfile` 中包含 `pod 'Beacon'` | beacon-ios |
| Framework 引入 | `BeaconAPI_Base.framework` | beacon-ios |
| 头文件导入 | `#import <BeaconAPI_Base/BeaconReport.h>` 或 `BeaconReport` | beacon-ios |
| API 调用 | `BeaconReport.sharedInstance` / `reportEvent:` | — |
