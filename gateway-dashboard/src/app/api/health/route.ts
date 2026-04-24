import { NextResponse } from "next/server";

const GATEWAY_API_URL = process.env.GATEWAY_API_URL ?? "http://localhost:18080";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const response = await fetch(`${GATEWAY_API_URL}/health`, {
      cache: "no-store",
    });
    if (response.ok) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false }, { status: response.status });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
