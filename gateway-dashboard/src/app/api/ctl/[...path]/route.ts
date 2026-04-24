import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const CTL_API_URL = process.env.CTL_API_URL;
const GATEWAY_API_URL = process.env.GATEWAY_API_URL;

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  return proxyModuleAdminRequest(req, params, {
    module: "ctl",
    upstreamBaseURL: CTL_API_URL,
    serviceName: "CTL",
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(req, await params);
}
