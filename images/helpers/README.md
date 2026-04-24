# Helpers

本目录只放辅助脚本，不作为 `images/` 的主入口。

## 构建与部署

- [build-envd-agent.sh](build-envd-agent.sh)
  本地构建 `lightclaw-envd-agent` 二进制，供上层入口脚本调用。
- [reset-remote.sh](reset-remote.sh)
  远端轻量清理脚本，用于回归前重置目标机器。

## OpenClaw 配置

### 大模型 API 配置

- [config-llm-api.sh](config-llm-api.sh)
  配置 OpenClaw 使用自定义大模型 API（如腾讯云 LKEAP、OpenAI 兼容接口等）。
- [config-llm.env.example](config-llm.env.example)
  大模型 API 配置文件模板。

用法示例：
```bash
# 使用命令行参数
bash config-llm-api.sh root@119.28.239.108 --port 36000 \
  --base-url "https://api.lkeap.cloud.tencent.com/coding/v3" \
  --model-id "glm-5" \
  --api-key "your-api-key"

# 使用配置文件
cp config-llm.env.example config-llm.env
# 编辑 config-llm.env 填入实际值
bash config-llm-api.sh root@119.28.239.108 --port 36000 --env-file ./config-llm.env
```

### QQ 消息通道配置

- [config-qq-channel.sh](config-qq-channel.sh)
  配置 OpenClaw 的 QQBot 消息通道。
- [config-qq.env.example](config-qq.env.example)
  QQ 消息通道配置文件模板。

用法示例：
```bash
# 使用命令行参数
bash config-qq-channel.sh root@119.28.239.108 --port 36000 \
  --token "AppID:AppSecret"

# 使用配置文件
cp config-qq.env.example config-qq.env
# 编辑 config-qq.env 填入实际值
bash config-qq-channel.sh root@119.28.239.108 --port 36000 --env-file ./config-qq.env
```

## 推荐入口

- 正式流水线入口：[build-image.py](../build-image.py)
- 手动部署入口：[deploy-build.sh](../deploy-build.sh)
- 远端核心构镜脚本：[build.sh](../build.sh)
