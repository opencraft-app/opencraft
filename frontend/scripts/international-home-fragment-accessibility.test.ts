import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeInternationalHomeFragmentAccessibility } from "./international-home-fragment-accessibility.mjs";

describe("initializeInternationalHomeFragmentAccessibility", () => {
  it("initializes one pressed button per scene without changing unrelated markup", async () => {
    const homeRoot = await mkdtemp(path.join(tmpdir(), "international-home-a11y-"));
    const fragmentPath = path.join(homeRoot, "index-fragment.en-US.html");
    const fragment = [
      '<div data-keep="unchanged">Keep me</div>',
      '<section class="scene"><button class="scene__sub on">One</button><button class="scene__sub">Two</button><button class="scene__sub">Three</button></section>',
      '<section class="scene"><button class="scene__sub">Four</button><button class="scene__sub on">Five</button><button class="scene__sub">Six</button></section>',
    ].join("");
    await writeFile(fragmentPath, fragment);

    const firstSummary = await initializeInternationalHomeFragmentAccessibility(homeRoot);
    const firstOutput = await readFile(fragmentPath, "utf8");
    const document = new DOMParser().parseFromString(firstOutput, "text/html");

    expect(firstSummary).toEqual({ buttons: 6, fragments: 1 });
    expect(document.querySelector('[data-keep="unchanged"]')?.textContent).toBe("Keep me");
    for (const scene of document.querySelectorAll(".scene")) {
      const buttons = Array.from(scene.querySelectorAll<HTMLButtonElement>(".scene__sub"));
      expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(
        buttons.map((button) => button.classList.contains("on") ? "true" : "false"),
      );
      expect(buttons.filter((button) => button.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    }

    const secondSummary = await initializeInternationalHomeFragmentAccessibility(homeRoot);
    expect(secondSummary).toEqual(firstSummary);
    expect(await readFile(fragmentPath, "utf8")).toBe(firstOutput);
  });
});
