import { NextRequest } from "next/server";
import { proxyModuleAdminRequest } from "../../admin-proxy-route-helpers";

export const dynamic = "force-dynamic";

const SUBSCRIPTION_ADMIN_API_URL = process.env.SUBSCRIPTION_ADMIN_API_URL;
const SUBSCRIPTION_ADMIN_TOKEN = process.env.SUBSCRIPTION_ADMIN_TOKEN;

function proxyRequest(req: NextRequest, params: { path: string[] }) {
  return proxyModuleAdminRequest(req, params, {
    module: "subscription",
    upstreamBaseURL: SUBSCRIPTION_ADMIN_API_URL,
    upstreamToken: SUBSCRIPTION_ADMIN_TOKEN,
    serviceName: "Subscription admin",
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
