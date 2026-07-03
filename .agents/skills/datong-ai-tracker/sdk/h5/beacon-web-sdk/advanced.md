# 轻量版 SDK（beacon-web-sdk）高级功能

## 页面关闭前上报

使用 `navigator.sendBeacon` 在页面卸载时上报，避免因进程关闭导致上报失败。

```javascript
beacon.onSendBeacon('eventCode', {
  key1: 'value1'
})
```

> **⚠️ 注意**  
> 仅用于页面跳转/关闭场景，该方法上报的事件标识为实时事件。

## 设置公共参数

```javascript
beacon.addAdditionalParams({
  user_id: '12345',
  channel: 'web'
})
```

- 在初始化后、触发埋点之前调用一次
- 仅用于全局不变的值（如 user_id、channel、platform）
- 每次上报会自动携带这些参数

### 公参 vs 私参

| 类型 | 添加方式 | 适用场景 | 举例 |
|------|---------|---------|------|
| 应用公参 | `beacon.addAdditionalParams()` | 全局不变的值 | user_id, channel |
| 事件私参 | `beacon.onUserAction(code, params)` | 每次触发可能变化的值 | button_id, item_id |

**禁止将事件私参通过 `addAdditionalParams()` 添加！**

## 设置用户信息

```javascript
// 设置用户 ID
beacon.setOpenId('123456')

// 设置用户唯一 ID（类似 idfv）
beacon.setUnionid('sfwflr3j3erl123ej')

// 设置渠道
beacon.setChannelId('1001')
```

## 获取设备 ID

```javascript
const deviceId = beacon.getDeviceId()
```

---

## 初始化参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| appkey | string | 必填 | 系统或项目 APPKEY |
| versionCode | string | - | 项目版本号 |
| channelID | string | - | 渠道标识 |
| openid | string | - | 用户 ID |
| unionid | string | - | 用户唯一 ID（类似 idfv） |
| delay | number | 1000 | 普通事件延迟上报时间（毫秒） |
| sessionDuration | number | 1800000 | session 超时时间（毫秒），默认 30 分钟 |
| uploadUrl | string | - | 自定义事件上报 URL |
| strictMode | boolean | false | 严苛模式，会主动抛异常，**上线务必关闭** |
| onReportSuccess | function | - | 上报成功回调 |
| onReportFail | function | - | 上报失败回调 |
| onReportBeforeSend | function | - | 上报前回调，可修改待发送数据 |
| isOversea | boolean | false | 是否使用海外版 |

**配置示例：**

```javascript
const beacon = new BeaconAction({
  appkey: 'your_app_key',
  versionCode: '1.0.0',
  channelID: 'web',
  delay: 2000,
  onReportSuccess: (e) => {
    console.log('上报成功：', e)
  },
  onReportFail: (e) => {
    console.log('上报失败：', e)
  }
})
```

## 上报前数据修改

通过 `onReportBeforeSend` 回调，可在上报前修改待发送数据：

```javascript
const beacon = new BeaconAction({
  appkey: 'your_app_key',
  onReportBeforeSend: (config) => {
    const { url, method, data } = config
    return {
      data: { ...data, extra_field: 'value' }
    }
  }
})
```

## 多通道上报

需要同时向多个 appkey 上报时，创建多个实例即可：

```javascript
const beacon1 = new BeaconAction({
  appkey: 'appkey_1'
})

const beacon2 = new BeaconAction({
  appkey: 'appkey_2'
})
```

---

## 联调配置

开发环境验证埋点时，初始化添加 debugId 和 appId：

```javascript
const beacon = new BeaconAction({
  appkey: 'your_app_key',
  debugId: 'dt_abc123_1737205452',
  appId: 'your_app_id'
})
```

> 仅用于开发测试，**生产环境禁止配置 debugId**。通过 `start_realtime_debug_mode` 工具生成 debugId。

## 版本要求

- 最低版本：**4.7.6**
- 低于 4.7.6 的项目需要升级
