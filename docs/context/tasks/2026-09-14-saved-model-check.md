---
id: saved-model-check
type: task
scope: 将连接检查改为后端检查已保存的模型连接与凭据
triggers:
  - opencraft
  - saved-model-check
  - model-credentials
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/local-agent-custom-providers.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

# 已保存连接检查

## requirement_ids

- saved-model-check

## requirement_refs

- 当前用户确认检查应使用已保存密钥，不应每次要求重新输入。

## requirement_excerpt

“检查能力应就是用保存了的密钥”、“好的，搞起来。”

## goal / non_goals

检查已提交连接，后端解析密钥并校验版本；脏草稿先保存，不自动提交，不向界面返回密钥。不扩大为任意地址携带已存凭据的探测代理，不调用真实付费模型，不改用户配置。

## context_receipt

- opencraft/AGENTS.md
- opencraft/docs/local-agent-custom-providers.md
- opencraft/design/model-configuration.md
- opencraft/docs/build-matrix.md
- 现有 controller.test、runtime-model-probe 和模型检查测试

## acceptance / validation

密钥输入为空也能检查；未保存修改拒绝；不接受调用方 URL/Key；版本变化、密钥缺失和模型不属该连接不发请求。后端与控制器测试、真实组件/隔离 HTTP 服务、完整门禁和 Mac 入口验证。

## checkpoint

10 项聚焦测试及产品模型 UI smoke 通过：切换页面清空前端 Key 后，使用已保存连接检查成功。npm run gate、build:electron、Mac arm64 打包和 codesign 验证通过。

已打开 release/saved-model-check-preview/mac-arm64/OpenCraft Preview.app；实际窗口只读验证确认 API Key 输入为空且检查按钮可用。Electron 技能指定的 agent-browser 未安装，使用 Playwright CDP 完成等价验证，截图 /tmp/opencraft-saved-model-check-native.png。真实窗口未点击检查，未调用付费模型，未修改用户连接或密钥。未提交或推送。
