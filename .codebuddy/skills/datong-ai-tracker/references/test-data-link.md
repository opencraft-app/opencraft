# 测试数据上报（样例数据 mock & 上报）

通过 HTTP 请求往接入层发送 mock 测试数据，验证链路是否通畅。

> 🚨 **核心原则：样例数据必须与埋点方案关联，不能瞎编**
> mock 数据的 event_code、dt_pgid、dt_eid、udf_kv 参数必须从当前会话已确认的埋点方案（`dt_tracking_plan/{slug}-YYYYMMDDHH.md`）中提取，**禁止 AI 自行编造事件名、页面ID、元素ID 或参数名**。

---

## 上报接口

- **请求 URL**：`https://otheve.beacon.qq.com/analytics/v2_upload`
- **请求方法**：POST
- **请求头**：`Content-Type: application/json;charset=UTF-8` **必须！！**

---

## 请求体格式

```json
{
    "appVersion": "1.0.0",
    "sdkId": "js",
    "sdkVersion": "skill-demo",
    "mainAppKey": "xxxxxxxxxx",
    "platformId": 3,
    "common": {
        "A2": "8hntm2tCCmiBpp6CQKDRW4xkFNeDwasD"
    },
    "events": [
        {
            "eventCode": "eventCode",
            "eventTime": "1624881770032",
            "mapValue": {
                "A72": "skill-demo",
                "A88": "1773644623518",
                "A99": "Y",
                "A100": "100",
                "brand": "",
                "dpi": "96",
                "dt_eventid_h5": "1",
                "dt_mainlogin": "rtxName",
                "dt_omgid": "",
                "dt_pgid": "xxx",
                "dt_eid": "xxx",
                "dt_pgstp": "1",
                "dt_ref_pgid": "",
                "dt_sdkversion_h5": "4.7.4",
                "dt_sessionid_h5": "1781169976961470",
                "dt_uid": "lpb3b5uv1s_1",
                "hardware_os": "macos",
                "mf": "",
                "model": "",
                "network_type": "4g",
                "os_version": "10.15.7",
                "platform": "pc",
                "ref_url": "",
                "resolution": "3456",
                "scenes_plat": "",
                "scenes_version": "",
                "target_sdk": "10",
                "udf_kv": "{\"ref_pg\":{},\"ref_ele\":{},\"pgid\":\"home_universal_page\",\"pg_stp\":1,\"page_name\":\"落地页\"}",
                "url": "xxx",
                "web_channel": "",
                "web_core_type": "webkit",
                "web_core_version": "537.36",
                "web_version": ""
            }
        }
    ]
}
```

---

## 字段填写规则

### 固定字段（直接照抄，不要修改）

| 字段 | 固定值 | 说明 |
|------|--------|------|
| `appVersion` | `"1.0.0"` | |
| `sdkId` | `"js"` | |
| `sdkVersion` | `"skill-demo"` | 标记测试数据 |
| `platformId` | `3` | |
| `common.A2` | 随机16位字符串 | 设备标识，同一批次保持一致 |
| `mapValue.A72` | `"skill-demo"` | |
| `mapValue.A99` | `"Y"` | |
| `mapValue.brand` | `""` | |
| `mapValue.dpi` | `"96"` | |
| `mapValue.dt_mainlogin` | `"rtxName"` | |
| `mapValue.dt_omgid` | `""` | |
| `mapValue.dt_pgstp` | `"1"` | |
| `mapValue.dt_ref_pgid` | `""` | |
| `mapValue.dt_sdkversion_h5` | `"4.7.4"` | |
| `mapValue.hardware_os` | `"macos"` | |
| `mapValue.mf` | `""` | |
| `mapValue.model` | `""` | |
| `mapValue.network_type` | `"4g"` | |
| `mapValue.os_version` | `"10.15.7"` | |
| `mapValue.platform` | `"pc"` | |
| `mapValue.ref_url` | `""` | |
| `mapValue.resolution` | `"3456"` | |
| `mapValue.scenes_plat` | `""` | |
| `mapValue.scenes_version` | `""` | |
| `mapValue.target_sdk` | `"10"` | |
| `mapValue.web_channel` | `""` | |
| `mapValue.web_core_type` | `"webkit"` | |
| `mapValue.web_core_version` | `"537.36"` | |
| `mapValue.web_version` | `""` | |

### 动态字段（需从埋点方案提取或按规则生成）

