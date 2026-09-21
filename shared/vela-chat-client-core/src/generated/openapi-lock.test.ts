import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  GENERATED_OPENAPI_SHA256,
  SOURCE_OPENAPI_SHA256,
} from "./openapi-lock.js";

test("generated OpenAPI types match the frozen source and output hashes", async () => {
  const sourcePath = new URL(
    "../../contracts/platform-v1.openapi.yaml",
    import.meta.url,
  );
  const generatedPath = new URL("./openapi.ts", import.meta.url);

  assert.equal(await sha256(sourcePath), SOURCE_OPENAPI_SHA256);
  assert.equal(await sha256(generatedPath), GENERATED_OPENAPI_SHA256);
});

async function sha256(url: URL): Promise<string> {
  const content = await readFile(url);
  return createHash("sha256").update(content).digest("hex");
}
