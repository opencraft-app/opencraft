import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const MODULE = "support-feedback" as const;
const SERVICE_NAME = "Support Feedback" as const;

const TICKET_API_URL = process.env.TICKET_API_URL;
// 反馈后台接口由 ticket 的 supportAgentMiddleware 校验 X-User-Id（白名单
// SUPPORT_AGENT_IDS）。dashboard 自身仅 admin 登录、不持有个人 lightclaw
// 用户 ID，因此由 BFF 注入一个配置在白名单内的运营账号 ID 作为代理身份。
// SUPPORT_FEEDBACK_AGENT_ID 仅支持非空字符串；未配置时不注入 X-User-Id。
const SUPPORT_FEEDBACK_AGENT_ID = process.env.SUPPORT_FEEDBACK_AGENT_ID ?? "";

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  return proxyModuleAdminRequest(req, params, {
    module: MODULE,
    upstreamBaseURL: TICKET_API_URL,
    serviceName: SERVICE_NAME,
    extraHeaders: SUPPORT_FEEDBACK_AGENT_ID
      ? { "X-User-Id": SUPPORT_FEEDBACK_AGENT_ID }
      : undefined,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(req, await params);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(req, await params);
}
