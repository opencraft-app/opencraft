#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function usage() {
  console.error(
    [
      "Usage:",
      "  node render-html-report.js --input report-data.json --out report.html",
      "",
      "Options:",
      "  --input <file>   JSON report data file. Required.",
      "  --out <file>     HTML output path. Defaults to <input-dir>/validation-report.html.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--input" || key === "--out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${key} requires a value`);
      }
      args[key.slice(2)] = value;
      i += 1;
      continue;
    }
    if (key === "--help" || key === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function summaryEntries(summary) {
  if (!summary) return [];
  if (Array.isArray(summary)) return summary;
  if (typeof summary === "object") {
    return Object.entries(summary).map(([label, value]) => ({ label, value }));
  }
  return [{ label: "Summary", value: summary }];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function classToken(value, fallback) {
  const token = String(value || fallback || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback || "unknown";
}

function displayValue(value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function linkHref(rawPath, outDir) {
  if (!rawPath) return "";
  const value = String(rawPath);
  if (/^(https?:|file:|data:)/i.test(value)) return value;
  if (!path.isAbsolute(value)) return value;

  const relative = path.relative(outDir, value);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return value;
}

function looksLikeImage(ref) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(String(ref).split("?")[0]);
}

function renderEvidence(evidence, outDir) {
  const items = ensureArray(evidence);
  if (items.length === 0) return "<span class=\"muted\">No evidence recorded</span>";

  return `<div class="evidence-list">${items
    .map((item) => {
      const ref =
        typeof item === "object" && item !== null
          ? item.path || item.url || item.href || item.file || item.label
          : item;
      const label =
        typeof item === "object" && item !== null && item.label ? item.label : ref;
      const href = linkHref(ref, outDir);
      const safeHref = escapeHtml(href);
      const safeLabel = escapeHtml(label);
      if (href && looksLikeImage(href)) {
        return `<figure><a href="${safeHref}">${safeLabel}</a><img src="${safeHref}" alt="${safeLabel}" loading="lazy"></figure>`;
      }
      if (href) return `<a href="${safeHref}">${safeLabel}</a>`;
      return `<span>${safeLabel}</span>`;
    })
    .join("")}</div>`;
}

function renderEnvironment(environment) {
  if (!environment || typeof environment !== "object") return "";
  const rows = Object.entries(environment)
    .map(
      ([key, value]) =>
        `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(displayValue(value))}</td></tr>`,
    )
    .join("");
  return `<section><h2>Environment</h2><table class="kv"><tbody>${rows}</tbody></table></section>`;
}

function renderSummary(summary) {
  const entries = summaryEntries(summary);
  if (entries.length === 0) return "";
  return `<section><h2>Summary</h2><div class="summary-grid">${entries
    .map((entry) => {
      const label = typeof entry === "object" ? entry.label : "Summary";
      const value = typeof entry === "object" ? entry.value : entry;
      const note = typeof entry === "object" ? entry.note : "";
      return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(displayValue(value))}</strong>${
        note ? `<p>${escapeHtml(note)}</p>` : ""
      }</article>`;
    })
    .join("")}</div></section>`;
}

function renderFindings(findings, outDir) {
  const items = ensureArray(findings);
  if (items.length === 0) {
    return `<section><h2>Findings</h2><p class="muted">No findings recorded.</p></section>`;
  }
  return `<section><h2>Findings</h2><div class="findings">${items
    .map((finding) => {
      const level = classToken(finding.level || finding.severity, "info");
      const title = finding.title || finding.name || "Untitled finding";
      const detail = finding.detail || finding.description || "";
      const recommendation = finding.recommendation || finding.suggestion || "";
      const source = finding.source ? `<p><b>Source:</b> ${escapeHtml(finding.source)}</p>` : "";
      return `<article class="finding ${level}"><div class="finding-head"><span>${escapeHtml(
        String(finding.level || finding.severity || "INFO").toUpperCase(),
      )}</span><h3>${escapeHtml(title)}</h3></div>${
        detail ? `<p>${escapeHtml(detail)}</p>` : ""
      }${recommendation ? `<p><b>Recommendation:</b> ${escapeHtml(recommendation)}</p>` : ""}${source}${renderEvidence(
        finding.evidence || finding.screenshots,
        outDir,
      )}</article>`;
    })
    .join("")}</div></section>`;
}

function renderCases(cases, outDir) {
  const items = ensureArray(cases);
  if (items.length === 0) {
    return `<section><h2>Test Cases</h2><p class="muted">No test cases recorded.</p></section>`;
  }
  const rows = items
    .map((testCase) => {
      const result = classToken(testCase.result || testCase.status, "unknown");
      return `<tr class="${result}"><td><b>${escapeHtml(
        testCase.id || "",
      )}</b><br>${escapeHtml(testCase.title || testCase.name || "")}</td><td>${escapeHtml(
        displayValue(testCase.device),
      )}</td><td>${escapeHtml(displayValue(testCase.initialState || testCase.state))}</td><td>${escapeHtml(
        displayValue(testCase.entry),
      )}</td><td>${escapeHtml(displayValue(testCase.action))}</td><td>${escapeHtml(
        displayValue(testCase.expected),
      )}</td><td>${escapeHtml(displayValue(testCase.actual))}</td><td><span class="status ${result}">${escapeHtml(
        String(testCase.result || testCase.status || "unknown"),
      )}</span></td><td>${renderEvidence(testCase.evidence || testCase.screenshots, outDir)}</td></tr>`;
    })
    .join("");
  return `<section><h2>Test Cases</h2><div class="table-wrap"><table class="cases"><thead><tr><th>ID / Title</th><th>Device</th><th>Initial State</th><th>Entry</th><th>Action</th><th>Expected</th><th>Actual</th><th>Result</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderListSection(title, values, emptyText, outDir) {
  const items = ensureArray(values);
  if (items.length === 0) return `<section><h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(emptyText)}</p></section>`;
  return `<section><h2>${escapeHtml(title)}</h2><ul>${items
    .map((item) => {
      if (typeof item === "object" && item !== null && (item.path || item.url || item.href)) {
        return `<li>${renderEvidence(item, outDir)}</li>`;
      }
      if (typeof item === "object" && item !== null) {
        const label = item.label || item.title || item.name || "";
        const value = item.value || item.detail || item.path || "";
        return `<li><b>${escapeHtml(label)}</b>${value ? `: ${escapeHtml(displayValue(value))}` : ""}</li>`;
      }
      return `<li>${escapeHtml(item)}</li>`;
    })
    .join("")}</ul></section>`;
}

function renderHtml(report, outPath) {
  const outDir = path.dirname(path.resolve(outPath));
  const title = report.title || "LightVela Web Validation Report";
  const generatedAt = report.generatedAt || new Date().toISOString();
  const target = report.target || report.url || "";
  const findings = report.findings || report.issues || [];
  const cases = report.cases || report.testCases || [];
  const untested = report.untested || report.gaps || report.blockers || [];
  const artifacts = report.artifacts || report.files || [];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1f2937;
      --muted: #64748b;
      --line: #d9dee7;
      --blue: #2563eb;
      --green: #16803c;
      --amber: #a15c00;
      --red: #c2410c;
      --purple: #6d28d9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
    }
    header {
      padding: 32px 40px 24px;
      background: #111827;
      color: white;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 24px 48px;
    }
    h1, h2, h3 { margin: 0; line-height: 1.25; }
    h1 { font-size: 28px; }
    h2 { font-size: 20px; margin-bottom: 14px; }
    h3 { font-size: 16px; }
    header p { margin: 8px 0 0; color: #cbd5e1; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 18px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    a { color: var(--blue); overflow-wrap: anywhere; }
    .muted { color: var(--muted); }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .summary-grid article {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: #fafafa;
    }
    .summary-grid span {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 6px;
    }
    .summary-grid strong {
      display: block;
      font-size: 20px;
      overflow-wrap: anywhere;
    }
    .summary-grid p { margin: 6px 0 0; color: var(--muted); }
    .findings {
      display: grid;
      gap: 12px;
    }
    .finding {
      border: 1px solid var(--line);
      border-left: 5px solid var(--blue);
      border-radius: 8px;
      padding: 14px;
      background: #fff;
    }
    .finding.p0, .finding.p1, .finding.fail { border-left-color: var(--red); }
    .finding.p2, .finding.warn { border-left-color: var(--amber); }
    .finding.p3, .finding.info { border-left-color: var(--blue); }
    .finding.pass { border-left-color: var(--green); }
    .finding-head {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .finding-head span, .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 48px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #e5e7eb;
      color: #111827;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .status.pass { background: #dcfce7; color: var(--green); }
    .status.warn, .status.blocked { background: #fef3c7; color: var(--amber); }
    .status.fail { background: #fee2e2; color: var(--red); }
    .status.unknown { background: #ede9fe; color: var(--purple); }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px;
      vertical-align: top;
      text-align: left;
    }
    th {
      background: #f8fafc;
      color: #475569;
      font-weight: 700;
    }
    tr:last-child td { border-bottom: 0; }
    table.kv th { width: 180px; }
    .evidence-list {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    figure {
      margin: 0;
      display: grid;
      gap: 6px;
    }
    img {
      max-width: 320px;
      max-height: 220px;
      border: 1px solid var(--line);
      border-radius: 6px;
      object-fit: contain;
      background: #fff;
    }
    ul { margin: 0; padding-left: 20px; }
    li + li { margin-top: 6px; }
    @media (max-width: 720px) {
      header { padding: 24px 20px; }
      main { padding: 18px 12px 36px; }
      section { padding: 16px; }
      h1 { font-size: 22px; }
      img { max-width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p>${target ? `Target: ${escapeHtml(target)} · ` : ""}Generated: ${escapeHtml(generatedAt)}</p>
  </header>
  <main>
    ${renderSummary(report.summary)}
    ${renderEnvironment(report.environment)}
    ${renderFindings(findings, outDir)}
    ${renderCases(cases, outDir)}
    ${renderListSection("Untested / Gaps", untested, "No untested gaps recorded.", outDir)}
    ${renderListSection("Artifacts", artifacts, "No additional artifacts recorded.", outDir)}
  </main>
</body>
</html>
`;
}

function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      usage();
      return;
    }
    if (!args.input) {
      usage();
      process.exitCode = 1;
      return;
    }

    const inputPath = path.resolve(args.input);
    const outPath = path.resolve(args.out || path.join(path.dirname(inputPath), "validation-report.html"));
    const report = readJson(inputPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, renderHtml(report, outPath), "utf8");
    console.log(outPath);
  } catch (error) {
    console.error(`[render-html-report] ${error.message}`);
    process.exitCode = 1;
  }
}

main();
