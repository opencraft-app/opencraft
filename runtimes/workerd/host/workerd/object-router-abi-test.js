const OBJECT_ROUTER_TOKEN = "worker-loader-abi-object-router-token";
const ROUTER_TOKEN_HEADER = "X-Rivet-Object-Router-Token";
const ORIGINAL_URL_HEADER = "X-Rivet-Original-URL";

export default {
	async fetch(request) {
		if (request.headers.get(ROUTER_TOKEN_HEADER) !== OBJECT_ROUTER_TOKEN) {
			return new Response("not found", { status: 404 });
		}
		const match = /^\/internal\/v1\/workers\/([a-z][a-z0-9-]{0,62})\/objects\/([A-Za-z_$][A-Za-z0-9_$]{0,127})\/([0-9a-f]{64})\/fetch$/.exec(
			new URL(request.url).pathname,
		);
		if (match === null) return new Response("not found", { status: 404 });
		return Response.json({
			body: await request.text(),
			className: decodeURIComponent(match[2]),
			method: request.method,
			objectId: match[3],
			originalUrl: request.headers.get(ORIGINAL_URL_HEADER),
			worker: decodeURIComponent(match[1]),
		});
	},
};