| 字段 | 来源/规则 | ⚠️ 常见错误 |
|------|----------|------------|
| `mainAppKey` | 从上下文获取用户的 appkey | ❌ 不要写成 appId |
| `eventCode` | **必须**从埋点方案表格的「事件 event_code」列提取反引号内的英文值（如 `dt_pgin`、`dt_clck`、`search_confirm`） | ❌ 不要自己编造事件名，不要用中文事件名 |
| `eventTime` | 毫秒时间戳，每条事件递增（间隔 1-5 秒随机） | |
| `mapValue.A88` | 与当前事件的 `eventTime` 保持一致 | ❌ 不要和 eventTime 不一致 |
| `mapValue.A100` | 自增计数器，从 `"100"` 开始，每条事件 +1（如 100, 101, 102...） | |
| `mapValue.dt_eventid_h5` | 自增计数器，从 `"1"` 开始，每条事件 +1 | |
| `mapValue.dt_pgid` | **必须**从埋点方案表格的「页面 dt_pgid」列提取反引号内的英文值；该事件无页面时填 `""` | ❌ 不要自己编造页面 ID |
| `mapValue.dt_eid` | **必须**从埋点方案表格的「元素 dt_eid」列提取反引号内的英文值；该事件无元素时填 `""` | ❌ 不要自己编造元素 ID |
| `mapValue.dt_sessionid_h5` | 随机生成一个，**同一次会话（全部100条）保持一致** | |
| `mapValue.dt_uid` | 随机生成一个，**同一次会话（全部100条）保持一致** | |
| `mapValue.url` | 随机生成一个 URL 格式字符串即可 | |
| `mapValue.udf_kv` | **JSON 字符串**，见下方 udf_kv 专项说明 | ❌ 最容易出错，详见下方 |

---

## ⚠️ udf_kv 字段专项说明（最容易出错！）

`udf_kv` 是一个 **JSON 字符串**（不是 JSON 对象！），其内部 JSON 结构如下：

```json
{
    "ref_pg": {},
    "ref_ele": {},
    "pgid": "xxx",
    "pg_stp": 1,
    "eid": "xxx",
    // ... 事件私有参数
}
```

### udf_kv 内部字段规则

| 字段 | 规则 | 来源 |
|------|------|------|
| `ref_pg` | 固定 `{}` | |
| `ref_ele` | 固定 `{}` | |
| `pgid` | 与外层 `mapValue.dt_pgid` 的值**保持一致** | 从埋点方案「页面 dt_pgid」列提取 |
| `pg_stp` | 固定 `1` | |
| `eid` | 与外层 `mapValue.dt_eid` 的值**保持一致** | 从埋点方案「元素 dt_eid」列提取 |
| **私有参数** | **必须**从埋点方案「私有参数 udf_kv」列提取每个 `param_key`，生成合理的 mock 值（字符串类型） | 从埋点方案提取，❌ 不要自己编造参数名 |

### udf_kv 生成示例

假设埋点方案表格中某行：
```
事件 event_code: `dt_clck` 元素点击
页面 dt_pgid: `home` 首页
元素 dt_eid: `post_card` 帖子卡片
私有参数 udf_kv: `post_id` 帖子ID；`post_title` 帖子标题
```

则该事件的 `udf_kv` 应生成为：
```python
udf_kv_dict = {
    "ref_pg": {},
    "ref_ele": {},
    "pgid": "home",        # 与 dt_pgid 一致
    "pg_stp": 1,
    "eid": "post_card",    # 与 dt_eid 一致
    "post_id": "mock_post_001",     # 从 udf_kv 列提取的参数
    "post_title": "mock标题"        # 从 udf_kv 列提取的参数
}
udf_kv_str = json.dumps(udf_kv_dict, ensure_ascii=False)
```

**⚠️ 关键一致性约束**：
- `udf_kv.pgid` 必须等于 `mapValue.dt_pgid`
- `udf_kv.eid` 必须等于 `mapValue.dt_eid`
- `udf_kv` 中的私有参数 key 必须与埋点方案表格中 `udf_kv` 列的 `param_key` 完全一致

---

## 从埋点方案提取数据的流程

1. 读取 `dt_tracking_plan/{slug}-YYYYMMDDHH.md` 文件
2. 解析埋点事件表格，提取每一行的事件信息：
   - `event_code`：从「事件 event_code」列反引号内提取英文值
   - `dt_pgid`：从「页面 dt_pgid」列反引号内提取英文值，`—` 视为空字符串
   - `dt_eid`：从「元素 dt_eid」列反引号内提取英文值，`—` 视为空字符串
   - `udf_kv_params`：从「私有参数 udf_kv」列提取所有 `param_key`（反引号内的英文键名），`—` 视为无参数
3. 根据提取的事件列表生成 100 条 mock 数据：
   - 遍历所有事件行，循环分配直到凑够 100 条
   - 每条数据的事件参数（event_code/dt_pgid/dt_eid/udf_kv 私有参数）必须来自埋点方案

---

## Python 脚本模板

> ⚠️ **必须使用 Python 脚本实现**，禁止用 curl 命令行（因为 mock 数据量大）。

