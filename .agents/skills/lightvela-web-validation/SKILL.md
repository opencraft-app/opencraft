---
name: lightvela-web-validation
description: 当需要验证 LightVela Web 能力是否存在状态逻辑漏洞、入口断层、移动端/桌面端体验差异、用户理解误区，或需要用状态矩阵、Playwright/Browser/Chrome 截图留证并输出 HTML 测试报告时使用。适用于登录、订阅、续费、实名认证、受保护页面、支付前置链路、分支预览和线上站点的交互验收。
---

# LightVela Web Validation

本技能把单点页面测试升级成“状态矩阵验证”：先建模用户状态、入口、设备、动作和预期，再执行截图与接口留证，最后输出结构化 JSON 和 HTML 报告。它适合发现代码路径存在但用户不可达、登录/订阅状态串线、移动端文案死胡同、协议勾选门禁、OAuth 回跳参数等问题。

## 使用前检查

1. 先确认当前工作区和分支，不要覆盖用户已有改动：
   ```bash
   git status --short --branch
   ```
2. 阅读项目约束：
   - 仓库根 `AGENTS.md`
   - 目标子服务的 `AGENTS.md`，例如前端任务读取 `frontend/AGENTS.md`
   - 与能力相关的本地 skill、OpenSpec 或历史测试脚本
3. 如果用户要求“最新 master”，只更新 refs 或使用干净 sibling worktree；不要在脏工作区直接重置、stash 或覆盖用户文件。
4. 测试生产站点时只做非破坏性验证；没有用户明确授权，不提交订单、不完成支付、不消耗短信验证码、不写入真实账号数据。
5. 不要在截图、日志、报告、提交信息或最终回答中暴露 token、Cookie、手机号、实名信息、支付凭据、完整签名 URL。

## 核心方法

先设计用例，再开始测试。每个能力至少拆成五类变量：

- 用户状态：未登录、已登录、登录过期、残留假 token、未实名、已实名、有订阅、无订阅、临期、隔离期等。
- 入口状态：导航入口、受保护页面直达、营销页 CTA、弹窗关闭后重进、深链 query/hash、移动端分享链接等。
- 设备环境：桌面浏览器、移动端普通浏览器、微信内置浏览器、QQ/企业微信等特殊 UA。
- 操作动作：点击、切换登录方式、勾选协议、关闭弹窗、刷新、回退、伪造本地存储、OAuth 回跳。
- 观察结果：DOM 文案、按钮状态、网络请求、URL 变化、弹窗状态、截图、控制台/接口错误。

把以上变量合成矩阵，不要求穷举所有组合，但必须覆盖风险高、用户会自然遇到、以及代码分支容易串线的组合。

## 工作流

### 1. 建立真相来源

先确认目标环境和代码/运行时来源：

- 线上站点：记录 URL、时间、浏览器、网络环境、是否使用真实登录态。
- 分支预览或本地预览：记录分支、commit、启动命令、环境变量、端口。
- 代码来源：定位入口组件、repository/API 封装、路由守卫、OAuth/支付/实名等关键逻辑。
- 历史依据：读取相关 skill、报告、MR 讨论或 OpenSpec，但要用当前代码/页面重新验证可见事实。

### 2. 先输出测试用例矩阵

测试前先写出用例表，并让后续执行严格对照它补证据。推荐字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定编号，例如 `LOGIN-M-03` |
| `风险问题` | 这条用例要验证的漏洞或误区 |
| `初始状态` | 登录态、订阅态、本地存储、URL、设备/UA |
| `入口` | 用户从哪里进入 |
| `操作` | 具体点击/输入/刷新/关闭动作 |
| `预期` | 应出现或不应出现的结果 |
| `证据` | 截图、DOM、网络、源码或日志 |
| `结果` | `pass` / `warn` / `fail` / `blocked` |

用户补充“移动端也加进去”时，把移动端作为矩阵维度加入，而不是另写孤立冒烟用例。

### 3. 执行并留证

优先使用 Browser/Chrome/Playwright 做真实页面验证：

