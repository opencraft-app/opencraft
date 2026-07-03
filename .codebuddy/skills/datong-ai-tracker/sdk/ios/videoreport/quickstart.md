# 大同采集 SDK（VideoReport）iOS 快速开始

大同 SDK 自动采集页面/元素的曝光、点击、停留等事件，并通过 `QLVRDTChannelReportDelegate` 回调将采集结果交给业务上报通道（灯塔、公司内部通道等均可）。

## 集成 SDK

### 1. CocoaPods 导入

在 `Podfile` 中添加大同 podspec 源和 SDK 依赖（**一个完整可用的最小 Podfile 示例**）：

```ruby
source "https://git.woa.com/UniversalReport/DT-PodSpecs.git"
source "https://cdn.cocoapods.org/"

platform :ios, '12.0'

target 'YourApp' do
  use_frameworks!

  pod 'VideoReport', '2.5.4.2'
end
```

> ⚠️ **空项目常见坑**：不写 `platform :ios, '12.0'` 或不用 `target do ... end` 包裹，直接 `pod install` 会报 `The abstract target Pods must specify a platform since its dependencies are not inherited by a concrete target`。

> 📌 **版本说明**：当前推荐版本 `2.5.4.2`（可在 DT-PodSpecs 仓库查看全部可用版本）。

如需视频播放上报，在 subspecs 中添加 ThumbPlayerReport：

```ruby
pod 'VideoReport', '2.5.4.2', :subspecs => ['VideoReport', 'ThumbPlayerReport']
```

如需集成 TVK 播放器逻辑，用独立的 TVKPlayerPlugin subspec：

```ruby
pod 'VideoReport', '2.5.4.2', :subspecs => ['VideoReport', 'ThumbPlayerReport', 'TVKPlayerPlugin']
```

> ⚠️ **ThumbPlayer / TVKPlayerPlugin 为中台私有 pod**：
> - 需先申请私有 podspec 源权限（如播放器团队的 PodSpecs 仓库）并把对应 `source ...` 加到 Podfile 顶部
> - 仅在公网 CocoaPods 源下写 `pod 'ThumbPlayer'` 会报 `Unable to find a specification for 'ThumbPlayer'`
> - ThumbPlayerReport 依赖 ThumbPlayer，建议在 Podfile 中显示前置 `pod 'ThumbPlayer'`

## 初始化

在 `AppDelegate` 的 `application:didFinishLaunchingWithOptions:` 中初始化大同 SDK（**必须在主线程**）：

```objc
#import <VideoReport/QLVideoReport.h>
#import <VideoReport/QLVRDTReportComponent.h>
#import "MyReportDelegate.h"        // 业务实现的采集回调（见下文「配置采集回调」）
#import "MyPublicParamsProvider.h"  // 业务实现的公参 Provider

- (BOOL)application:(UIApplication *)application
        didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    [[QLVideoReport sharedInstance] startWithComponent:[QLVRDTReportComponent build:^(QLVRDTReportComponent * _Nonnull component) {
        // 必须设置 ────────────────────────────────────────
        component.dtReportDelegate    = [MyReportDelegate sharedInstance];        // 采集事件回调（业务自行投递到上报通道）
        component.publicParamsProvider = [MyPublicParamsProvider sharedInstance]; // 大同公参代理

        // 推荐设置 ────────────────────────────────────────
        component.enablePageLink                       = YES; // 父子 page 同时曝光
        component.dtIndependentPageOut                 = YES; // 独立 PageOut
        component.viewEndExposurePolicy                = QLVRViewEndExposurePolicy_None;
        component.hookConfig.enableSwizzleMethodByReplace = YES; // 减少 hook 耗时
        component.hookConfig.enableWebViewMonitor      = YES;
        component.hookConfig.enableWebkitBridge        = YES;
        component.configuration.lessViewDetect         = YES; // 减少无效视图检测，降低性能损耗
        component.configuration.enableParamsCutForValueNull = YES; // 空 value 参数裁减，节省成本

        // 可选 ────────────────────────────────────────────
        // component.dtLogger = [MyLogger sharedInstance]; // 日志打印代理（实现 QLVideoReportLoggerInterface）

    #if DEBUG
        component.debugMode = YES;
    #endif
    }]];
    return YES;
}
```