```python
#!/usr/bin/env python3
"""大同埋点样例数据上报脚本 - 自动生成"""

import json
import time
import random
import string
import requests
import sys

# ========== 配置 ==========
APPKEY = ""  # 从上下文填入 appkey
UPLOAD_URL = "https://otheve.beacon.qq.com/analytics/v2_upload"
TOTAL_EVENTS = 100

# ========== 从埋点方案提取的事件列表 ==========
# ⚠️ 以下 events_list 必须从埋点方案表格中提取，禁止自行编造
# 每个事件格式: {
#     "event_code": "事件英文名",
#     "dt_pgid": "页面ID英文名，无则为空字符串",
#     "dt_eid": "元素ID英文名，无则为空字符串",
#     "udf_kv_params": {"param_key": "mock_value", ...}  # 私有参数及mock值
# }
events_list = [
    # 示例（实际需从埋点方案提取替换）：
    # {
    #     "event_code": "dt_pgin",
    #     "dt_pgid": "home",
    #     "dt_eid": "",
    #     "udf_kv_params": {"page_name": "首页"}
    # },
    # {
    #     "event_code": "dt_clck",
    #     "dt_pgid": "home",
    #     "dt_eid": "post_card",
    #     "udf_kv_params": {"post_id": "mock_001", "post_title": "测试帖子"}
    # },
]

# ========== 固定值 ==========
FIXED_MAP_VALUE = {
    "A72": "skill-demo",
    "A99": "Y",
    "brand": "",
    "dpi": "96",
    "dt_mainlogin": "rtxName",
    "dt_omgid": "",
    "dt_pgstp": "1",
    "dt_ref_pgid": "",
    "dt_sdkversion_h5": "4.7.4",
    "hardware_os": "macos",
    "mf": "",
    "model": "",
    "network_type": "4g",
    "os_version": "10.15.7",
    "platform": "pc",
    "ref_url": "",
    "resolution": "3456",
    "scenes_plat": "",
    "scenes_version": "",
    "target_sdk": "10",
    "url": "https://example.com/page",
    "web_channel": "",
    "web_core_type": "webkit",
    "web_core_version": "537.36",
    "web_version": "",
}

def generate_random_str(length=16):
    """生成随机字符串"""
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=length))

def build_event(event_info, event_time, event_id_counter, session_id, uid, device_id):
    """构建单条事件"""
    map_value = FIXED_MAP_VALUE.copy()
    map_value["A88"] = str(event_time)
    map_value["A100"] = str(event_id_counter)
    map_value["dt_eventid_h5"] = str(event_id_counter - 99)  # 从1开始
    map_value["dt_pgid"] = event_info["dt_pgid"]
    map_value["dt_eid"] = event_info["dt_eid"]
    map_value["dt_sessionid_h5"] = session_id
    map_value["dt_uid"] = uid

    # 构建 udf_kv
    udf_kv = {
        "ref_pg": {},
        "ref_ele": {},
        "pgid": event_info["dt_pgid"],
        "pg_stp": 1,
        "eid": event_info["dt_eid"],
    }
    # 添加私有参数
    udf_kv.update(event_info["udf_kv_params"])
    map_value["udf_kv"] = json.dumps(udf_kv, ensure_ascii=False)

    return {
        "eventCode": event_info["event_code"],
        "eventTime": str(event_time),
        "mapValue": map_value,
    }

def main():
    if not APPKEY:
        print("❌ APPKEY 未配置，请填入 appkey 后重试")
        sys.exit(1)

    if not events_list:
        print("❌ events_list 为空，请从埋点方案提取事件后填入")
        sys.exit(1)

    session_id = generate_random_str(16)
    uid = generate_random_str(12)
    device_id = generate_random_str(32)

    base_time = int(time.time() * 1000)
    events = []

    for i in range(TOTAL_EVENTS):
        event_info = events_list[i % len(events_list)]
        event_time = base_time + (i * random.randint(1000, 5000))
        event_id_counter = 100 + i

        event = build_event(event_info, event_time, event_id_counter, session_id, uid, device_id)
        events.append(event)

    payload = {
        "appVersion": "1.0.0",
        "sdkId": "js",
        "sdkVersion": "skill-demo",
        "mainAppKey": APPKEY,
        "platformId": 3,
        "common": {
            "A2": device_id,
        },
        "events": events,
    }

    headers = {
        "Content-Type": "application/json;charset=UTF-8",
    }

    try:
        response = requests.post(UPLOAD_URL, json=payload, headers=headers, timeout=30)
        if response.status_code == 200:
            result = response.json()
            print(f"✅ 样例数据上报成功！共 {TOTAL_EVENTS} 条事件")
            print(f"   响应: {json.dumps(result, ensure_ascii=False)}")
        else:
            print(f"❌ 上报失败，HTTP 状态码: {response.status_code}")
            print(f"   响应: {response.text}")
    except Exception as e:
        print(f"❌ 上报异常: {e}")

if __name__ == "__main__":
    main()
```

---

## 执行步骤

1. **读取埋点方案**：读取 `dt_tracking_plan/{slug}-YYYYMMDDHH.md`，解析表格提取事件列表
2. **生成 Python 脚本**：基于上方模板，将提取的事件列表填入 `events_list`，将 appkey 填入 `APPKEY`
3. **执行脚本**：`python3 {脚本路径}` 完成上报
4. **验证结果**：检查输出是否为 `✅ 样例数据上报成功`
5. 上报失败时，根据错误信息调整数据后重试，最多 3 次
