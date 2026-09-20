import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const SHADOW_API_URL = process.env.SHADOW_API_URL;
const SHADOW_INTERNAL_TOKEN = process.env.SHADOW_INTERNAL_TOKEN;
const GATEWAY_API_URL = process.env.GATEWAY_API_URL;

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  if (!SHADOW_INTERNAL_TOKEN) {
    return Response.json(
      { error: "Shadow internal token is not configured" },
      { status: 500 }
    );
  }

  return proxyModuleAdminRequest(req, params, {
    module: "shadow",
    upstreamBaseURL: SHADOW_API_URL,
    upstreamToken: SHADOW_INTERNAL_TOKEN,
    serviceName: "Shadow",
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
