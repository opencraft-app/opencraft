import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const AUTH_ADMIN_API_URL = process.env.AUTH_ADMIN_API_URL;
const AUTH_ADMIN_TOKEN = process.env.AUTH_ADMIN_TOKEN;

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  return proxyModuleAdminRequest(req, params, {
    module: "auth",
    upstreamBaseURL: AUTH_ADMIN_API_URL,
    upstreamToken: AUTH_ADMIN_TOKEN,
    serviceName: "Auth admin",
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(req, await params);
}
