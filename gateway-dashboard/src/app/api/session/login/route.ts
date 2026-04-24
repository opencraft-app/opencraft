import { NextRequest } from "next/server";
import { attachAdminSessionCookie, createAdminSessionCookie, createClearedAdminSessionCookie } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

const GATEWAY_API_URL = process.env.GATEWAY_API_URL;

export async function POST(req: NextRequest) {
  if (!GATEWAY_API_URL) {
    return Response.json(
      { error: "GATEWAY_API_URL is not configured" },
      { status: 500 }
    );
  }

  let token = "";
  try {
    const body = await req.json() as { token?: string };
    token = body.token?.trim() ?? "";
  } catch {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }

  if (!token) {
    return Response.json({ error: "missing admin token" }, { status: 400 });
  }

  try {
    const response = await fetch(new URL("/api/admin/stats", GATEWAY_API_URL), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    if (response.ok) {
      return attachAdminSessionCookie(
        new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        }),
        createAdminSessionCookie(token)
      );
    }

    if (response.status === 401 || response.status === 403) {
      return attachAdminSessionCookie(
        new Response(
          await response.text() || JSON.stringify({ error: "unauthorized" }),
          {
            status: response.status,
            headers: {
              "Content-Type": response.headers.get("Content-Type") || "application/json",
              "Cache-Control": "no-store",
            },
          }
        ),
        createClearedAdminSessionCookie(),
        true
      );
    }

    return Response.json({ error: "Gateway admin auth check failed" }, { status: 502 });
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_SESSION_SECRET not configured") {
      return Response.json({ error: error.message }, { status: 500 });
    }
    console.error("gateway-dashboard session login validation error:", error);
    return Response.json({ error: "Gateway backend is unreachable" }, { status: 502 });
  }
}
