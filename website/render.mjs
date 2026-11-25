const repository = "https://github.com/opencraft-app/opencraft";
const docs = repository + "/blob/main/docs/README.md";
const releases = repository + "/releases";
const deploy = repository + "/blob/main/deploy/docker/README.md";
export const origin = "https://opencraft.app";
export const messages = {
  en: {
    language: "en",
    home: "/",
    label: "English",
    description:
      "An open-source workbench for the agents you run. Connect local and remote hosts, keep conversations in reach, and share access on your terms.",
    skip: "Skip to content",
    docs: "Docs",
    download: "Download OpenCraft",
    repo: "GitHub",
    category: "Open-source agent workbench",
    titleLine1: "Your agents.",
    titleLine2: "Within reach.",
    intro: "Bring the agents you already run into one workbench, from your laptop to a server you manage.",
    selfHost: "Self-host with Docker",
    artAlt: "Three computing modules connected by glowing copper cables",
    supportTitle: "Connect the tools you use",
    protocols: ["Codex", "Cursor", "ACP", "MCP"],
    benefitsTitle: "One workbench, wherever your agents run.",
    benefits: [
      [
        "Bring your agents",
        "Connect Codex, Cursor, or an ACP agent. Use supported native models or configure your own model provider.",
      ],
      [
        "Pick up where you left off",
        "Open workspaces and supported conversation history on the host that owns them, from a browser or desktop.",
      ],
      [
        "Share access on your terms",
        "Grant access to the people you choose. Your agent’s credentials stay on its execution host.",
      ],
    ],
    start: "Get started",
    startBody: "Install the desktop app, or run OpenCraft on your own server.",
    license: "MIT-0 license",
    missingTitle: "Page not found",
    missingBody: "Return to the OpenCraft homepage.",
    backHome: "Back to home",
  },
};

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

export function render(locale, { notFound = false } = {}) {
  const copy = messages[locale];
  const t = (key) => escapeHtml(copy[key]);
  const alternates = Object.values(messages);
  const alternateLinks =
    alternates.length > 1
      ? alternates
          .map(({ language, home }) => `<link rel="alternate" hreflang="${language}" href="${origin + home}">`)
          .join("\n  ")
      : "";
  const localeLinks = alternates
    .filter((item) => item !== copy)
    .map(
      ({ language, home, label }) =>
        `<a class="locale" href="${home}" hreflang="${language}" lang="${language}">${escapeHtml(label)}</a>`,
    )
    .join("\n        ");
  const title = notFound ? t("missingTitle") + " · OpenCraft" : "OpenCraft — " + t("category");
  return `<!doctype html>
<html lang="${copy.language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#141513">
  <title>${title}</title>
  <meta name="description" content="${t("description")}">
  ${
    notFound
      ? '<meta name="robots" content="noindex">'
      : `<link rel="canonical" href="${origin + copy.home}">
  ${alternateLinks}
  <meta property="og:type" content="website">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${t("description")}">
  <meta property="og:url" content="${origin + copy.home}">
  <meta property="og:image" content="${origin}/agents.webp">`
  }
  <link rel="icon" href="/opencraft.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/site.css">
  ${notFound ? "" : '<script type="module" src="/site.js"></script>'}
</head>
<body>
  <a class="skip" href="#main">${t("skip")}</a>
  <header class="site-header">
    <div class="frame header-inner">
      <a class="brand" href="${copy.home}"><img src="/opencraft.svg" width="34" height="34" alt=""><span>OpenCraft</span></a>
      <nav class="navigation">
        <a href="${docs}">${t("docs")}</a>
        <a href="${repository}">${t("repo")} <span aria-hidden="true">↗</span></a>
        ${localeLinks}
      </nav>
    </div>
  </header>
  ${
    notFound
      ? `<main class="frame missing" id="main">
    <h1>${t("missingTitle")}</h1>
    <p>${t("missingBody")}</p>
    <a class="button primary" href="${copy.home}">${t("backHome")} <span aria-hidden="true">→</span></a>
  </main>`
      : `<main id="main">
    <section class="frame hero">
      <div class="hero-copy">
        <p class="eyebrow"><span class="signal" aria-hidden="true"></span>${t("category")}</p>
        <h1>${t("titleLine1")}<br><em>${t("titleLine2")}</em></h1>
        <p class="intro">${t("intro")}</p>
        <div class="actions">
          <a class="button primary" href="${releases}">${t("download")} <span aria-hidden="true">↗</span></a>
          <a class="button secondary" href="${deploy}">${t("selfHost")} <span aria-hidden="true">↗</span></a>
        </div>
      </div>
      <figure class="hero-art">
        <img src="/agents.webp" width="1536" height="1024" alt="${t("artAlt")}" fetchpriority="high">
      </figure>
    </section>
    <section class="protocols" aria-labelledby="protocol-heading">
      <div class="frame protocol-inner">
        <h2 id="protocol-heading">${t("supportTitle")}</h2>
        <ul>${copy.protocols.map((name) => "<li>" + escapeHtml(name) + "</li>").join("")}</ul>
      </div>
    </section>
    <section class="frame benefits" aria-labelledby="benefits-heading">
      <h2 id="benefits-heading">${t("benefitsTitle")}</h2>
      <div class="benefit-grid">
        ${copy.benefits.map(([heading, body]) => `<article><h3>${escapeHtml(heading)}</h3><p>${escapeHtml(body)}</p></article>`).join("")}
      </div>
    </section>
    <section class="frame start" aria-labelledby="start-heading">
      <div><h2 id="start-heading">${t("start")}</h2><p>${t("startBody")}</p></div>
      <div class="actions">
        <a class="button primary" href="${releases}">${t("download")} <span aria-hidden="true">↗</span></a>
        <a class="button secondary" href="${deploy}">${t("selfHost")} <span aria-hidden="true">↗</span></a>
      </div>
    </section>
  </main>`
  }
  <footer class="frame footer">
    <a class="brand" href="${copy.home}"><img src="/opencraft.svg" width="28" height="28" alt=""><span>OpenCraft</span></a>
    <div><a href="${repository}/blob/main/LICENSE">${t("license")}</a><a href="${repository}">${t("repo")} <span aria-hidden="true">↗</span></a></div>
  </footer>
</body>
</html>
`;
}
