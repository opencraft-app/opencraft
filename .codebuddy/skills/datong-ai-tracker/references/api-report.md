# API 上报方式（兜底方案）

## 适用场景

无法引入平台专用 SDK 的场景：
- 小程序无法引入第三方 SDK
- iOS 原生应用（暂无专用 SDK）
- 后端服务上报
- 其他无法运行 JavaScript 的环境

> **注意**：H5 项目请使用 JS SDK，Android 项目请使用 beacon-android SDK，不要使用 API 兜底方式。

## 接口信息

- **接口地址**：`https://otheve.beacon.qq.com/analytics/v2_upload`
- **请求方式**：POST
- **Content-Type**：`application/json;charset=UTF-8`

## curl 示例

```bash
curl --location --request POST 'https://otheve.beacon.qq.com/analytics/v2_upload' \
--header 'Content-Type: application/json;charset=UTF-8' \
--data-raw '{
    "appVersion": "1.0.1",
    "sdkId": "js",
    "sdkVersion": "4.7.6-api",
    "platformId": 3,
    "mainAppKey": "your_app_key",
    "common": {
        "A2": "8hntm2tCCmiBpp6CQKDRW4xkFNeDwasd"
    },
    "events": [
        {
            "eventCode": "eventCode",
            "eventTime": "1624881770032",
            "mapValue": {
                "app": "initialize"
            }
        }
    ]
}'
```

## 请求体字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| mainAppKey | string | 大同 appkey（在 https://datong.woa.com 获取） |
| appVersion | string | 按示例填写 `"1.0.1"` |
| sdkId | string | 固定填 `"js"` |
| sdkVersion | string | 固定填 `"4.7.6-api"` |
| platformId | number | 固定填 `3` |
| common | object | 公共参数，**key/value 均为 string**，必须包含 A2 |
| events | array | 事件数组 |

### events 数组元素

| 字段 | 类型 | 说明 |
|------|------|------|
| eventCode | string | 事件 code |
| eventTime | string | 毫秒级时间戳 |
| mapValue | object | 事件私参，**key/value 均为 string** |

## 关键注意事项

- `mapValue` 内的 key/value 都必须是 **string** 类型
- `common` 内的 key/value 都必须是 **string** 类型
- `common` 中必须包含 `A2`（标识设备 ID 的随机字符串）
- `eventTime` 是毫秒级时间戳
- `sdkId`、`sdkVersion`、`platformId` 按照示例值填写即可