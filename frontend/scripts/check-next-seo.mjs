import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const outRoot = join(process.cwd(), "out");
const buildRegion = process.env.NEXT_PUBLIC_REGION || process.env.VITE_REGION || "cn";
const requiredPublicRoutes = [
  "/",
  "/about",
  "/changelog",
  "/privacy-policy",
  "/cookie-policy",
  "/open-source-licenses",
  "/docs",
  "/docs/overview",
];
const localizedPrefixes = ["en-us", "zh-cn", "zh-sg", "zh-hant", "id-id", "es"];
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
];
const spanishPublicRouteSet = new Set(spanishPublicRoutes);

function htmlFileForRoute(route) {
  if (route === "/") return join(outRoot, "index.html");
  return join(outRoot, route.replace(/^\/+/, ""), "index.html");
}

function existingSeoRoutes() {
  const routes = new Set(requiredPublicRoutes);
  for (const prefix of localizedPrefixes) {
    for (const route of requiredPublicRoutes) {
      const localizedRoute = route === "/" ? `/${prefix}` : `/${prefix}${route}`;
      if (existsSync(htmlFileForRoute(localizedRoute))) {
        routes.add(localizedRoute);
      }
    }
  }
  if (buildRegion === "global") {
    for (const route of spanishPublicRoutes) routes.add(route);
  }
  return [...routes].sort();
}

function has(html, pattern) {
  return typeof pattern === "string" ? html.includes(pattern) : pattern.test(html);
}

function checksFor(route, html) {
  const baseChecks = {
    title: /<title>[^<]+<\/title>/.test(html),
    description: has(html, 'name="description"'),
    robots: has(html, 'name="robots"'),
    canonical: has(html, 'rel="canonical"'),
    hreflang: has(html, 'rel="alternate"') && has(html, "hrefLang="),
    ogTitle: has(html, 'property="og:title"'),
    ogDescription: has(html, 'property="og:description"'),
    ogUrl: has(html, 'property="og:url"'),
    ogImage: has(html, 'property="og:image"'),
    twitterCard: has(html, 'name="twitter:card"'),
    twitterTitle: has(html, 'name="twitter:title"'),
    twitterDescription: has(html, 'name="twitter:description"'),
    jsonLd: has(html, 'type="application/ld+json"'),
  };

  if (route === "/") {
    return {
      ...baseChecks,
      baiduVerification: has(html, 'name="baidu-site-verification"'),
      manifest: has(html, 'rel="manifest"') && has(html, "/manifest.webmanifest"),
      themeColor: has(html, 'name="theme-color"'),
      appName: has(html, 'name="application-name"'),
    };
  }

  return baseChecks;
}

function attributeValue(tag, name) {
  return tag?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function tagWithAttribute(html, name, value) {
  return (html.match(/<(?:html|meta|link)\b[^>]*>/g) ?? [])
    .find((tag) => attributeValue(tag, name) === value);
}

function spanishMetadataFailures(route, html) {
  if (!spanishPublicRouteSet.has(route)) return [];

  const expectedUrl = `https://lightvela.ai${route}/`;
  const htmlTag = html.match(/<html\b[^>]*>/)?.[0];
  const canonical = attributeValue(tagWithAttribute(html, "rel", "canonical"), "href");
  const ogUrl = attributeValue(tagWithAttribute(html, "property", "og:url"), "content");
  const ogLocale = attributeValue(tagWithAttribute(html, "property", "og:locale"), "content");
  const robots = attributeValue(tagWithAttribute(html, "name", "robots"), "content") ?? "";
  const spanishAlternate = (html.match(/<link\b[^>]*>/g) ?? []).find(
    (tag) => attributeValue(tag, "rel") === "alternate" && attributeValue(tag, "hrefLang") === "es",
  );
  const noindexExpected = route === "/es/subscribe" || route === "/es/support";
  const failures = [];

  if (attributeValue(htmlTag, "lang") !== "es") failures.push("expected html lang es");
  if (canonical !== expectedUrl) failures.push(`canonical must be ${expectedUrl}`);
  if (ogUrl !== canonical) failures.push("og:url must equal canonical");
  if (ogLocale !== "es_ES") failures.push("expected og:locale es_ES");
  if (attributeValue(spanishAlternate, "href") !== expectedUrl) {
    failures.push("expected Spanish hreflang self URL");
  }
  if (noindexExpected ? !robots.includes("noindex") : robots.includes("noindex") || !robots.includes("index")) {
    failures.push(noindexExpected ? "expected noindex robots" : "expected index robots");
  }

  return failures;
}

function checkManifest() {
  const file = join(outRoot, "manifest.webmanifest");
  if (!existsSync(file)) return ["missing /manifest.webmanifest"];

  const manifest = readFileSync(file, "utf8");
  const failures = [];
  for (const token of ['"name":"LightVela"', '"short_name":"LightVela"', '"icons":']) {
    if (!manifest.includes(token)) failures.push(`manifest missing ${token}`);
  }
  return failures;
}

if (!existsSync(outRoot)) {
  throw new Error(`missing Next static output directory: ${outRoot}`);
}

const failures = [];
for (const route of existingSeoRoutes()) {
  const file = htmlFileForRoute(route);
  if (!existsSync(file)) {
    failures.push(`${route}: missing ${file}`);
    continue;
  }

  const html = readFileSync(file, "utf8");
  const checks = checksFor(route, html);
  for (const [name, passed] of Object.entries(checks)) {
    if (!passed) failures.push(`${route}: missing ${name}`);
  }
  for (const failure of spanishMetadataFailures(route, html)) {
    failures.push(`${route}: ${failure}`);
  }
}

failures.push(...checkManifest());

if (failures.length > 0) {
  console.error("[check-next-seo] public SEO checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[check-next-seo] checked ${existingSeoRoutes().length} public static routes`);
