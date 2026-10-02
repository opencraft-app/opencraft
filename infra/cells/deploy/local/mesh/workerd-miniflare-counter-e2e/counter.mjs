import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const [modulePath, endpoint, worker, objectName, expectedText, verifyRejectedText] =
  process.argv.slice(2);
const { Miniflare } = await import(pathToFileURL(modulePath));
const expected = Number(expectedText);
const verifyRejected = verifyRejectedText === "true";
const script = `
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.generation = env.RIVET_ACTOR.generation;
	}

  async fetch(request) {
    const current = (await this.ctx.storage.get("value")) ?? 0;
    if (new URL(request.url).pathname === "/value") return Response.json({ value: current });
    const value = current + 1;
    await this.ctx.storage.put("value", value);
		return Response.json({
			value,
			origin: new URL(request.url).origin,
			generation: this.generation,
		});
  }
}
export default { fetch() { return new Response("ready"); } };
`;
const options = (source) => ({
  endpoint,
  name: worker,
  script: source,
  compatibilityDate: "2026-08-14",
  durableObjects: { COUNTER: "Counter" },
});
const mf = new Miniflare(options(script));

try {
  const namespace = await mf.getDurableObjectNamespace("COUNTER");
  const stub = namespace.getByName(objectName);
  const response = await stub.fetch("https://counter.example/increment", { method: "POST" });
  const body = await response.json();
  if (!response.ok || body.value !== expected || body.origin !== "https://counter.example") {
    throw new Error(
      `expected Counter ${expected} at the original origin, received ${response.status} ${JSON.stringify(body)}`,
    );
  }
  let rejectedUpdatePreservedDeployment = false;
  if (verifyRejected) {
    const before = await activeVersion();
    try {
      await mf.setOptions({ ...options(script), durableObjects: { COUNTER: "MissingCounter" } });
      throw new Error("same code with an invalid Durable Object config became active");
    } catch (error) {
      if (String(error).includes("became active")) throw error;
    }
    const after = await activeVersion();
    if (after !== before) {
      throw new Error(`rejected update changed active version from ${before} to ${after}`);
    }
    await mf.setOptions(options(script));
    const recovered = await mf.getDurableObjectNamespace("COUNTER");
    const current = await (
      await recovered.getByName(objectName).fetch("https://counter.example/value")
    ).json();
    if (current.value !== expected) {
      throw new Error(`rejected update changed Counter state: ${JSON.stringify(current)}`);
    }
    rejectedUpdatePreservedDeployment = true;
  }
  console.log(
    JSON.stringify({
      value: body.value,
      origin: body.origin,
      object_id: stub.id.toString(),
      actor_name: `mf-${digest([worker, "Counter"]).slice(0, 24)}`,
			generation: body.generation,
      rejected_update_preserved_deployment: rejectedUpdatePreservedDeployment,
    }),
  );
} finally {
  await mf.dispose();
}

async function activeVersion() {
  const url = new URL(
    `workers/${encodeURIComponent(worker)}`,
    endpoint.endsWith("/") ? endpoint : `${endpoint}/`,
  );
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}: ${await response.text()}`);
  const record = await response.json();
  const versions = record.deployment?.versions;
  if (versions?.length !== 1 || versions[0].percentage !== 100) {
    throw new Error(`Worker has no singular active version: ${JSON.stringify(record.deployment)}`);
  }
  return versions[0].version_id;
}

function digest(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}
