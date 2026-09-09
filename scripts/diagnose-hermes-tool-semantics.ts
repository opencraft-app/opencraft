import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-hermes-semantics-smoke",
  optimizeDeps: { include: ["react", "react-dom/client", "react-dom", "react/jsx-runtime", "react/compiler-runtime"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "hermes-semantic-fixture", configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/tests/fixtures/hermes-tool-semantics.tsx"></script>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`);
  await page.getByText("Read files", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Read files", exact: true }).click();
  await page.getByText("Listed files", { exact: true }).waitFor();
  await page.getByText("app.ts", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Hermes command grouping and expanded semantic rows: passed");
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/?missing`);
  await page.getByRole("button").first().click();
  await page.getByText("Result unknown", { exact: true }).waitFor();
  await page.getByText("Execution result unavailable", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Missing execution result is not rendered as success: passed");
} finally {
  await browser?.close();
  await server.close();
}
