// The counter is deliberately isolate-local, not durable state. A reset proves
// native named-cache retirement, not just removal from the root JS table.
const userCode = `
let counter = 0;
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/throw") throw new Error("fixture user failure");
    const count = ++counter;
    if (new URL(request.url).pathname === "/stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      ctx.waitUntil((async () => {
        await writer.write(new TextEncoder().encode("begin:"));
        await writer.write(new Uint8Array(1024 * 1024).fill(120));
        await writer.write(new TextEncoder().encode(":end"));
        await writer.close();
      })());
      return new Response(readable, { headers: { "X-Counter": String(count) } });
    }
    return Response.json({
      count, url: request.url, body: await request.text(),
      privateHeaders: [...request.headers.keys()].filter(n => n.startsWith("x-rivet-")),
    });
  }
};
`;

export default {
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path.includes("/code-unavailable/")) return new Response(null, { status: 503 });
		let source = userCode;
		if (path.includes("/bad-syntax/")) source = "export default {";
		if (path.includes("/missing-default/")) source = "export function named() {}";
		return Response.json({
			compatibilityDate: "2026-08-07",
			mainModule: "worker.js",
			modules: { "worker.js": source },
		});
	},
};
