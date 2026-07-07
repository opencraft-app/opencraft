import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const TICKET_API_URL = process.env.TICKET_API_URL;
// 反馈后台接口由 ticket 的 supportAgentMiddleware 校验 X-User-Id（白名单
// SUPPORT_AGENT_IDS）。dashboard 自身仅 admin 登录、不持有个人 lightclaw
// 用户 ID，因此由 BFF 注入一个配置在白名单内的运营账号 ID 作为代理身份。
const SUPPORT_FEEDBACK_AGENT_ID = process.env.SUPPORT_FEEDBACK_AGENT_ID ?? "";

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  return proxyModuleAdminRequest(req, params, {
    module: "support-feedback",
    upstreamBaseURL: TICKET_API_URL,
    serviceName: "Support Feedback",
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
