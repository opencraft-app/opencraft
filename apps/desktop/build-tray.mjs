import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

const templateSvg = await readFile(new URL("./assets/trayTemplate.svg", import.meta.url));
const iconSvg = await readFile(new URL("./assets/trayIcon.svg", import.meta.url));
await mkdir(new URL("./build/tray/", import.meta.url), { recursive: true });

for (const scale of [1, 2]) {
  const templatePng = new Resvg(templateSvg, { fitTo: { mode: "width", value: 18 * scale } }).render().asPng();
  await writeFile(new URL(`./build/tray/trayTemplate${scale === 2 ? "@2x" : ""}.png`, import.meta.url), templatePng);

  const iconPng = new Resvg(iconSvg, { fitTo: { mode: "width", value: 16 * scale } }).render().asPng();
  await writeFile(new URL(`./build/tray/trayIcon${scale === 2 ? "@2x" : ""}.png`, import.meta.url), iconPng);
}
