import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(appRoot, "src/runtime/chat-mermaid-webview-entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["safari16", "chrome100"],
  minify: true,
  logLevel: "silent",
  banner: {
    js: 'if(typeof globalThis.structuredClone!=="function"){globalThis.structuredClone=v=>v===undefined?v:JSON.parse(JSON.stringify(v));}',
  },
});
const script = result.outputFiles[0]?.text;
if (!script) throw new Error("Could not build the embedded diagram renderer");
const safeScript = script.replace(/<\/script/giu, "<\\/script");
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}#diagram{min-height:1px}#diagram svg{display:block}</style></head><body><div id="diagram"></div><script>${safeScript}</script></body></html>`;
const output = path.join(appRoot, "assets/mobile-chat-mermaid.html");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, html);
console.log(`Embedded diagram renderer: ${Buffer.byteLength(html)} bytes`);