> ✅ 上述代码在 `VideoReport/Example` 工程中已跑通，可直接复用。

## 配置采集回调（关键）

大同 SDK 把采集到的每一条事件通过 `QLVRDTChannelReportDelegate` 回调出来，业务在回调里把事件接入自家的上报通道（灯塔、公司内部通道、网关，或本地日志做调试均可）。

`MyReportDelegate.h`：

```objc
#import <VideoReport/QLVRDTReportComponent.h>

NS_ASSUME_NONNULL_BEGIN

@interface MyReportDelegate : NSObject <QLVRDTChannelReportDelegate>
+ (instancetype)sharedInstance;
@end

NS_ASSUME_NONNULL_END
```

`MyReportDelegate.m`（最小骨架，业务**只需实现 `dtReportEvent:`**，把事件交给自家上报通道即可）：

```objc
#import "MyReportDelegate.h"

@implementation MyReportDelegate

+ (instancetype)sharedInstance {
    static MyReportDelegate *_inst = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ _inst = [[MyReportDelegate alloc] init]; });
    return _inst;
}

- (BOOL)dtReportEvent:(QLVRReportEvent *)reportEvent {
    NSString     *eventId    = reportEvent.eventId;       // 事件名（如 dt_pgin / dt_clck / 自定义）
    NSDictionary *params     = reportEvent.params;        // 事件参数
    NSString     *appKey     = reportEvent.appKey;        // 多 AppKey 场景下回调出来的 appkey
    QLVREventAgingType aging = reportEvent.eventAgingType;// 时效性：Normal / RealTime / Immediate

    // TODO: 在这里把事件投递到上报通道
    //   - 灯塔（BeaconReport）
    //   - 公司内部上报通道 / 网关
    //   - 调试期可只 NSLog 查看数据

    if (reportEvent.isHitSampling) {
        // 命中采样才需要真正发送（未配置抽样时该字段恒为 YES）
        // [self forwardToYourChannel:eventId params:params appKey:appKey aging:aging];
    }
    return YES;
}

@end
```

> 📌 **附：对接灯塔的示例**（业务可按所用通道自行替换）：
>
> ```objc
> #import <BeaconAPI_Base/BeaconReport.h>
>
> BeaconEventType type = BeaconEventTypeDTNormal;
> if (aging == QLVREventAgingTypeRealTime)  type = BeaconEventTypeDTRealTime;
> if (aging == QLVREventAgingTypeImmediate) type = BeaconEventTypeImmediate;
>
> BeaconEvent *event = [[BeaconEvent alloc] initWithAppKey:appKey
>                                                     code:eventId
>                                                     type:type
>                                                  success:YES
>                                                   params:params];
> [BeaconReport.sharedInstance reportEvent:event];
> ```
>
> 灯塔 SDK 的安装/初始化请参考灯塔接入文档。

## 配置公参（必填）

实现 `QLVRDTPublicParamsProvider`，提供启动方式、渠道、用户标识等大同公参。最小可用骨架：

```objc
@interface MyPublicParamsProvider : NSObject <QLVRDTPublicParamsProvider>
+ (instancetype)sharedInstance;
@end

@implementation MyPublicParamsProvider
+ (instancetype)sharedInstance { /* dispatch_once 单例，略 */ }

- (NSInteger)getStartType { return 0; }                  // 0=icon 1=push 2=url
- (NSString *)getCallFrom { return @""; }                // 调起来源
- (NSString *)getQQ       { return @""; }                // 业务有则返回，没有可返回 @""
- (BOOL)getAppInIsCold    { return YES; }                // 是否冷启动

// 业务自定义公参（每条事件都会带上）
- (NSDictionary<NSString *, NSObject *> *)getBusinessPublicParamsWithEvent:(NSString *)event {
    return @{ @"appName": @"your_app_name" };
}
@end
```

> 📖 全量公参字段（`getOmgbzid` / `getOaid` / `getGuid` / `getWxOpenID` 等）→ `advanced.md` 「设置公共参数」章节。

## 配置 Scheme（可视化联调）

### 1. 添加 DTVisual 子 pod

```ruby
pod 'VideoReport', '2.5.4.2', :subspecs => ['VideoReport', 'DTVisual']
```

