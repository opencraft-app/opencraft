import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-session-constants";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow login page
  if (pathname === "/login" || pathname === "/admin/gateway/login") {
    return NextResponse.next();
  }

  // Allow static files and Next.js internals
  if (
    pathname === "/admin/gateway/api" ||
    pathname.startsWith("/admin/gateway/api/") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/admin/gateway/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // Check for token in cookies or headers
  const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  // If no token, redirect to login
  if (!token) {
    return NextResponse.redirect(new URL("/admin/gateway/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon).*)"],
};
