# 大同采集 SDK（VideoReport）iOS 高级功能

## 设置公共参数

### 大同公参

实现 `QLVRDTPublicParamsProvider` 协议，在初始化时通过 `publicParamsProvider` 设置代理对象：

```objc
@protocol QLVRDTPublicParamsProvider <NSObject>
@optional

// --- 大同公参 ---
- (NSInteger)getStartType;          // dt_starttype
- (NSString *)getCallFrom;          // dt_callfrom
- (NSString *)getCallScheme;        // dt_callschema
- (NSString *)getOmgbzid;           // dt_omgbzid
- (NSString *)getModifyChannelId;   // dt_mchlid
- (NSString *)getFactoryChannelId;  // dt_fchlid
- (NSString *)getSIMType;           // dt_simtype
- (NSString *)getAdCode;            // dt_adcode
- (NSString *)getTid;               // dt_tid
- (NSString *)getOaid;              // dt_oaid
- (NSString *)getGuid;              // dt_guid
- (NSString *)getQQ;                // dt_qq
- (NSString *)getQQOpenID;          // dt_qqopenid
- (NSString *)getWxOpenID;          // dt_wxopenid
- (NSString *)getWxUnionID;         // dt_wxunionid
- (NSString *)getWbOpenID;          // dt_wbopenid
- (NSString *)getMainLogin;         // dt_mainlogin
- (NSString *)getAccountID;         // dt_accountid
- (BOOL)getAppInIsCold;             // dt_appin_iscold（真实启动参数）

// --- 业务公参 ---
- (NSDictionary<NSString *, NSObject *> *)getBusinessPublicParamsWithEvent:(NSString *)event;

@end
```

### 最小可用 Provider 示例（来自 demo，已跑通）

```objc
@interface MyPublicParamsProvider : NSObject <QLVRDTPublicParamsProvider, QLVideoReportEventDynamicParamsProvider>
+ (instancetype)sharedInstance;
- (void)markStartType:(NSInteger)startType;  // 0=icon 1=push 2=url
@end

@implementation MyPublicParamsProvider {
    NSInteger _startType;
}

+ (instancetype)sharedInstance {
    static MyPublicParamsProvider *_inst = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ _inst = [[MyPublicParamsProvider alloc] init]; });
    return _inst;
}

- (void)markStartType:(NSInteger)startType { _startType = startType; }

#pragma mark - QLVRDTPublicParamsProvider（按需实现，业务无值的字段返回 @"" 即可）

- (NSInteger)getStartType   { return _startType; }
- (NSString *)getCallFrom   { return @""; }
- (NSString *)getCallScheme { return @""; }
- (NSString *)getOmgbzid    { return @""; }
- (NSString *)getGuid       { return @""; }
- (NSString *)getQQ         { return @""; }
- (NSString *)getQQOpenID   { return @""; }
- (NSString *)getWxOpenID   { return @""; }
- (NSString *)getWxUnionID  { return @""; }
- (NSString *)getMainLogin  { return @""; }
- (NSString *)getAccountID  { return @""; }
- (BOOL)getAppInIsCold      { return YES; }

// 每条事件都会带上的业务公参
- (NSDictionary<NSString *, NSObject *> *)getBusinessPublicParamsWithEvent:(NSString *)event {
    return @{
        @"appName":  @"your_app_name",
        @"newsid":   @"",
    };
}

#pragma mark - QLVideoReportEventDynamicParamsProvider（不同事件注入不同参数）

- (NSDictionary<NSString *, NSObject *> *)dynamicReportParamsWithEvent:(NSString *)event {
    if ([event isEqualToString:VR_EVENT_ID_APPIN])   return @{@"APPIN_BIZ_KEY":   @"v1"};
    if ([event isEqualToString:VR_EVENT_ID_PAGE_IN]) return @{@"PAGE_IN_BIZ_KEY": @"v1"};
    if ([event isEqualToString:VR_EVENT_ID_CLCK])    return @{@"CLCK_BIZ_KEY":    @"v1"};
    return nil;
}

@end
```

