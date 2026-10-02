import { pathToFileURL } from "node:url";

const [modulePath, endpoint, worker, objectName] = process.argv.slice(2);
const { Miniflare } = await import(pathToFileURL(modulePath));
const script = `
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async fetch() { return new Response("unexpected"); }
}
export default { fetch() { return new Response("ready"); } };
`;
const mf = new Miniflare({
  endpoint,
  name: worker,
  script,
  compatibilityDate: "2026-08-14",
  durableObjects: { COUNTER: "Counter" },
});

try {
  const namespace = await mf.getDurableObjectNamespace("COUNTER");
  const stub = namespace.getByName(objectName);
  await stub.delete();
  await stub.delete();
  try {
    await stub.fetch("https://counter.example/value");
    throw new Error("deleted Durable Object was recreated");
  } catch (error) {
    if (String(error).includes("was recreated")) throw error;
    if (error?.code !== "object_deleted" || error?.status !== 410 || error?.retryable !== false) {
      throw new Error(`unexpected post-delete failure: ${String(error)}`);
    }
  }
  console.log(JSON.stringify({ object_id: stub.id.toString(), object_deleted: true }));
} finally {
  await mf.dispose();
}
