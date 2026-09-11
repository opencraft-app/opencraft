import assert from "node:assert/strict";
import { createServer } from "vite";
import { createCodexActivityReferenceModule } from "./lib/codex-activity-reference";

const reference = createCodexActivityReferenceModule();
const { chromium } = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-activity-render-parity",
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "original-activity-renderer",
      enforce: "pre",
      resolveId: (id) =>
        id === "virtual:codex-activity-reference" ? "\0" + id : null,
      load: (id) =>
        id === "\0virtual:codex-activity-reference" ? reference.code : null,
      transform(source, id) {
        if (id.endsWith("/activity/agent-activity-renderers.tsx"))
          return source + "\nexport {AgentActivityGroup};";
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<div id="root"></div><script type="module" src="/tests/fixtures/activity-parity.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript(
    "globalThis.__name=value=>value; Date.now=()=>1000000;",
  );
  await page.goto(
    `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`,
  );
  await page.waitForFunction(() => (window as any).activityProbe);
  await page.waitForTimeout(500);
  for (const event of [
    "unphased",
    "final",
    "grow",
    "complete",
    "expand",
    "collapse",
    "reset",
    "final",
    "complete",
    "reset",
    "final-no-clock",
    "complete",
  ]) {
    const trace = await page.evaluate(async (event: string) => {
      const label = (id: string) =>
        document.querySelector(
          id === "candidate"
            ? "#candidate [data-work-status]"
            : "#reference .tabular-nums",
        );
      const previous = [label("candidate"), label("reference")];
      const sample = () =>
        ["candidate", "reference"].map((id, index) => {
          const root = document.getElementById(id)!;
          const current = label(id);
          const range = document.createRange();
          if (current) range.selectNodeContents(current);
          const bounds = range.getBoundingClientRect();
          return {
            text: current?.textContent,
            sameNode: current === previous[index],
            top: bounds.top - root.getBoundingClientRect().top,
            height: bounds.height,
            rootHeight: root.getBoundingClientRect().height,
            toggle:
              root
                .querySelector("button[aria-expanded]")
                ?.getAttribute("aria-expanded") ?? null,
            animations: root.getAnimations({ subtree: true }).length,
          };
        });
      const before = sample();
      (window as any).activityProbe.event(event);
      const frames = [sample()];
      for (let i = 0; i < 24; i++) {
        await new Promise(requestAnimationFrame);
        frames.push(sample());
      }
      return { before, frames };
    }, event);
    const settled = trace.frames.at(-1)!;
    for (const key of [
      "text",
      "sameNode",
      "top",
      "height",
      "rootHeight",
      "toggle",
    ] as const) {
      assert.deepEqual(
        settled[0][key],
        settled[1][key],
        `${event} settled ${key}`,
      );
    }
    if (["grow", "complete"].includes(event)) {
      for (const [candidate, original] of trace.frames) {
        assert.equal(
          candidate.sameNode,
          true,
          `${event}: candidate remounted status`,
        );
        assert.equal(
          original.sameNode,
          true,
          `${event}: reference remounted status`,
        );
        assert.equal(
          candidate.top,
          trace.before[0].top,
          `${event}: status shifted`,
        );
        assert.equal(
          candidate.top,
          original.top,
          `${event}: reference divergence`,
        );
      }
    }
    console.log(JSON.stringify({ event, before: trace.before, settled }));
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "passed",
      referenceFunctions: reference.fingerprints,
      scope:
        "original DA/TA/fA + work label/header/divider; shared normalized Units, theme and non-work body ports",
    }),
  );
} finally {
  await browser?.close();
  await vite.close();
}
