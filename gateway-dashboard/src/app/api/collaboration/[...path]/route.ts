import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const COLLABORATION_API_URL = process.env.COLLABORATION_API_URL;
const COLLABORATION_ADMIN_TOKEN = process.env.COLLABORATION_ADMIN_TOKEN;
const GATEWAY_API_URL = process.env.GATEWAY_API_URL;

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  if (!COLLABORATION_ADMIN_TOKEN) {
    return Response.json(
      { error: "Collaboration admin token is not configured" },
      { status: 500 }
    );
  }

  return proxyModuleAdminRequest(req, params, {
    module: "collaboration",
    upstreamBaseURL: COLLABORATION_API_URL,
    upstreamToken: COLLABORATION_ADMIN_TOKEN,
    serviceName: "Collaboration IM admin",
    requireAdminTokenValidation: true,
    validationBaseURL: GATEWAY_API_URL,
    forwardBrowserToken: false,
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
