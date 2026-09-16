import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThreadCatalog } from "../apps/local-agent-host/src/thread-catalog.js";

test("OpenCraft owns durable names/archive/provenance and never persists temporary threads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-thread-catalog-"));
  const path = join(directory, "threads.sqlite");
  let catalog = new ThreadCatalog(path);
  try {
    catalog.upsert({ id: "durable", name: "Generated", createdAt: 1, turns: [] });
    catalog.rename("durable", "User name"); catalog.archive("durable", true);
    catalog.upsert({ id: "durable", name: "New generated title", createdAt: 2, turns: [] });
    catalog.upsert({ id: "temporary", name: "Temporary", turns: [] }, { ephemeral: true, forkedFromId: "durable" });
    assert.equal(catalog.list(false).length, 0);
    assert.equal(catalog.list(true)[0]!.name, "User name");
    assert.equal(catalog.get("temporary")!.forkedFromId, "durable");
    catalog.close(); catalog = new ThreadCatalog(path);
    assert.equal(catalog.get("temporary"), null);
    assert.equal(catalog.get("durable")!.name, "User name");
    assert.equal(catalog.get("durable")!.createdAt, 1);
    catalog.archive("durable", false); assert.equal(catalog.list(false).length, 1);
  } finally { catalog.close(); await rm(directory, { recursive: true, force: true }); }
});
