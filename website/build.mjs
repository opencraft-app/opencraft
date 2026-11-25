import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { messages, origin, render } from "./render.mjs";

const directory = new URL("./", import.meta.url);
const output = new URL("./dist/", directory);

await rm(output, { recursive: true, force: true });
await cp(new URL("./static/", directory), output, { recursive: true });
await access(new URL("agents.webp", output));
await copyFile(new URL("../apps/workbench-web/public/opencraft-icon.svg", directory), new URL("opencraft.svg", output));

const notices = await Promise.all(
  [
    ["Motion, Motion DOM and Motion Utils", "motion/LICENSE.md"],
    ["Framer Motion", "framer-motion/LICENSE.md"],
    ["Three.js", "three/LICENSE"],
  ].map(async ([name, file]) => name + "\n" + (await readFile(new URL("node_modules/" + file, directory), "utf8"))),
);

const pages = Object.entries(messages);
await Promise.all(
  pages.map(async ([locale, { home }]) => {
    const page = new URL("." + home, output);
    await mkdir(page, { recursive: true });
    await writeFile(new URL("index.html", page), render(locale));
  }),
);

await Promise.all([
  writeFile(new URL("404.html", output), render("en", { notFound: true })),
  writeFile(new URL("third-party-notices.txt", output), notices.join("\n\n")),
  writeFile(
    new URL("sitemap.xml", output),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(([, { home }]) => `  <url><loc>${origin + home}</loc></url>`).join("\n")}
</urlset>
`,
  ),
  build({
    absWorkingDir: fileURLToPath(directory),
    entryPoints: { site: "animate.mjs" },
    outdir: "dist",
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
  }),
]);
