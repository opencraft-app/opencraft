// Fixture parts shared by the workerd worker and the Node side of the HTTP
// exchange scenarios (no runtime imports).

/** Test authority: trusts `x-fixture-actor` / `x-fixture-admin`; both runtimes give the same answers. */
export function fixtureAuthority(origin: () => string) {
  return (request: { readonly headers: Readonly<Record<string, string | string[] | undefined>> }) => {
    const actorId = request.headers["x-fixture-actor"];
    if (typeof actorId !== "string") return null;
    return { actorId, administrator: request.headers["x-fixture-admin"] === "1", origin: origin() };
  };
}

/** Three chunks produced over time; the client must see them concatenated. */
export async function streamedHandler(request: { readonly method: string }) {
  if (request.method !== "GET") return null;
  const encoder = new TextEncoder();
  const parts = ["alpha ", "beta ", "gamma"];
  let index = 0;
  return {
    status: 200,
    headers: [["content-type", "text/plain; charset=utf-8"]] as [string, string][],
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index === parts.length) return controller.close();
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.enqueue(encoder.encode(parts[index++]!));
      },
    }),
  };
}
