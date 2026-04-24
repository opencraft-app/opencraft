import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const GATEWAY_API_URL = process.env.GATEWAY_API_URL;

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  return proxyModuleAdminRequest(req, params, {
    module: "ai-gateway",
    upstreamBaseURL: GATEWAY_API_URL,
    serviceName: "AI Gateway",
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

export async function PUT(
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
