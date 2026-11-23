// Access guard bundled around every prototype worker the real-Cloudflare
// rehearsal deploys (scripts/cloudflare/rehearsal.ts). Runs in workerd.
//
// - Every request must carry the per-run random key (secret binding
//   REHEARSAL_KEY) in REHEARSAL_KEY_HEADER; anything else gets a plain 404, so
//   the public workers.dev URL exposes nothing while the rehearsal runs.
// - REHEARSAL_URL_HEADER restores the scenario's virtual URL (host and path)
//   before the prototype sees the request: Miniflare dispatches virtual hosts
//   such as `inst-a.relay.test` directly, a workers.dev deployment cannot.
// - GET REHEARSAL_HEALTH_PATH answers the deployed generation, so the driver
//   can wait until a new version serves; POST REHEARSAL_PURGE_PATH empties the
//   R2 bindings named in REHEARSAL_R2 before the bucket is deleted.
export const REHEARSAL_KEY_HEADER = "x-opencraft-rehearsal-key";
export const REHEARSAL_URL_HEADER = "x-opencraft-rehearsal-url";
export const REHEARSAL_HEALTH_PATH = "/__opencraft_rehearsal/health";
export const REHEARSAL_PURGE_PATH = "/__opencraft_rehearsal/purge";

interface R2ListResult {
  objects: { key: string }[];
  truncated: boolean;
  cursor?: string;
}
interface PurgeableBucket {
  list(options: { cursor?: string; limit: number }): Promise<R2ListResult>;
  delete(keys: string[]): Promise<void>;
}
interface GuardEnv {
  readonly REHEARSAL_KEY?: string;
  readonly REHEARSAL_GENERATION?: string;
  readonly REHEARSAL_R2?: readonly string[];
  readonly [binding: string]: unknown;
}
interface Worker {
  fetch(request: Request, env: never, context: never): Promise<Response> | Response;
}

const encoder = new TextEncoder();
async function sameKey(presented: string, expected: string): Promise<boolean> {
  // Hash first so the comparison is constant time and length independent.
  const [left, right] = await Promise.all(
    [presented, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  return (crypto.subtle as unknown as { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(
    left!,
    right!,
  );
}
const notFound = () => new Response("Not found", { status: 404 });

export function rehearsalGuard(worker: Worker): Worker {
  return {
    async fetch(request: Request, env: never, context: never): Promise<Response> {
      const guardEnv = env as GuardEnv;
      const expected = guardEnv.REHEARSAL_KEY;
      if (
        !expected ||
        expected.length < 32 ||
        !(await sameKey(request.headers.get(REHEARSAL_KEY_HEADER) ?? "", expected))
      )
        return notFound();
      const url = new URL(request.url);
      if (url.pathname === REHEARSAL_HEALTH_PATH && request.method === "GET")
        return Response.json({ generation: guardEnv.REHEARSAL_GENERATION ?? null });
      if (url.pathname === REHEARSAL_PURGE_PATH && request.method === "POST") {
        let deleted = 0;
        for (const name of guardEnv.REHEARSAL_R2 ?? []) {
          const bucket = guardEnv[name] as PurgeableBucket;
          for (;;) {
            const page = await bucket.list({ limit: 1000 });
            if (!page.objects.length) break;
            await bucket.delete(page.objects.map((object) => object.key));
            deleted += page.objects.length;
          }
        }
        return Response.json({ deleted });
      }
      const headers = new Headers(request.headers);
      const target = headers.get(REHEARSAL_URL_HEADER);
      headers.delete(REHEARSAL_KEY_HEADER);
      headers.delete(REHEARSAL_URL_HEADER);
      const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
      return worker.fetch(
        new Request(target ?? request.url, { method: request.method, headers, body, redirect: "manual" }),
        env,
        context,
      );
    },
  };
}
