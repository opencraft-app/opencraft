const forbiddenHeaders = new Set(["authorization", "cookie", "host", "connection", "proxy-authorization"]);
export interface LoopbackRequest { url: string; method?: string; headers?: Record<string, string>; bodyBase64?: string }
export interface LoopbackResponse { status: number; statusText: string; headers: Record<string, string>; bodyBase64: string }
export async function requestLoopback(input: LoopbackRequest, signal: AbortSignal, blockedPorts: readonly number[]): Promise<LoopbackResponse> {
  const method = (input.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) throw new Error("Unsupported loopback HTTP method");
  const body = input.bodyBase64 ? Buffer.from(input.bodyBase64, "base64") : undefined;
  if (body && body.length > 4 * 1024 * 1024) throw new Error("Loopback request body too large");
  let url = new URL(input.url);
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([key]) => !forbiddenHeaders.has(key.toLowerCase())));
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Only credential-free loopback HTTP targets are allowed");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (blockedPorts.includes(port)) throw new Error("OpenCraft control endpoints cannot be proxied");
    const response = await fetch(url, { method, headers, body: ["GET", "HEAD"].includes(method) ? undefined : body,
      redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const location = response.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel();
      if (method !== "GET" && method !== "HEAD") throw new Error("Mutating loopback requests cannot redirect");
      url = new URL(location, url);
      continue;
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("Loopback response too large"); }
      chunks.push(chunk.value);
    }
    const returnedHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) returnedHeaders[key] = value;
    });
    return { status: response.status, statusText: response.statusText, headers: returnedHeaders, bodyBase64: Buffer.concat(chunks).toString("base64") };
  }
  throw new Error("Too many loopback redirects");
}
