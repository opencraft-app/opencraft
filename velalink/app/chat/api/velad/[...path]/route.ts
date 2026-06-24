const DEFAULT_VELAD_BASE_URL = "http://127.0.0.1:3857";

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyVelad(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyVelad(request, context);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyVelad(request, context);
}

async function proxyVelad(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const params = await context.params;
  const upstreamBase = process.env.VELAD_BASE_URL ?? DEFAULT_VELAD_BASE_URL;
  const incomingUrl = new URL(request.url);
  const upstream = new URL(`/${params.path.join("/")}`, upstreamBase);
  upstream.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");

  let response: Response;
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "velad_unavailable",
          message: `Could not connect to local velad at ${upstreamBase}. Start velad or set VELAD_BASE_URL.`,
        },
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
