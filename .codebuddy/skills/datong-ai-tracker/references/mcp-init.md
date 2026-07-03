### Phase 0：大同 MCP 环境准备（MANDATORY PREREQUISITE - BLOCKS ALL）

> **[CRITICAL] 硬性前置条件**
> 大同 MCP 是整个 Skill 的基础设施，用于自动注册应用、获取 Appkey、反查应用 ID、上传埋点方案等。
> **如果此 Phase 未通过，禁止进入后续任何步骤。** 没有降级路径，没有跳过选项。

大同 MCP 通过 **IDE MCP 配置**接入：

| 方式 | 适用场景 | 检测方法 |
|------|---------|---------|
| **IDE MCP 配置** | CodeBuddy、Cursor 等支持 MCP 协议的 IDE | 检测 IDE 环境中是否已有大同 MCP 工具可调用 |

---

## 检测流程

```
Phase 0 开始
  │
  ├─ Step 0.1：检测 IDE MCP 配置
  │   ├─ 成功 → ✅ MCP 环境就绪，进入后续流程
  │   └─ 失败 → Step 0.2 引导用户配置
  │
  └─ Step 0.2：引导用户在 IDE 中配置大同 MCP → 重新检测
```

---

## Step 0.1：检测 IDE MCP 配置

尝试直接调用大同 MCP 工具来验证 IDE 是否已配置好大同 MCP 服务。

**检测方法**：尝试调用一个轻量的大同 MCP 工具（如 `search_app`），观察是否能正常返回结果。

| 结果 | 处理 |
|------|------|
| 工具调用成功（返回正常数据或空结果） | ✅ **MCP 环境就绪**，直接进入后续流程 |
| 工具不存在 / 调用报错 / 401 未授权 | → 进入 Step 0.2 引导用户配置 |

> ⚠️ 检测是**静默的**，不需要向用户展示检测过程。如果成功就直接继续，失败就引导用户配置。

> 💡 **IDE MCP 配置方式说明**：在 CodeBuddy 等 IDE 中，用户可以通过 MCP 配置文件（如 `.codebuddy/mcp.json`）添加大同 MCP 服务：
> ```json
> {
>   "mcpServers": {
>     "大同Trackmate MCP": {
>       "url": "https://trackmate.mcp.it.woa.com"
>     }
>   }
> }
> ```
> 配置后 IDE 会自动处理 OAuth 授权，无需手动操作。

---

## Step 0.2：引导用户在 IDE 中配置大同 MCP

当检测到 IDE 中未配置大同 MCP 时，向用户展示配置指引：

```markdown
⛔ **大同 MCP 环境未就绪，无法继续执行。**

大同 MCP 是本 Skill 所有能力（埋点接入、看板创建、联调）的基础设施，必须配置成功才能继续。

**请在 IDE 中配置大同 MCP：**

在 CodeBuddy / Cursor 等 IDE 的 MCP 配置中添加：
```json
{
  "mcpServers": {
    "大同Trackmate MCP": {
      "url": "https://trackmate.mcp.it.woa.com"
    }
  }
}
```
- CodeBuddy：设置 → MCP 配置（用户级别）→ 添加
- 添加后 IDE ，点击连接，IDE拉起 OAuth 授权页面，完成授权即可
配置完成后告诉我，我会重新检测。
```

**[CRITICAL] STOP 并等待用户配置完成。** 用户确认后回到 Step 0.1 重新检测。
