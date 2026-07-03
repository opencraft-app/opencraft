# iOS SDK（beacon-ios）高级功能

## 设置用户信息

```objc
// 设置用户唯一标识
BeaconReport.sharedInstance.userId = @"user_id";
```

## 设置公共参数

公共参数会随每次事件上报一起发送，适合全局不变的值（如 channel、version）。

```objc
[BeaconReport.sharedInstance setAdditionalInfo:@{
    @"channel": @"appstore",
    @"version": @"1.0.0"
} forAppKey:@"YOUR_APP_KEY"];
```

### 公参 vs 私参

| 类型 | 添加方式 | 适用场景 | 举例 |
|------|---------|---------|------|
| 公共参数 | `setAdditionalInfo:forAppKey:` | 全局不变的值 | channel, version |
| 事件私参 | `BeaconEvent` 的 `params` | 每次触发可能变化的值 | item_id, button_name |

## 初始化参数（BeaconConfig）

```objc
// 通过 config 对象配置更多初始化选项
BeaconConfig *config = [[BeaconConfig alloc] init];
// 设置需要的配置项...

[BeaconReport.sharedInstance startWithAppkey:@"YOUR_APP_KEY" config:config];
```

## 开启 SDK 日志

便于集成调试，开启后可在 Xcode 控制台查看灯塔日志：

```objc
[BeaconReport.sharedInstance setLogLevel:BeaconLogLevelDebug];
```

> ⚠️ 开启日志模式后，如果出现初始化异常（如空 appkey、重复初始化等），SDK 会主动抛异常帮助排查。

## Qimei 获取

### 同步获取

```objc
// SDK 初始化时会默认发起网络请求获取 qimei 并存储在本地
// 新接入 36 位 qimei 的业务，需要联系 neilyuhuang 打开后台开关
QimeiContent *qimei = [BeaconReport.sharedInstance getQimeiForAppKey:@"YOUR_APP_KEY"];
NSLog(@"qimeiOld: %@, qimeiNew: %@", qimei.qimeiOld, qimei.qimeiNew);
```

### 异步获取

```objc
// 如果本地没有 qimei，则等待网络请求回调
// ！！！只建议在 APP 启动阶段调用一次，其余阶段使用同步接口
[BeaconReport.sharedInstance getQimeiWithBlock:^(QimeiContent * _Nullable qimei) {
    NSLog(@"qimeiOld: %@, qimeiNew: %@", qimei.qimeiOld, qimei.qimeiNew);
} forAppKey:@"YOUR_APP_KEY"];
```

## 本地抽样功能

根据 appkey 和 eventCode 进行本地抽样，分母固定 10000：

| 分子值 | 含义 |
|:------:|------|
| 1 | 万分之一 |
| 10 | 千分之一 |
| 100 | 百分之一 |
| 0 | 不上报 |

**推荐在初始化之前调用**：

```objc
NSDictionary *sampleEvents = @{@"TestCode1": @(100), @"TestCode2": @(100)};
BOOL result = [BeaconReport.sharedInstance setUserSampleEvents:sampleEvents
                                                     forAppKey:@"YOUR_APP_KEY"];
```

## 辅助功能：穿山甲日志适配

**重要！！** 强烈建议将灯塔 SDK 的 log 接入穿山甲等在线日志捞取平台，加速排查线上问题。

```objc
// 建议在调用灯塔 start 初始化接口前设置穿山甲代理
BeaconReport.sharedInstance.mttDelegate = self;

// 实现穿山甲适配协议
- (void)mttLog:(nonnull NSString *)message
          file:(nonnull const char *)file
      function:(nonnull const char *)function
          line:(NSUInteger)line
      threadID:(NSInteger)threadID
        module:(nonnull NSString *)module
        folder:(int)folder
         level:(int)level {
    [MttLogSDK mttLog:message
                 file:file
             function:function
                 line:line
             threadID:threadID
               module:module
               folder:folder
                level:level];
}
```

> 穿山甲 SDK 集成参考：[MttLogSDK iOS 接入指南](https://iwiki.woa.com/pages/viewpage.action?pageId=134800059)

## 集成反作弊功能

### 1. 导入 framework

在项目中导入 `BeaconAPI_Audit.framework`。

### 2. 启动渠道稽核

```objc
#import <BeaconAPI_Audit/BeaconAuditInterface.h>

// 在初始化灯塔 SDK 前打开稽核开关
[BeaconAuditInterface setAuditEnable:YES];
```

### 3. 处理 OpenURL

在 `AppDelegate` 的 `openURL` 方法中添加：

```objc
[BeaconAuditInterface handleOpenURL:url sourceApplication:sourceApplication];
```

## Mac 平台支持

灯塔 SDK 已通过 Catalyst 技术支持 iOS 和 Mac 跨平台（纯 Mac 平台仍在开发中）。

跨平台 App 额外工作：将 `.framework` 替换为 `.xcframework`，其余集成方式和使用方法与 iOS 一致。

---

## 相关链接

- 灯塔入库字段说明：https://docs.qq.com/sheet/DWmVNWWdtY3JpSkZS
- 灯塔上报 SDK 4.0+ 接口文档：https://docs.qq.com/doc/DVkltV3FYeXdaTkJx
