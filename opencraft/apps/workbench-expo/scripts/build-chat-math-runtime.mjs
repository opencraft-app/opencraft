import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(appRoot, "src/runtime/chat-math-webview-entry.ts")],
  bundle: true,
  write: false,
  outdir: path.join(appRoot, ".cache", "chat-math"),
  format: "iife",
  platform: "browser",
  target: ["safari16", "chrome100"],
  minify: true,
  logLevel: "silent",
  loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
});
const script = result.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const css = result.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !css) throw new Error("Could not build the embedded math renderer");
const safeScript = script.replace(/<\/script/giu, "<\\/script");
const safeCss = css.replace(/<\/style/giu, "<\\/style");
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src data:; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><style>${safeCss}html,body{margin:0;padding:0;background:transparent;color:#1b1624;overflow-x:auto;overflow-y:hidden}html[data-theme=dark] body{color:#f8f7fb}#math{display:inline-block;padding:4px 2px;min-width:1px;white-space:nowrap}.katex-display{margin:0}</style></head><body><div id="math"></div><script>${safeScript}</script></body></html>`;
const output = path.join(appRoot, "assets/mobile-chat-math.html");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, html);
console.log(`Embedded math renderer: ${Buffer.byteLength(html)} bytes`);
