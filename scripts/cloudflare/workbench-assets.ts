import { createHash } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { CloudflareApi } from "./cloudflare-runtime.ts";

const { lookup } = createRequire(import.meta.url)("mime-types");

export const workbenchAssetsConfig = { html_handling: "none", not_found_handling: "none", run_worker_first: true };
const IMMUTABLE_ASSET = /^\/assets\/.+-[a-zA-Z0-9_-]{6,}\.[^/]+$/u;

export async function uploadWorkbenchAssets(
  api: Pick<CloudflareApi, "accountId" | "call">,
  worker: string,
  assetsDir: string,
  log: (line: string) => void,
  retainedAssetsDirs: readonly string[] = [],
  options: { readonly allowHostless?: boolean } = {},
) {
  const assetRoot = resolve(assetsDir);
  const indexHtml = await readFile(join(assetRoot, "index.html"), "utf8");
  if (
    !indexHtml.includes('id="opencraft-deployment-config"') ||
    (!options.allowHostless && !indexHtml.includes('"url":"/apphost"'))
  )
    throw new Error("Preview index.html missing the cloud AppHost configuration");
  const manifest: Record<string, { hash: string; size: number }> = {};
  const files = new Map<string, { file: string; mime: string }>();
  for (const root of [assetRoot, ...retainedAssetsDirs.map((dir) => resolve(dir))]) {
    for await (const file of glob("**/*", { cwd: root, withFileTypes: true })) {
      if (!file.isFile() || /\.(?:map|br|gz)$/u.test(file.name)) continue;
      const full = join(file.parentPath, file.name);
      const name = full.slice(root.length);
      // Older tabs can still request lazy chunks after the active HTML changes.
      // Keep only content-addressed URLs from the explicitly retained releases.
      if (root !== assetRoot && !IMMUTABLE_ASSET.test(name)) continue;
      const content = await readFile(full);
      const hash = createHash("sha256")
        .update(content.toString("base64") + extname(name).slice(1))
        .digest("hex")
        .slice(0, 32);
      if (manifest[name] && manifest[name].hash !== hash)
        throw new Error("Conflicting immutable Workbench asset " + name);
      manifest[name] = { hash, size: content.length };
      files.set(hash, { file: full, mime: lookup(full) || "application/octet-stream" });
    }
  }
  if (!manifest["/index.html"]) throw new Error("Web preview build missing index.html");
  const session = await api.call<{ jwt: string; buckets: string[][] }>(
    "POST",
    `/workers/scripts/${worker}/assets-upload-session`,
    { manifest },
  );
  log(
    `Workbench assets prepared for ${worker}. ${Object.keys(manifest).length} files, ${session.buckets.length} upload buckets`,
  );
  const uploader = new CloudflareApi(api.accountId, session.jwt);
  let completion = session.buckets.length === 0 ? session.jwt : undefined;
  for (const [index, bucket] of session.buckets.entries()) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = files.get(hash);
      if (!file) throw new Error("Unknown asset upload hash");
      const contents = (await readFile(file.file)).toString("base64");
      form.set(hash, new Blob([contents], { type: file.mime }), hash);
    }
    const result = await uploader.call<{ jwt?: string }>("POST", "/workers/assets/upload?base64=true", form);
    completion = result?.jwt ?? completion;
    log(`Asset upload bucket ${index + 1} complete`);
  }
  if (!completion) throw new Error("Cloudflare did not confirm Workbench assets");
  return completion;
}