> 在初始化时把这个 Provider 同时挂到两个回调上：
> ```objc
> component.publicParamsProvider = [MyPublicParamsProvider sharedInstance];
> component.eventParamsProvider  = [MyPublicParamsProvider sharedInstance];
> ```

### IDTParamProvider 公参对照表

| 方法 | 对应公参 key |
|------|-------------|
| `getStartType` | dt_starttype |
| `getCallFrom` | dt_callfrom |
| `getCallScheme` | dt_callschema |
| `getOmgbzid` | dt_omgbzid |
| `getModifyChannelId` | dt_mchlid |
| `getFactoryChannelId` | dt_fchlid |
| `getSIMType` | dt_simtype |
| `getAdCode` | dt_adcode |
| `getTid` | dt_tid |
| `getOaid` | dt_oaid |
| `getGuid` | dt_guid |
| `getQQ` | dt_qq |
| `getQQOpenID` | dt_qqopenid |
| `getWxOpenID` | dt_wxopenid |
| `getWxUnionID` | dt_wxunionid |
| `getWbOpenID` | dt_wbopenid |
| `getMainLogin` | dt_mainlogin |
| `getAccountID` | dt_accountid |

### 全局动态参数

通过实现 `dynamicReportParamsWithEvent:` 为不同事件注入动态参数：

```objc
-(NSDictionary<NSString *, NSObject *> *)dynamicReportParamsWithEvent:(NSString *)event {
    if ([event isEqualToString:VR_EVENT_ID_APPIN]) {
        return @{@"APPIN_BIZ_PRIVATE_KEY": @"APPIN_BIZ_PRIVATE_VALUE"};
    }
    if ([event isEqualToString:VR_EVENT_ID_PAGE_IN]) {
        return @{@"PAGE_IN_BIZ_PRIVATE_KEY": @"PAGE_IN_BIZ_PRIVATE_VALUE"};
    }
    if ([event isEqualToString:VR_EVENT_ID_CLCK]) {
        return @{@"CLCK_BIZ_PRIVATE_KEY": @"CLCK_BIZ_PRIVATE_VALUE"};
    }
    return nil;
}
```

## 页面高级功能

### 区分页面重复曝光

通过 `vr_setPageContentId` 区分首次/重复曝光，SDK 通过 `dt_pg_isreturn` 参数标识：

```objc
view.vr_setPageContentId(@"content01", NO);
```

> `isNewPage` 参数一般设 NO。设为 YES 时会清除之前的 contentid，即使相同也被视为新页面。

### 页面逻辑销毁

当页面需要刷新并重新触发 pgin 时，调用 `pageLogicDestroy`：

```objc
UIView *pageView = ...;
[[QLVideoReport sharedInstance] pageLogicDestroy:pageView];

// 更新页面参数
pageView.vr_pageId = @"new_page_id";
pageView.vr_setPageParams(@{@"key": @"value"});

// 重新触发曝光扫描
[[QLVideoReport sharedInstance] traverse];
```

> SDK 规则约定传参必须为正在曝光的当前页面，否则不予处理。

### 半自动上报

手动触发 pgin / pgout / clck 事件（view 必须可见且满足相关条件）：

```objc
// 手动触发 pgin
[[QLVideoReport sharedInstance] reportPageInEventWithView:view];

// 手动触发 pgout
[[QLVideoReport sharedInstance] reportPageOutEventWithView:view];

// 手动触发 clck（view 必须设置了 eid）
[[QLVideoReport sharedInstance] reportClickEventWithView:view];
```

### 独立 PageOut 事件

开启后，从有 pageid 的页面进入无 pageid 的页面时也会上报 dt_pgout：

```objc
component.dtIndependentPageOut = YES;
```

### 忽略页面流转

当父页面不需参与曝光和反曝光，但其元素事件需正常上报时：

```objc
pageView.vr_ignorePageInOutEvent = YES;
```

### vr_isBizReady - 延迟页面曝光

当页面数据未加载完成时，可延迟 pageIn 上报：

```objc
// 在 viewDidLoad 或 alloc 时设置
view.vr_isBizReady = NO;

// 数据加载完成后
view.vr_isBizReady = YES;
```

