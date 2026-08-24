import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const requiredRoutes = [
  "/",
  "/about",
  "/changelog",
  "/privacy-policy",
  "/cookie-policy",
  "/open-source-licenses",
  "/docs",
  "/docs/overview",
];

const spanishPublicRoutes = [
  "/es",
  "/es/about",
  "/es/changelog",
  "/es/cookie-policy",
  "/es/open-source-licenses",
  "/es/privacy-policy",
  "/es/subscribe",
  "/es/support",
  "/es/terms-of-service",
] as const;

const validHtml = [
  "<html lang=\"es\"><head>",
  "<title>LightVela</title>",
  '<meta name="description"><meta name="robots">',
  '<link rel="canonical"><link rel="alternate" hrefLang="es">',
  '<meta property="og:title"><meta property="og:description"><meta property="og:url"><meta property="og:image">',
  '<meta name="twitter:card"><meta name="twitter:title"><meta name="twitter:description">',
  '<script type="application/ld+json">{}</script>',
  '<meta name="baidu-site-verification"><link rel="manifest" href="/manifest.webmanifest">',
  '<meta name="theme-color"><meta name="application-name">',
  "</head><body></body></html>",
].join("");

function writeRoute(root: string, route: string, html = validHtml) {
  const directory = route === "/" ? root : join(root, route.replace(/^\/+/, ""));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), html);
}

function spanishHtml(route: string, robots = "index, follow") {
  const canonical = `https://lightvela.ai${route}/`;
  return [
    '<html lang="es"><head>',
    "<title>LightVela en español</title>",
    '<meta name="description" content="Descripción única en español">',
    `<meta name="robots" content="${robots}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<link rel="alternate" hrefLang="es" href="${canonical}">`,
    '<meta property="og:title" content="LightVela en español">',
    '<meta property="og:description" content="Descripción única en español">',
    `<meta property="og:url" content="${canonical}">`,
    '<meta property="og:locale" content="es_ES">',
    '<meta property="og:image" content="https://lightvela.ai/social.png">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="LightVela en español">',
    '<meta name="twitter:description" content="Descripción única en español">',
    '<script type="application/ld+json">{}</script>',
    ...(route === "/es"
      ? [
          '<meta name="baidu-site-verification">',
          '<link rel="manifest" href="/manifest.webmanifest">',
          '<meta name="theme-color">',
          '<meta name="application-name">',
        ]
      : []),
    "</head><body></body></html>",
  ].join("");
}

function writeSpanishRoutes(out: string) {
  for (const route of spanishPublicRoutes) {
    const noindex = route === "/es/subscribe" || route === "/es/support";
    writeRoute(out, route, spanishHtml(route, noindex ? "noindex, nofollow" : "index, follow"));
  }
}

function checkerFailure(script: string, root: string, region: "cn" | "global" = "cn"): string {
  try {
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, NEXT_PUBLIC_REGION: region, VITE_REGION: region },
      stdio: "pipe",
    });
    return "";
  } catch (error) {
    return String(error);
  }
}

function prepareOutput() {
  const root = mkdtempSync(join(tmpdir(), "check-next-seo-"));
  const out = join(root, "out");
  for (const route of requiredRoutes) writeRoute(out, route);
  writeFileSync(join(out, "manifest.webmanifest"), '{"name":"LightVela","short_name":"LightVela","icons":[]}');
  return { root, out };
}

describe("check-next-seo Spanish release paths", () => {
  it("checks existing Spanish static pages", () => {
    const { root, out } = prepareOutput();
    try {
      writeRoute(out, "/es/about", "<html><head><title>Broken</title></head></html>");
      const script = resolve("scripts/check-next-seo.mjs");

      let failure: unknown;
      try {
        execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("/es/about: missing description");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish checks for hidden Japanese or Korean paths", () => {
    const { root, out } = prepareOutput();
    try {
      writeRoute(out, "/es/about", spanishHtml("/es/about"));
      writeRoute(out, "/ja-jp/about", "<html></html>");
      writeRoute(out, "/ko-kr/about", "<html></html>");
      const script = resolve("scripts/check-next-seo.mjs");

      expect(() => execFileSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, NEXT_PUBLIC_REGION: "cn", VITE_REGION: "cn" },
        stdio: "pipe",
      })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks all nine Spanish public pages", () => {
    const { root, out } = prepareOutput();
    try {
      writeSpanishRoutes(out);
      writeRoute(out, "/es/terms-of-service", spanishHtml("/es/terms-of-service").replace(/<meta name="description"[^>]*>/, ""));
      const script = resolve("scripts/check-next-seo.mjs");

      expect(checkerFailure(script, root, "global")).toContain("/es/terms-of-service: missing description");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects incorrect Spanish lang, canonical, OG URL, locale, and hreflang values", () => {
    const { root, out } = prepareOutput();
    try {
      writeSpanishRoutes(out);
      const invalid = spanishHtml("/es/about")
        .replace('lang="es"', 'lang="en-US"')
        .replace('rel="canonical" href="https://lightvela.ai/es/about/"', 'rel="canonical" href="https://lightvela.ai/about/"')
        .replace('property="og:url" content="https://lightvela.ai/es/about/"', 'property="og:url" content="https://lightvela.ai/es/wrong/"')
        .replace('hrefLang="es" href="https://lightvela.ai/es/about/"', 'hrefLang="es" href="https://lightvela.ai/about/"')
        .replace('content="es_ES"', 'content="en_US"');
      writeRoute(out, "/es/about", invalid);
      const script = resolve("scripts/check-next-seo.mjs");
      const failure = checkerFailure(script, root, "global");

      expect(failure).toContain("/es/about: expected html lang es");
      expect(failure).toContain("/es/about: canonical must be https://lightvela.ai/es/about/");
      expect(failure).toContain("/es/about: og:url must equal canonical");
      expect(failure).toContain("/es/about: expected og:locale es_ES");
      expect(failure).toContain("/es/about: expected Spanish hreflang self URL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces Spanish index and noindex robots contracts", () => {
    const { root, out } = prepareOutput();
    try {
      writeSpanishRoutes(out);
      writeRoute(out, "/es/about", spanishHtml("/es/about", "noindex, nofollow"));
      writeRoute(out, "/es/support", spanishHtml("/es/support", "index, follow"));
      const script = resolve("scripts/check-next-seo.mjs");
      const failure = checkerFailure(script, root, "global");

      expect(failure).toContain("/es/about: expected index robots");
      expect(failure).toContain("/es/support: expected noindex robots");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires all nine Spanish pages in a global build even when no ES artifact exists", () => {
    const { root } = prepareOutput();
    try {
      const script = resolve("scripts/check-next-seo.mjs");
      const failure = checkerFailure(script, root, "global");

      for (const route of spanishPublicRoutes) {
        expect(failure).toContain(`${route}: missing`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not require Spanish pages in a CN build", () => {
    const { root } = prepareOutput();
    try {
      const script = resolve("scripts/check-next-seo.mjs");

      expect(checkerFailure(script, root, "cn")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
