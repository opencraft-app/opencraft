import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
const svg = await readFile(new URL("./assets/trayTemplate.svg", import.meta.url));
await mkdir(new URL("./build/tray/", import.meta.url), { recursive: true });
for (const scale of [1, 2]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 18 * scale } }).render().asPng();
  await writeFile(new URL(`./build/tray/trayTemplate${scale === 2 ? "@2x" : ""}.png`, import.meta.url), png);
}