> 📌 从 `2.5.x` 开始 `VideoReport` 默认已包含 DTVisual，但一旦在 Podfile 中显示列出 `:subspecs`，就必须把 `'DTVisual'` 一并写上，否则缺之无效。

### 2. 配置 URL Scheme

Scheme 规则：`txdt` + **小写的 appkey**。例如 appkey 为 `0IOS0MCJAT4WIRDW`，Scheme 即 `txdt0ios0mcjat4wirdw`。

> 这里的 appkey 即大同应用对应的 appkey（在 [https://datong.woa.com](https://datong.woa.com) 创建应用后获取）；如果业务也用灯塔上报，同一个 appkey 复用即可。

在 Target → Info → URL Types 中点击加号(+)，把 `txdt + 小写 appkey` 填到 URL Schemes。对应到 `Info.plist` 的真实写法（demo 实测）：

```xml
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLName</key>
        <string></string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>txdt0IOS0MCJAT4WIRDW</string>  <!-- 替换为你自己的 txdt+小写appkey -->
        </array>
    </dict>
</array>
```

### 3. 处理传入的 URL

在 `AppDelegate` 中把 scheme 透给大同 SDK：

```objc
#if __has_include(<VideoReport/QLVRVisualManager.h>)
#import <VideoReport/QLVRVisualManager.h>
#endif

- (BOOL)application:(UIApplication *)app
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey, id> *)options {
#if __has_include(<VideoReport/QLVRVisualManager.h>)
    [[QLVideoReport sharedInstance] handleSchemeUrl:url];
#endif
    return YES;
}
```

> ⚠️ 调用不存在的方法会报 `no visible @interface declares the selector 'handleSchemeUrl:'`。用 `#if __has_include` 做编译期保护后，可以选择性在 Release 中去掉 DTVisual subspec 而不影响编译。

## 设置页面信息

给 View 设置 PageId，SDK 会自动采集页面曝光（`dt_pgin`）和离开（`dt_pgout`）事件：

```objc
#import "UIView+VideoReport.h"

UIView *pageView = currentViewController.view;
pageView.vr_pageId = @"MainPageId";

// 设置页面参数（可选）
pageView.vr_setPageParams(@{@"tab": @"home"});
```

## 设置元素信息

给 View 设置 ElementId，SDK 会自动采集曝光（`dt_imp`）、点击（`dt_clck`）和反曝光（`dt_imp_end`）事件：

```objc
#import "UIView+VideoReport.h"

UILabel *label = ...;
label.vr_elementId = @"username_lbl";

// 设置元素参数（可选）
label.vr_setElementParams(@{@"width": @(60), @"height": @(20)});
```

> **就这么简单！** 集成 SDK → 初始化 → 实现采集回调 → 设置页面/元素 ID，SDK 就会自动采集事件并通过回调交给业务，业务再按自家上报通道发送。

---

## 标准事件说明

| 事件 | event_code | 触发时机 |
|------|------------|----------|
| 激活 | dt_act | 首次启动 app |
| 访问 | dt_vst | 冷启动或后台停留超时切前台 |
| 进前台 | dt_appin | 冷启动或后台切前台 |
| 退后台 | dt_appout | App 退到后台 |
| 页面曝光 | dt_pgin | 页面进入可视状态 |
| 页面结束曝光 | dt_pgout | 页面离开可视状态 |
| 元素曝光 | dt_imp | 元素进入可视区域 |
| 元素点击 | dt_clck | 元素被点击 |
| 元素反曝光 | dt_imp_end | 元素离开可视区域 |

## 检测项目是否已集成

检查以下特征判断项目是否已集成大同采集 SDK：

| 检测目标 | 包名 / 关键词 | SDK 类型 |
|---------|-------------|---------|
| CocoaPods 依赖 | `Podfile` 中包含 `pod 'VideoReport'` | videoreport-ios |
| 头文件导入 | `#import "UIView+VideoReport.h"` 或 `QLVideoReport` | videoreport-ios |
| API 调用 | `QLVideoReport.sharedInstance` / `vr_pageId` / `vr_elementId` | — |
| 大同采集组件 | `QLVRDTReportComponent` / `DTReportComponent` | videoreport-ios |