- 每条用例至少保留一张关键截图；复杂链路保留“初始状态 / 操作后 / 结果页”三段截图。
- 记录关键网络请求的状态码、跳转目标和错误响应；不要保存敏感 header 或 token 值。
- 对原生 `title`、隐藏 input、禁用按钮、ARIA 状态等截图不可见信息，补充 DOM 读取证据。
- 对 OAuth、支付、实名、短信等外部系统，只验证前置逻辑和跳转参数；除非用户明确提供测试账号和授权，否则停在安全边界前。
- 每个 `warn` 或 `fail` 都要说明它来自页面实测、接口证据、源码推断，还是尚未闭环的风险假设。

### 4. 检查漏洞与误区

除正常 happy path 外，至少扫描这些风险面：

- 登录/鉴权：受保护页面是否可绕过、残留 token 是否误判登录、401 后是否清理状态、多标签/刷新是否一致。
- 回跳与深链：`return_to` 是否同源、是否保留危险 `redirect`/`next` 参数、关闭登录后是否丢失用户意图。
- 协议与授权：未勾选协议是否禁止 OAuth/短信/QQ，切换登录方式后门禁是否仍生效。
- 入口一致性：同一能力在导航、CTA、直达 URL、移动端菜单中的文案和行为是否一致。
- 移动端理解：普通移动浏览器遇到微信能力时是否有可执行下一步，微信内置浏览器和桌面扫码是否被清楚区分。
- 错误恢复：短信空输入、接口失败、二维码失败、弹窗关闭、刷新/回退是否给出可理解反馈。
- 状态串线：实名、订阅、续费、支付、登录弹窗之间是否错误复用状态或误开弹窗。

## 报告输出

测试结束必须输出报告。推荐同时保留：

- `report-data.json`：结构化结论，便于后续 diff 和二次渲染。
- `*.html`：给用户阅读的正式报告，包含结论、问题分级、用例矩阵、截图/证据链接、未测边界。
- 截图目录：按用例编号命名，便于从报告跳转排查。

本技能附带 HTML 渲染脚本：

```bash
node .agents/skills/lightvela-web-validation/scripts/render-html-report.js \
  --input /tmp/lightvela-validation/report-data.json \
  --out /tmp/lightvela-validation/report.html
```

如果项目没有可用 Node，可使用 Codex bundled runtime：

```bash
/Users/junweicao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  .agents/skills/lightvela-web-validation/scripts/render-html-report.js \
  --input /tmp/lightvela-validation/report-data.json \
  --out /tmp/lightvela-validation/report.html
```

`report-data.json` 推荐结构：

```json
{
  "title": "LightVela 登录能力状态矩阵验证报告",
  "target": "https://lightvela.com",
  "generatedAt": "2026-08-01T00:00:00+08:00",
  "environment": {
    "branch": "origin/master@<sha>",
    "tester": "Codex",
    "devices": ["desktop", "mobile"]
  },
  "summary": [
    { "label": "总体结论", "value": "未发现 P0；发现 2 个 P1 理解风险" }
  ],
  "findings": [
    {
      "level": "P1",
      "title": "移动端非微信浏览器登录提示缺少下一步",
      "detail": "用户只能看到请在微信中打开，但不知道如何继续。",
      "recommendation": "提供复制链接、切换手机号/QQ 或打开微信的明确路径。",
      "evidence": ["screenshots/LOGIN-M-02.png"]
    }
  ],
  "cases": [
    {
      "id": "LOGIN-D-01",
      "title": "桌面端受保护页面直达",
      "device": "desktop",
      "initialState": "未登录",
      "entry": "/account",
      "action": "直接访问",
      "expected": "显示登录入口，不暴露账号数据",
      "actual": "401 后展示登录默认页",
      "result": "pass",
      "evidence": ["screenshots/LOGIN-D-01.png"]
    }
  ],
  "untested": ["真实成功登录后的多标签状态同步未验证"],
  "artifacts": [
    { "label": "原始网络记录", "path": "network-log.json" }
  ]
}
```

## 交付格式

最终回复用中文简要说明：

1. 测试目标、环境、桌面/移动端覆盖范围。
2. 总体结论和问题分级，不要把未验证假设说成已证实漏洞。
3. HTML 报告绝对路径，以及关键 JSON/截图目录。
4. 未覆盖边界，例如需要真实账号、短信、支付、实名测试环境才能验证的部分。
5. 是否修改仓库文件；如果只是测试报告，应明确没有改业务代码。

如果发现 P0/P1 风险，先给可复现路径和证据，再给修复建议。对于源码推断，明确标注“从源码推断，尚未完成页面实测闭环”。