> 如果 pageOut 时 `vr_isBizReady` 仍为 NO，SDK 会直接触发 pageIn 和 pageOut 补报。

## 元素高级功能

### 元素上报策略

**曝光策略（dt_imp）**：

```objc
typedef NS_ENUM(NSUInteger, QLVRViewExposurePolicy) {
    QLVRViewExposurePolicy_None = 0,    // 不采集曝光
    QLVRViewExposurePolicy_First,       // 只采集首次曝光
    QLVRViewExposurePolicy_All          // 所有曝光都采集
};
```

**反曝光策略（dt_imp_end）**：

```objc
typedef NS_ENUM(NSUInteger, QLVRViewEndExposurePolicy) {
    QLVRViewEndExposurePolicy_None = 0,  // 不上报反曝光（默认）
    QLVRViewEndExposurePolicy_All = 1,   // 全部上报
};
```

**全局设置**：通过 `QLVRDTReportComponent` 的 `viewExposurePolicy` / `viewEndExposurePolicy` / `viewInteractPolicy`。

**单个元素设置（优先级高于全局）**：

```objc
view.vr_exposureReportPolicy = QLVRViewExposurePolicy_All;
view.vr_endExposureReportPolicy = QLVRViewEndExposurePolicy_All;
view.vr_interactReportPolicy = ...;
```

### 元素有效曝光比例

```objc
// 设置元素的最小可见曝光比例，默认 1%
view.vr_preferredVisibleRatio = 0.5;
```

### 元素复用处理

UITableViewCell / UICollectionViewCell 复用场景下，需设置复用标识区分不同内容：

```objc
cell.vr_elementId = @"line_item";
cell.vr_elementBizLeafIdentifier = @"xxx_reuseid";
```

> 需在 `cellForRow` 函数中清空 cell 上已有元素的参数并重新设置。

### 元素延时曝光上报

过滤曝光时长过短的数据，等待指定时间后再上报：

```objc
view.vr_delayDuration = 1000; // 单位毫秒，默认 200ms
```

### 元素强制曝光

```objc
// 强制重新曝光视图及子视图
[[QLVideoReport sharedInstance] setNeedForceExpose:view];

// 以 keyWindow 为根节点触发曝光检查
[[QLVideoReport sharedInstance] traverse];
```

### 元素/页面抽样上报

以设备维度进行抽样，取值范围 [0.0, 100.0]，为 0 时表示软下线不上报：

```objc
// 初始化时设置
component.configuration.eidSampleRateMaps = @{
    @"sample_50": @(50),
    @"sample_20": @(20)
};

// 按事件类型设置
component.configuration.eidEventSampleRateMaps = @{
    @"unit_test_eid_evt": @{
        DT_EVENT_ID_IMP_IN: @(10),
        DT_EVENT_ID_IMP_END: @(20),
        DT_EVENT_ID_CLCK: @(50)
    }
};

// 页面抽样
component.configuration.pgidSampleRateMaps = @{
    @"pgid_sample_70": @(70)
};
```

在回调中根据 `isHitSampling` 决定是否上报：

```objc
- (BOOL)dtReportEvent:(QLVRReportEvent *)reportEvent {
    if (reportEvent.isHitSampling) {
        // 命中采样才需要继续投递到上报通道
        // [self forwardToYourChannel:reportEvent];
    }
    return YES;
}
```

## 点击事件

### 普通点击

设置 `vr_elementId` 后，当元素设置了 target（`addTarget:`）或 GestureRecognizer（`addGestureRecognizer:`）时，自动采集点击事件。

> target 只支持 `touchUpInside`，gesture 只支持 `tap`。

### UITableView / UICollectionView Cell 点击

默认自动采集，可通过在 `readonly` 的 `vr_table_config` / `vr_coll_config` 上直接设置子开关来关闭：

```objc
// UITableView（属性声明于 UITableView+vrptConfig.h）
tableview.vr_table_config.vrTable_didSelectRowAtIndexPath_auto = YES;
tableview.vr_table_config.vrTable_didDeselectRowAtIndexPath_auto = NO;

// UICollectionView（属性声明于 UICollectionView+vrptConfig.h）
collectionView.vr_coll_config.vrColl_didSelectItemAtIndexPath_auto = YES;
collectionView.vr_coll_config.vrColl_didDeselectItemAtIndexPath_auto = NO;
```

