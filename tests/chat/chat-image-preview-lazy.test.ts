import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("image preview entry defers its presentation and embedded styles to activation", async () => {
  const result = await build({ absWorkingDir: root, entryPoints: ["packages/chat-render-web/src/image-preview.tsx", "packages/chat-render-web/src/zoomable-image.tsx"],
    outdir: ".local/image-preview-boundary", bundle: true, splitting: true, format: "esm", platform: "browser",
    jsx: "automatic", write: false, metafile: true, external: ["react", "@opencraft/*"],
    plugins: [{ name: "inline-style-boundary", setup(build) {
      build.onResolve({ filter: /\.scss\?inline$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, "")), namespace: "inline-style" }));
      build.onLoad({ filter: /.*/, namespace: "inline-style" }, async args => ({ contents: "export default " + JSON.stringify(await readFile(args.path, "utf8")), loader: "js" }));
      build.onLoad({ filter: /\.scss$/ }, () => ({ contents: "", loader: "css" }));
    } }],
  });
  const outputs = result.metafile.outputs;
  const entry = Object.keys(outputs).find(file => outputs[file]!.entryPoint?.endsWith("/image-preview.tsx"));
  assert.ok(entry);
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const edge of outputs[file]!.imports) {
      if (edge.external || edge.kind === "dynamic-import") continue;
      const next = outputs[edge.path] ? edge.path : path.join(path.dirname(file), edge.path).split(path.sep).join("/");
      if (outputs[next]) visit(next);
    }
  };
  visit(entry);
  const zoomEntry = Object.keys(outputs).find(file => outputs[file]!.entryPoint?.endsWith("/zoomable-image.tsx"));
  assert.ok(zoomEntry);
  visit(zoomEntry);
  const initial = [...visited].flatMap(file => Object.keys(outputs[file]!.inputs));
  assert.equal(initial.some(file => /image-preview-view\.tsx|zoomable-image-view\.tsx|image-preview\.scss|zoomable-image\.scss/.test(file)), false);
  assert.ok(Object.entries(outputs).some(([file, output]) => !visited.has(file)
    && Object.keys(output.inputs).some(input => input.endsWith("/image-preview-view.tsx"))));
  assert.ok(Object.entries(outputs).some(([file, output]) => !visited.has(file)
    && Object.keys(output.inputs).some(input => input.includes("inline-style:") && input.endsWith("/image-preview.scss"))));
});
