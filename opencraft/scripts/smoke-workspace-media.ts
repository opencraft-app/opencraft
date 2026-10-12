import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, createServer, type UserConfig } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
function simplePdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>", "<< /Length 41 >>\nstream\nBT /F1 22 Tf 30 330 Td (First page) Tj ET\nendstream", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>", "<< /Length 42 >>\nstream\nBT /F1 22 Tf 30 330 Td (Second page) Tj ET\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const pdf = process.env.OPENCRAFT_PDF_FIXTURE ? await readFile(process.env.OPENCRAFT_PDF_FIXTURE) : simplePdf();
const reportHtml = Buffer.from('<!doctype html><html><head><meta http-equiv="refresh" content="0;url=/fixture/navigated.html"><style>h1{color:rgb(0,80,160)}</style></head><body><h1>Visual report</h1><a href="/fixture/navigated.html">Follow report</a><svg><a><set attributeName="href" to="/fixture/navigated.html" begin="0s" fill="freeze"/><text x="0" y="20">Animated report link</text></a></svg><img src="/fixture/external.png"><script>document.body.dataset.scriptRan="yes";window.parent.htmlInjected=true</script></body></html>');
let video: Buffer = Buffer.alloc(0);
const wave = Buffer.alloc(44 + 16000); wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(16000, 40);
const aliasPlugin: NonNullable<UserConfig["plugins"]>[number] = { name: "workspace-media-runtime", enforce: "pre", resolveId(source, importer) {
  if (source.endsWith("/appserver-runtime-context") && importer?.includes("/panels/")) return resolve("tests/fixtures/workspace-media-runtime.ts");
  return null;
} };
const fixtureBuild = process.env.OPENCRAFT_MEDIA_BUILD_DIR;
let html = '<!doctype html><html><body><div id="host"></div><script type="module" src="/tests/fixtures/workspace-media-preview.tsx"></script></body></html>';
if (fixtureBuild) {
  await build({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, plugins: [aliasPlugin], build: { target: "es2022", outDir: fixtureBuild, manifest: true, rolldownOptions: { input: resolve("tests/fixtures/workspace-media-preview.tsx") } } });
  const manifest = JSON.parse(await readFile(resolve(fixtureBuild, ".vite/manifest.json"), "utf8"));
  const entry = manifest["tests/fixtures/workspace-media-preview.tsx"];
  html = `<!doctype html><html><head>${(entry.css ?? []).map((css: string) => `<link rel="stylesheet" href="/${css}">`).join("")}</head><body><div id="host"></div><script type="module" src="/${entry.file}"></script></body></html>`;
}
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"], alias: [{ find: resolve("apps/workbench-web/src/runtime/appserver-runtime-context.tsx"), replacement: resolve("tests/fixtures/workspace-media-runtime.ts") }] },
  cacheDir: "node_modules/.vite-workspace-media-smoke", server: { host: "127.0.0.1", port: 0 },
  plugins: [aliasPlugin, { name: "workspace-media-smoke", configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url === "/") { response.setHeader("content-type", "text/html"); response.end(html); return; }
    if (fixtureBuild && request.url?.startsWith("/assets/") && !request.url.includes("..")) {
      response.setHeader("content-type", /\.m?js$/u.test(request.url) ? "application/javascript" : request.url.endsWith(".css") ? "text/css" : request.url.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
      void readFile(resolve(fixtureBuild, request.url.slice(1))).then(data => response.end(data), () => { response.statusCode = 404; response.end(); }); return;
    }
    const files: Record<string, Buffer> = { "/fixture/report.pdf": pdf, "/fixture/small.pdf": simplePdf(), "/fixture/broken.pdf": Buffer.from("invalid pdf"), "/fixture/voice.wav": wave, "/fixture/clip.webm": video, "/fixture/unknown.bin": Buffer.from([0, 255, 1]), "/fixture/report.html": reportHtml, "/fixture/navigated.html": Buffer.from('<!doctype html><h1>Navigated outside preview</h1><img src="/fixture/navigated.png">'), "/fixture/navigated.png": Buffer.from([137, 80, 78, 71]) };
    const file = files[request.url ?? ""]; if (file === undefined) { next(); return; }
    response.setHeader("content-type", request.url === "/fixture/navigated.html" ? "text/html" : request.url === "/fixture/navigated.png" ? "image/png" : "application/octet-stream"); response.end(file);
  }); } }],
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const externalHtmlRequests: string[] = []; page.on("request", request => { if (/\/fixture\/(external|navigated)(\.html|\.png)$/u.test(request.url())) externalHtmlRequests.push(request.url()); });
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  const open = async (name: string) => { await page.getByRole("link", { name: `/fixture/${name}`, exact: true }).click(); };
  await page.getByRole("link", { name: "/fixture/report.pdf", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => (window as unknown as { fixtureReads(): string[] }).fixtureReads()), [], "MEDIA rendering must not eagerly read a file");
  await open("report.pdf");
  await page.locator('[data-pdf-ready="true"]').waitFor({ timeout: 60000 });
  assert.equal(await page.locator(".workspace-pdf-preview__page canvas").count(), 1);
  const pixels = await page.locator(".workspace-pdf-preview__page canvas").evaluate(canvas => { const c = canvas as HTMLCanvasElement; const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240) ink++; return ink; });
  assert.ok(pixels > 100, "PDF must paint content, not an empty canvas");
  const initialWidth = await page.locator(".workspace-pdf-preview__page").evaluate(node => node.clientWidth);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.waitForFunction(initial => (document.querySelector(".workspace-pdf-preview__page")?.clientWidth ?? 0) > initial && document.querySelector('[data-pdf-ready="true"]'), initialWidth);
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.screenshot({ path: process.env.OPENCRAFT_MEDIA_SCREENSHOT ?? "/tmp/opencraft-pdf-preview.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-pdf-ready="true"]').waitFor();
  await page.waitForFunction(() => (document.querySelector(".workspace-pdf-preview__page")?.clientWidth ?? 9999) < 390);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "phone must not overflow the viewport");
  const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "Download file", exact: true }).click(); const download = await downloaded; assert.equal(download.suggestedFilename(), "report.pdf"); assert.deepEqual(await readFile((await download.path())!), pdf, "download preserves original PDF bytes");
  await open("small.pdf"); await page.locator('[data-pdf-ready="true"]').waitFor();
  await page.getByRole("button", { name: "Next page", exact: true }).click(); await page.getByText("2 / 2", { exact: true }).waitFor(); await page.locator('[data-pdf-ready="true"]').waitFor();
  assert.equal(await page.locator(".workspace-pdf-preview__page canvas").count(), 1, "render only the selected page");
  await open("broken.pdf"); await page.getByText("This PDF could not be displayed. Download it to open in another reader.", { exact: true }).waitFor();
  await open("voice.wav"); await page.locator("audio").waitFor(); await page.waitForFunction(() => (document.querySelector("audio")?.readyState ?? 0) >= 1);
  video = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d")!; context.fillStyle = "red"; context.fillRect(0, 0, 32, 32);
    const stream = canvas.captureStream(10); const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    return new Promise<number[]>(resolve => {
      const chunks: Blob[] = []; recorder.ondataavailable = event => chunks.push(event.data);
      recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); void new Blob(chunks).arrayBuffer().then(data => resolve([...new Uint8Array(data)])); };
      recorder.start(); setTimeout(() => recorder.stop(), 300);
    });
  }));
  await open("clip.webm"); await page.locator("video").waitFor(); await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 1);
  await open("unknown.bin"); await page.getByText("Preview unavailable. Download this file to open it.", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1100, height: 800 });
  await open("report.html");
  const htmlFrame = page.frameLocator("iframe.workspace-file-html");
  await htmlFrame.getByRole("heading", { name: "Visual report" }).waitFor();
  assert.equal(await htmlFrame.getByRole("heading", { name: "Visual report" }).evaluate(node => getComputedStyle(node).color), "rgb(0, 80, 160)");
  await htmlFrame.locator("img").evaluate(image => (image as HTMLImageElement).decode().catch(() => undefined));
  assert.deepEqual(externalHtmlRequests, [], "HTML preview must block external subresources");
  assert.equal(await htmlFrame.locator("body").getAttribute("data-script-ran"), null, "HTML scripts must not run in the preview frame");
  assert.equal(await page.evaluate(() => (window as unknown as { htmlInjected?: boolean }).htmlInjected), undefined, "HTML scripts must not run in the parent page");
  await htmlFrame.getByText("Follow report", { exact: true }).click();
  await htmlFrame.getByText("Animated report link", { exact: true }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(externalHtmlRequests, [], "HTML preview links must not request external pages or their resources");
  await htmlFrame.getByRole("heading", { name: "Visual report" }).waitFor();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  assert.equal(await page.locator("iframe.workspace-file-html").count(), 0);
  assert.match(await page.locator(".workspace-file-source").innerText(), /<h1>Visual report<\/h1>/u);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await htmlFrame.getByRole("heading", { name: "Visual report" }).waitFor();
  await page.screenshot({ path: process.env.OPENCRAFT_HTML_SCREENSHOT ?? "/tmp/opencraft-html-preview.png" });
  await open("small.pdf"); await page.getByRole("button", { name: "Close", exact: true }).click(); await page.waitForTimeout(500); assert.equal(await page.locator(".workspace-pdf-preview__page canvas").count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", builtFixture: Boolean(fixtureBuild), pdfBytes: pdf.length, inkPixels: pixels, mediaEntry: true, zoom: true, pagination: true, download: true, phone: true, invalidFile: true, audio: true, video: true, unknownFile: true, htmlPreview: true, unmount: true }));
} finally { await browser?.close(); await vite.close(); }
