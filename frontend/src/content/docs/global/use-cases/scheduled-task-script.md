# 在 LightVela 中运行脚本任务

## 摘要

**脚本任务可以让云端 Agent 按计划运行 Bash 或 Python 脚本，不调用 AI 模型，也不消耗模型 Token。** 本页用磁盘使用率检查和导出文件检查说明如何配置脚本、执行时间、生效时间段和交付通道。

脚本任务非常适合云端 Agent，因为它可以按计划运行 Bash 或 Python 脚本，不需要调用 AI 模型。
当你需要按照清晰、可预测的规则进行重复性系统检查时，就可以使用它。
有人用它设置磁盘使用率提醒；也有人创建检查，用来发现缺失或过期的文件。

## 脚本可以解决的常见问题

许多小型系统问题都可以通过简单检查发现。
但是，这些检查往往会被忘记，直到某些功能停止工作。

- 磁盘使用量增长，却没有被注意到。
- 每日导出停止生成新文件。
- 备份文件变得过期。
- 直到问题影响其他工作后才被发现。

在 LightVela 中，你可以为脚本任务配置 Bash 或 Python 代码、执行时间、生效时间段和交付通道。
任务不会调用模型，因此不会消耗模型 Token。
[定时任务文档](https://lightvela.ai/zh-sg/docs/configuration/automation?from=social_x)介绍了可用的调度和通知选项。

## 案例 1：磁盘使用率提醒

每天早上，Bash 脚本任务会检查可用磁盘空间，并且只在使用率达到 80% 时报告。

脚本：

```bash
used=$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')

if [ "$used" -ge 80 ]; then
  echo "Disk usage alert: ${used}% used."
fi
```

![创建用于磁盘使用率提醒的重复脚本任务](../images/scheduled-task-script-zh-1.png)

如果磁盘使用率低于阈值，脚本不会输出内容，也不会发送通知。
这样可以让例行检查保持安静，只有需要处理的问题才会引起注意。

## 案例 2：缺失或过期的导出文件

每个工作日晚上，Python 脚本任务会检查最新导出文件是否存在，以及它是否在过去 24 小时内更新过。

脚本：

```python
from pathlib import Path
from time import time

file = Path("/path/to/latest-export.csv")

if not file.exists() or time() - file.stat().st_mtime > 86400:
    print("Export alert: the latest file is missing or over 24 hours old.")
```

![编辑用于检查缺失或过期导出文件的重复脚本任务](../images/scheduled-task-script-zh-2.png)

请将示例路径替换为真实的导出位置。
如果文件存在且较新，脚本会安静地完成，不会发送不必要的消息。

## 直接在即时通信应用中更新我

LightVela 支持通过[通道配置](https://lightvela.ai/zh-sg/docs/configuration?from=social_x)将 Agent 接入 WhatsApp、Telegram、WeChat、Discord 等平台。
你可以同时接入一个或多个通道。
在定时任务中，你可以切换每个已配置的通道，决定脚本提醒应该发送到哪里。

![脚本任务通过微信直接发送磁盘使用率检查结果](../images/scheduled-task-script-zh-3.png)

当脚本产生非空的标准输出时，Hermes 会将这些输出直接发送到你的即时通信应用。
如果脚本没有输出内容，任务会完成，但不会发送通知。

## 管理多个任务

你可以根据需要设置任意数量的定时任务。
创建后，你可以编辑脚本和执行时间，暂停任务，并浏览历史运行记录。
在设置任务前，请测试每个脚本，尤其是它会访问重要文件时。

![Scheduled Tasks 中包含脚本任务的当前任务列表](../images/scheduled-task-script-zh-4.png)

使用 LightVela，让你的个人 Hermes Agent 在你专注于其他工作时持续处理可预测的检查。