> ⚠️ **属性名与开关前缀注意**：
> - `vr_table_config` / `vr_coll_config` 本身是 `readonly`，**禁止**写成 `tableview.vr_table_config = someConfig;`（SDK 中没有 `QLVRTestTableviewConfig` 这样的类）；只能在它们上面设置子开关
> - UITableView 的子开关前缀是 `vrTable_*`，UICollectionView 的子开关前缀是 `vrColl_*`，两者**不通用**，混用会报 `property ... not found`

### 点击事件增强

通过 `vr_controlEvents` 支持更多 UIControl 事件类型：

```objc
view.vr_controlEvents = QLVRControlEventTouchUpInside | QLVRControlEventValueChanged;
```

点击事件参数中 `dt_clck_type` 标识点击类型（7=touchUpInside, 10=valueChanged, 13=tap, 14=longPress 等）。

## 动态参数

### 静态参数

```objc
// 页面参数
pageView.vr_setPageParams(@{@"key1": @"value1"});

// 元素参数
label.vr_setElementParams(@{@"width": @(60)});
```

### 动态参数

通过 block 在事件触发时实时获取最新参数：

```objc
self.view.vr_dynamicParamsBlock = ^NSDictionary *(NSString *event) {
    if ([event isEqualToString:DT_EVENT_ID_PAGE_IN]) {
        return @{@"pg_key": @"pg_value"};
    }
    return nil;
};
```

> 若 view 可能在 `dt_imp_end` 或 `dt_pgout` 前释放，需提前调用 `[view updateDynamicParamsBeforeDestroy]`。

## 自定义事件上报

```objc
QLVREventData *eventData = [[QLVREventData alloc] init];
eventData.eventId = @"custom_event";
eventData.params = @{@"key": @"value"};
eventData.view = self.view;
[[QLVideoReport sharedInstance] reportEvent:eventData];
```

## 元素提交事件（dt_submit）

SDK 自动 Hook UITextView 和 UITextField 的回车事件：

```objc
// 给输入框设置 elementId
UITextView *textView = ...;
textView.vr_elementId = @"search_input";
textView.delegate = delegate;
textView.returnKeyType = UIReturnKeySend;
```

将外部按钮绑定到输入框：

```objc
button.vr_submitView = textView;
```

设置逻辑父节点（自动携带父节点数据）：

```objc
view.vr_logicalParent = parentView;
```

## 事件时效性设置

```objc
typedef NS_ENUM(NSUInteger, QLVREventAgingType) {
    QLVREventAgingTypeNormal,    // 5s 轮询
    QLVREventAgingTypeRealTime,  // 2s 轮询
    QLVREventAgingTypeImmediate, // 立即上报
};

// 页面/元素事件
view.vr_eventAging = QLVREventAgingTypeRealTime;

// 自定义事件
eventData.eventAgingType = QLVREventAgingTypeImmediate;
```

## 应用心跳

```objc
// 关闭应用心跳
component.configuration.enableAppHeartBeatReport = NO;

// 配置心跳间隔
QLVRAPPReportConfiguration *useTimeConfig = [QLVRAPPReportConfiguration new];
useTimeConfig.appPinIntercal = 5;
useTimeConfig.appHeartBeatInterval = 60;
component.configuration.appUseTimeConfig = useTimeConfig;
```

## 多 AppKey 上报（嵌入型 App）

给元素或页面设置 AppKey，该视图及所有子视图上报都会自动回调 AppKey：

```objc
// 元素级别
view.vr_setElementParams(@{VR_COM_ARG_APP_KEY: @"qq_kandian", @"articleId": @"122"});

// 页面级别
view.vr_setPageParams(@{VR_COM_ARG_APP_KEY: @"123"});
```

AppKey 查找规则：从当前元素向上遍历，找到最近有 AppKey 的元素或页面。

