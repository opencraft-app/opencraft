import type { ConnectorDefinition, ConnectorField } from "./contract";

// Service identities and setup recipes adapted from Octop ae65fe4 (MIT).
// Visuals, execution, credentials and lifecycle are OpenCraft-owned. See NOTICE.md.
const secret = (key: string, label: string, required = true): ConnectorField => ({ key, label, secret: true, required });
const field = (key: string, label: string, required = true): ConnectorField => ({ key, label, secret: false, required });
const token = [secret("token", "访问令牌")];
const api = [secret("api_key", "API Key")];
type Entry = readonly [string, string, ConnectorDefinition["category"], string, ConnectorDefinition["adapter"], string, readonly ConnectorField[], string];
const entries: readonly Entry[] = [
  ["tencent-docs", "腾讯文档", "办公", "读写文档、智能表格与空间文件", "mcp", "https://docs.qq.com/open/auth/mcp.html", token, "登录腾讯文档 MCP 授权页，复制访问令牌。"],
  ["tencent-ima", "腾讯 IMA", "知识", "检索知识库、读写笔记", "api", "https://ima.qq.com/agent-interface", [secret("api_key", "API Key"), field("client_id", "Client ID")], "在 IMA 获取 API Key 与 Client ID；API Key 仅展示一次。"],
  ["tencent-meeting", "腾讯会议", "办公", "会议、录制与智能纪要", "mcp", "https://meeting.tencent.com/ai-skill.html", token, "登录腾讯会议 Skill 配置页，复制 Token。"],
  ["tencent-news", "腾讯新闻", "媒体", "新闻搜索与热点订阅", "api", "https://news.qq.com/exchange?scene=appkey", api, "登录腾讯新闻 Skills 页面生成 API Key。"],
  ["wechat-reading", "微信读书", "媒体", "书架与读书笔记", "api", "https://weread.qq.com/r/weread-skills", api, "登录微信读书 Skills，获取 wrk- 开头的 API Key。"],
  ["tencent-lexiang", "腾讯乐享", "办公", "知识检索与文档管理", "mcp", "https://lexiangla.com/ai/claw", [field("company_from", "企业标识"), secret("api_key", "访问令牌")], "登录乐享凭证页，分别复制企业标识和访问令牌。"],
  ["tencent-weiyun", "腾讯微云", "办公", "网盘文件与分享管理", "mcp", "https://www.weiyun.com/act/openclaw", token, "登录微云 Skill 配置页，复制 MCP Token。"],
  ["qq-mail", "个人邮箱", "效率", "通过 IMAP/SMTP 读取和发送邮件", "mail", "https://mail.qq.com/", [field("email", "邮箱地址"), secret("password", "邮箱授权码"), field("imap_host", "IMAP 主机"), field("smtp_host", "SMTP 主机")], "在邮箱设置开启 IMAP/SMTP，生成专用授权码；不要填写网页登录密码。"],
  ["qq-music", "QQ 音乐", "媒体", "搜歌、排行榜与歌单", "api", "https://y.qq.com/n/ryqq_v2/qqmusic_skills", api, "登录 QQ 音乐 Skills，生成 qmk- 开头的 API Key。"],
  ["fliggy", "飞猪", "出行", "机票、酒店与景点搜索", "api", "https://flyai.open.fliggy.com/console", api, "在飞猪 AI 开放平台控制台获取 API Key。"],
  ["baidu-map", "百度地图", "出行", "地点检索、路线与天气", "api", "https://lbs.baidu.com/apiconsole/agentplan", api, "在 Agent Plan 控制台获取 sk-ap- 开头的 Token。"],
  ["ctrip-wendao", "携程问道", "出行", "酒店、机票与行程问答", "api", "http://t.ctrip.cn/28J6RhL", api, "打开携程问道申请页面，复制完整 Token 并填写到 API Key。"],
  ["meituan-travel", "美团旅游助手", "出行", "酒店、机票与行程问答", "api", "https://developer.meituan.com/zh/v2/dev/token", api, "在美团个人开发者页面获取 Token，并填写到 API Key。"],
  ["didi", "滴滴", "出行", "路线规划、价格预估与叫车", "mcp", "https://mcp.didichuxing.com", api, "登录滴滴控制台并激活个人 MCP Key。"],
  ["yuandian", "元典", "专业", "法规、案例文书与企业信息检索", "api", "https://open.chineselaw.com/profile", api, "在元典开放平台获取 sk_ 开头的 API Key。"],
  ["tencent-ardot", "腾讯设计 Ardot", "办公", "设计稿、设计系统与导出", "mcp", "https://docs.ardot.tencent.com/ardot-mcp/introduction.html", [], "打开官方授权页登录并选择允许访问的资源。"],
  ["youdao-note", "有道云笔记", "知识", "笔记创建、搜索与整理", "mcp", "https://mopen.163.com/#/dashboard", token, "登录有道 MCP 平台，在 API 管理中创建 API Key。"],
  ["notion", "Notion", "知识", "搜索、读写页面与数据库", "mcp", "https://developers.notion.com/docs/mcp", [], "打开 Notion 授权页并选择工作空间与允许访问的内容。"],
  ["dida365", "滴答清单", "效率", "任务、清单与专注记录", "mcp", "https://help.dida365.com/articles/7438132116019216384", [], "打开滴答清单授权页，确认任务读写权限。"],
  ["feishu-cli", "飞书 CLI", "办公", "文档、多维表格、日历与消息", "cli", "https://github.com/larksuite/cli", [field("app_id", "App ID"), secret("app_secret", "App Secret")], "所选设备需安装官方 lark-cli；文档搜索还需要登录飞书账号并授权。"],
  ["wecom-cli", "企业微信 CLI", "办公", "文档、日程与消息", "cli", "https://github.com/WecomTeam/wecom-cli", [field("bot_id", "Bot ID"), secret("bot_secret", "Bot Secret")], "所选设备需安装 @wecom/cli，并配置长连接智能机器人。"],
  ["weknora", "WeKnora", "知识", "私有知识库检索与文档阅读", "api", "https://github.com/Tencent/WeKnora", [field("base_url", "服务地址"), secret("api_key", "API Key", false), field("tenant_id", "Tenant ID", false)], "填写部署地址，再按部署要求填写 API Key 和 Tenant ID。"],
  ["dify", "Dify", "自托管", "连接已发布应用或工作流", "mcp", "https://docs.dify.ai/", [secret("mcp_url", "MCP Server URL")], "发布应用或工作流，在访问点启用 MCP，并复制完整 Server URL。地址含访问凭据。"],
];
export const CONNECTOR_CATALOG: readonly ConnectorDefinition[] = Object.freeze(entries.map(([id, name, category, description, adapter, guideUrl, fields, step]) => Object.freeze({
  id, name, category, description, adapter, guideUrl, fields,
  auth: (["notion", "tencent-ardot", "dida365"].includes(id) ? "oauth" : fields.length > 1 || id === "dify" ? "fields" : "token") as ConnectorDefinition["auth"],
  steps: [step],
})));
export const connectorDefinition = (id: string) => {
  const value = CONNECTOR_CATALOG.find(row => row.id === id);
  if (!value) throw new Error("Unknown connector definition");
  return value;
};
