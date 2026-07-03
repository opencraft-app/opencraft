# Android SDK（beacon-android）高级功能

## 设置用户信息

```java
// 设置用户 ID
BeaconReport.getInstance().setUserId("user_id");

// 设置 OAID（需用户授权后采集）
BeaconReport.getInstance().setOAID("oaid_value");
```

> ⚠️ 4.2.57 版本起，无法通过 `BeaconReport.getInstance().getOAID()` 从灯塔获取 oaid，业务需自行获取后设置。

## 设置公共参数

公共参数会随每次事件上报一起发送，适合全局不变的值（如 channel、version）。

```java
Map<String, String> commonParams = new HashMap<>();
commonParams.put("channel", "google_play");
commonParams.put("version", "1.0.0");
BeaconReport.getInstance().setCommonParams(commonParams);
```

### 公参 vs 私参

| 类型 | 添加方式 | 适用场景 | 举例 |
|------|---------|---------|------|
| 公共参数 | `setCommonParams()` | 全局不变的值 | channel, version |
| 事件私参 | `BeaconEvent.setParams()` | 每次触发可能变化的值 | item_id, button_name |

## 初始化参数（BeaconConfig）

```java
BeaconConfig config = BeaconConfig.builder()
        .setNeedInitQimei(true)       // 是否初始化 qimei
        // 更多配置项可通过 builder 方法设置
        .build();

BeaconReport.getInstance().start(context, "YOUR_APP_KEY", config);
```

## 多进程上报

4.2 版本支持多进程上报，需要**在每个进程中分别初始化 SDK**。每个进程独立调用 `BeaconReport.getInstance().start()`。

## Qimei 获取

### 接口对照表

| 功能 | 旧接口 | 新接口 | 说明 |
|------|--------|--------|------|
| 同步获取 Qimei | `getQimei()` | `getQimei(String appkey)` | 旧接口在 `start()` 前调用会抛异常 |
| 异步获取 Qimei | `getQimei(listener)` | `getQimei(appkey, context, listener)` | 旧接口在 `start()` 前调用会抛异常 |
| 不依赖初始化同步获取 | `getRTQImei(context)` | `getRTQImei(context, appkey)` | 新接口在 `start()` 前调用耗时 28~40ms |
| 获取 qimei16 | `getQimeiOld()` | `getQimei16()` | 对应 A3 字段 |
| 获取 qimei36 | `getQimeiNew()` | `getQimei36()` | 对应 A153 字段，需后台开启双列 Qimei |

**同步获取：**

```java
BeaconReport.getInstance().getQimei("MAIN_APPKEY");
```

**异步获取：**

```java
BeaconReport.getInstance().getQimei("MAIN_APPKEY", context, new IAsyncQimeiListener() {
    @Override
    public void onQimeiDispatch(Qimei qimei) {
        Log.i(TAG, "qimei16: " + qimei.getQimei16() + ", qimei36: " + qimei.getQimei36());
    }
});
```

### qimeiSDK 初始化时机

1. 业务未调用 API 获取 qimei → `start()` 后异步初始化
2. 业务在 `start()` 前获取 qimei → `start()` 之前初始化
3. 业务在 `start()` 后立即获取 → `start()` 之后同步初始化
4. 业务在 `start()` 后异步获取 → `start()` 之后异步初始化

---

## 事件错误码

| 错误码 | 含义 |
|:------:|------|
| 0 | 成功 |
| 100 | 事件在黑名单列表中 |
| 101 | 事件被后台配置抽样 |
| 102 | 事件模块功能被关闭 |
| 103 | 事件被提交到 DB 失败 |
| 104 | 当前事件没有对应的通道 |
| 105 | 事件整体 kv 字符串大于 45K |
| 106 | 事件名为空 |

---

## 版本升级注意

- 由低版本**升级到 4.2.82.x** 及以后版本，有较多接口改动，详见 [升级指引](https://iwiki.woa.com/pages/viewpage.action?pageId=1346535804)
- 成本优化配置见 [安卓端 SDK 成本管理说明](https://iwiki.woa.com/pages/viewpage.action?pageId=1794658485)

## 相关链接

- qimeiSDK 集成指南：https://iwiki.woa.com/pages/viewpage.action?pageId=858293542
- 灯塔预置字段表：https://doc.weixin.qq.com/sheet/e3_m_FQqjSTulsZmQ
- Demo 地址：https://git.code.oa.com/beacon-open-source/beacon-demo-android/tree/dev/4.0.0
- SDK 开源地址：https://git.code.oa.com/beacon-open-source/beacon-sdk-android