> iOS 暂不支持 APP 事件的多 AppKey 上报。

## Page 链模式

```objc
// 全局开启
component.enablePageLink = YES;
component.dtUDFNodeFormatMode = QLVRUDFKVFormatMode_newsFlatten;

// 局部开启（需对父 page 到子 page 路径上所有 view 设置）
view.vr_enablePageLink = YES;
```

## UITableView / UICollectionView 滑动曝光

```objc
// 开启滑动曝光
tableView.vr_enableScrollExposureReport = YES;

// 设置滑动曝光策略
cell.vr_scrollExposureReportPolicy = QLVRViewExposurePolicy_All;
cell.vr_scrollEndExposureReportPolicy = QLVRViewEndExposurePolicy_All;
```

滑动曝光附加参数：
- `dt_ele_scroll_flag`：是否滑动中采集（0/1）
- `dt_ele_is_first_scroll_imp`：是否首次滑动曝光（0/1）

## 视频播放自动采集

大同 SDK 支持自动采集视频播放数据（针对 ThumbPlayer 中台播放器），自动上报 `dt_video_start` 和 `dt_video_end` 事件。

### 第一步：打开开关

```objc
component.hookConfig.allowHookThumbPlayerEvent = YES;
```

### 第二步：绑定播放数据

**开始播放前绑定：**

```objc
QLVRThumbPlayerEntity *entity = [[QLVRThumbPlayerEntity alloc] init];
entity.contentID = @"video_123";
entity.pageIdentifier = @"page_id";
entity.contentType = QLVRThumbPlayerContentType_Content;
entity.durationMs = player.durationMs;
entity.identifier = vid;       // 必填，确定绑定数据与 ThumbPlayer 的对应关系
entity.videoView = videoView;  // 如需携带页面信息，必须设置（属性名为小写 v 开头的 videoView）
entity.isBizReady = YES;       // 仅子类 QLVRThumbPlayerEntity 有此便捷字段

[[QLVRThumbPlayerDataManager sharedInstance] bindVideoPlayerInfo:entity player:self.videoPlayer];
```

**中断播放前解绑：**

```objc
[[QLVRThumbPlayerDataManager sharedInstance] unbindVideoPlayerInfo:self.videoPlayer];
```

**播放过程中更新参数（延迟上报场景）：**

推荐使用子类 `QLVRThumbPlayerEntity`（具备便捷业务字段）：

```objc
QLVRThumbPlayerEntity *entity = [[QLVRThumbPlayerEntity alloc] init];
entity.extraParams = @{@"key": @"value"};
entity.isBizReady = YES;       // 子类便捷字段，会映射到基类的 bizReadyState（NSNumber *）
// entity.bizVideoPlayer = self.videoPlayer; // ❌ 基类上此属性为 readonly，业务禁止赋值
[[QLVRThumbPlayerDataManager sharedInstance] updateVideoPlayerInfo:entity player:self.videoPlayer];
```

> ⚠️ **基类 vs 子类**（`QLVRThumbPlayerBaseEntity.h` / `QLVRThumbPlayerEntity.h`）：
> - `bizVideoPlayer` 在基类上是 `readonly`，业务端赋值会编译报错
> - 便捷字段 `isBizReady` / `isIgnoreReport` **仅存在于子类 `QLVRThumbPlayerEntity`**；若必须直接用基类 `QLVRThumbPlayerBaseEntity`，对应字段名是 `bizReadyState` / `ignoreReportState`（类型均为 `NSNumber *`）

### 播放开始事件参数（dt_video_start）

| 参数 | 含义 | 类型 | 说明 |
|------|------|------|------|
| dt_start_type | 启播方式 | int | 1:首次播放 2:重播 |
| dt_start_reason | 启播原因 | int | 1:非续播 2:当前页续播 3:跨页面续播 |
| dt_content_type | 播放内容 | int | 1:广告 2:视频 |
| dt_content_id | 视频 ID | string | 业务指定 |

### 播放结束事件参数（dt_video_end）

