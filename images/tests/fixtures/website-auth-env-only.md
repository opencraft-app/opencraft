---
name: website-builder
---

# legacy fixture with user customization

## 认证与 API 地址

每个实例拥有一个由平台预置的永久凭据（`VELA_WEBSITE_KEY`）。
凭据格式为 `vik_<key_id>_<secret>`，权限范围绑定该实例及其所属用户，
只能调用建站相关接口，不暴露任何账号级权限；凭据不得复制或外泄。

**取值方式**（按顺序取第一个非空值）：

1. 环境变量 `VELA_WEBSITE_KEY`
2. 都不可用 → 停下来提示用户需要先通过 Vela 平台初始化实例，**不要继续调用 API**

API 地址同样从平台预置的环境变量 `VELA_API_BASE` 获取。
如果该变量不存在，按站点归属取生产默认值：
国内 `https://api.lightvela.com`、国际 `https://api.lightvela.ai`。

**注意：只有 API 地址有默认值，凭据没有默认值。**
`VELA_WEBSITE_KEY` 不存在时必须立即停止，不允许继续调用 API。

读取示例（token 与地址都不要 echo 出来）：

```bash
# API 地址：有默认值（国内站），变量不存在时降级使用
API_BASE="${VELA_API_BASE:-https://api.lightvela.com}"

# 凭据：无默认值，变量不存在时直接报错退出（:? 语法）
KEY="${VELA_WEBSITE_KEY:?VELA_WEBSITE_KEY not set, instance not initialized}"
```

请求头：

```
Authorization: Vela-Instance-Key <key>
Content-Type: application/json
```

## 保留用户定制内容

Synthetic custom content: do not upgrade this Skill.
