import { attachAdminSessionCookie, createClearedAdminSessionCookie } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

export async function POST() {
  return attachAdminSessionCookie(
    new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    }),
    createClearedAdminSessionCookie(),
    true
  );
}