| 参数 | 含义 | 类型 | 说明 |
|------|------|------|------|
| dt_end_reason | 结束原因 | int | 1:播放结束 2:正常结束 3:暂停 |
| dt_video_length | 视频时长 | long | 单位毫秒 |
| dt_play_duration | 播放时长 | long | 物理时长，单位毫秒 |
| dt_play_start_state_time | 播放开始位置 | long | 单位毫秒 |
| dt_play_end_state_time | 播放结束位置 | long | 单位毫秒 |

### 视频心跳

```objc
// 常规心跳
component.configuration.enableVideoHeartBeatReport = YES;
component.configuration.videoHeartBeatTimeIntervals = @[@15, @50, @90];

// 指定播放器心跳策略
[[QLVideoReport sharedInstance] setVideoHeartBeatWithIntervals:@[@(10), @(30)]
                                               heartBeatPolicy:QLVRVideoHeartBeatPolicySpecifiedInterval
                                                     bizPlayer:player];
```

### 页面数据标准化

```objc
// 打开采集开关
[QLVideoReport sharedInstance].configuration.videoPageSwitch = QLVideoPageSwitchAllOpen;

// 保证页面设置了 pgid
self.view.vr_pageId = @"video_page";

// bind 时绑定 videoView
entity.videoView = self.videoView;
```

## 页面阅读完成率

```objc
// 将视图标记为正文视图
[[QLVideoReport sharedInstance] markAsPageBodyView:currentView];

// 设置正文范围
[[QLVideoReport sharedInstance] setPageBodyContentRange:currentView
                                           startHeight:200
                                             endHeight:2000];
```

## 页面心跳

> ⚠️ **SDK 2.5.4.2 公开头文件未提供专门的页面心跳 API**（`QLVideoReport.h` / `QLVRDTReportComponent.h` 均无 `startPageHeartbeatWithView:interval:callback:` / `stopPageHeartbeatWithView:`）。以前文档里提到的这两个方法不可用，直接调用会编译报错。

SDK 当前公开的心跳能力有三类：

- **APP 心跳**：`component.configuration.enableAppHeartBeatReport` + `QLVRAPPReportConfiguration`（见前文「应用心跳」章节）
- **视频心跳**：`component.configuration.enableVideoHeartBeatReport` + `videoHeartBeatTimeIntervals`（见「视频心跳」章节）
- **音频心跳**：`AudioQueueReport` subspec 内提供

**推荐做法（自建页面心跳）**：在目标页面的 `viewWillAppear`/`viewWillDisappear` 中启停 `NSTimer`，定时通过 `reportEvent` 或 `dtReportDelegate` 上报自定义事件即可，参数可参考 `dt_pgid` / `dt_lvtm` / `dt_pg_imp_rate` 语义自行组装。

## 二跳时长归因（l1crepg）

```objc
// 初始化时打开开关
component.configuration.isReportL1CreParams = YES;
```

> l1crepg 完整信息只在 pgout 事件才会带上，其他事件为 none。

## delegate Hook 方式切换

针对 UITableView/UICollectionView/UIScrollView 等的 delegate hook：

```objc
// 全局设置
component.hookConfig.delegateHookMethod = QLVRDelegateHookMethodProxy;

// 局部设置
self.tableView.vr_delegateHookMethod = QLVRDelegateHookMethodProxy;
self.tableView.delegate = self;
```

| Hook 方式 | 说明 |
|-----------|------|
| SubClassHookBefore（默认） | 先 hook 再 setDelegate |
| SubClassHookAfter | 先 setDelegate 再 hook |
| Proxy | 使用 NSProxy 消息转发 |

## 自定义 PageParamsFormatter

```objc
component.configuration.paramsFormat = myFormatter;
```

实现 `IPageParamsFormatter` 协议对页面参数进行格式化。

> ⚠️ 会影响上报数据页面参数的层级，谨慎修改！

## 上报核验

### 方式一：控制台日志过滤

接入大同 SDK 日志后，过滤关键字：
- 2.2.5.3 之前：`[VR_EVENT]`
- 2.2.5.3 及之后：`[DT][report]`

### 方式二：可视化联调

进入大同平台，在可视化联调页面扫码跳转到 app 进行测试。
