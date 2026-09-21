import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const CREDIT_API_URL = process.env.CREDIT_API_URL;
const CREDIT_INTERNAL_TOKEN = process.env.CREDIT_INTERNAL_TOKEN;
const GATEWAY_API_URL = process.env.GATEWAY_API_URL;

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  if (!CREDIT_INTERNAL_TOKEN) {
    return Response.json(
      { error: "Credit internal token is not configured" },
      { status: 500 }
    );
  }

  return proxyModuleAdminRequest(req, params, {
    module: "credit",
    upstreamBaseURL: CREDIT_API_URL,
    upstreamToken: CREDIT_INTERNAL_TOKEN,
    serviceName: "Credit",
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
