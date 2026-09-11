import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const budgets = {
  htmlBytes: 400 * 1024,
  flightBytes: 240 * 1024,
  nextScriptCount: 22,
  nextScriptRawBytes: 2400 * 1024,
  nextScriptGzipBytes: 800 * 1024,
};
const budgetLabels = {
  htmlBytes: "HTML bytes",
  flightBytes: "Flight bytes",
  nextScriptCount: "Next script count",
  nextScriptRawBytes: "Next script raw bytes",
  nextScriptGzipBytes: "Next script gzip bytes",
};

const outDir = path.resolve(process.env.LIGHTVELA_HOMEPAGE_OUT_DIR || "out");
const htmlBuffer = readFileSync(path.join(outDir, "index.html"));
const html = htmlBuffer.toString("utf8");
const scriptSources = Array.from(
  new Set(Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g), (match) => match[1])),
);
const nextScriptPaths = scriptSources
  .filter(
    (source) =>
      source.includes("/_next/static/") &&
      new URL(source, "https://lightvela.local").pathname.endsWith(".js"),
  )
  .map((source) =>
    path.join(outDir, decodeURIComponent(new URL(source, "https://lightvela.local").pathname)),
  );
const chunks = nextScriptPaths.map((file) => ({ file, content: readFileSync(file) }));
const inlineScripts = Array.from(
  html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  (match) => match[1],
);
const flightBytes = inlineScripts
  .filter((body) => body.includes("self.__next_f.push"))
  .reduce((total, body) => total + Buffer.byteLength(body), 0);
const metrics = {
  htmlBytes: htmlBuffer.byteLength,
  flightBytes,
  nextScriptCount: chunks.length,
  nextScriptRawBytes: chunks.reduce((total, chunk) => total + chunk.content.byteLength, 0),
  nextScriptGzipBytes: chunks.reduce((total, chunk) => total + gzipSync(chunk.content).byteLength, 0),
};
const failures = Object.entries(budgets)
  .filter(([metric, budget]) => metrics[metric] > budget)
  .map(([metric, budget]) => `${budgetLabels[metric]} is ${metrics[metric]}, budget is ${budget}`);
const legacyChunks = chunks.filter(
  ({ content }) => content.includes(Buffer.from("LandingPageView")) || content.includes(Buffer.from("PublicHomePage")),
);

if (legacyChunks.length > 0) {
  failures.push(
    `legacy homepage code found in ${legacyChunks.map(({ file }) => path.relative(outDir, file)).join(", ")}`,
  );
}
if (failures.length > 0) {
  console.error(`[check-homepage-performance-budget] failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`[check-homepage-performance-budget] homepage budget passed ${JSON.stringify(metrics)}`);
}
