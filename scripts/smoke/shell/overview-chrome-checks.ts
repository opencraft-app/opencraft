import assert from "node:assert/strict";
import type { Page } from "playwright";

// Observe the actual destination controls, not just overview-card headings.
export async function startChromeCapture(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.chromeFrames = [];
    const selector =
      ".panel-mobile-dock, .thread-scroll-footer, .app-shell-header-motion-host > *, [data-retained-preview-chrome], .side-chat-header, .thread-composer-overlay-host";
    const sample = () => {
      const nodes = [...document.querySelectorAll<HTMLElement>(selector)].filter((n) => n.getClientRects().length);
      w.chromeFrames.push({
        legacy: document.documentElement.hasAttribute("data-retained-handoff"),
        nodes: nodes.map((node) => {
          const style = getComputedStyle(node),
            shell = node.closest(".app-shell-root");
          const parentChrome = node.parentElement?.closest(selector);
          const nested = !!parentChrome && parentChrome.closest(".app-shell-root") === shell;
          return {
            name: node.className,
            borrowed: !!node.closest('[data-retained-preview="true"]'),
            visibility: style.visibility,
            opacity: Number(style.opacity),
            transform: style.transform,
            progress: Number(shell ? getComputedStyle(shell).getPropertyValue("--scene-chrome-opacity") || 1 : 1),
            nested,
            inert: !!node.closest("[inert]"),
          };
        }),
      });
      w.chromeCaptureFrame = requestAnimationFrame(sample);
    };
    sample();
  });
}

export async function finishChromeCapture(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    cancelAnimationFrame(w.chromeCaptureFrame);
    return w.chromeFrames as Array<{
      legacy: boolean;
      nodes: Array<{
        name: string;
        borrowed: boolean;
        visibility: string;
        opacity: number;
        transform: string;
        progress: number;
        nested: boolean;
        inert: boolean;
      }>;
    }>;
  });
}

export function assertChromeFrames(frames: Awaited<ReturnType<typeof finishChromeCapture>>, label: string) {
  assert(frames.length > 2, label + ": capture must span presentation frames");
  for (const frame of frames) {
    assert.equal(frame.legacy, false, label + ": no document-global handoff animation");
    for (const node of frame.nodes) {
      if (node.borrowed) {
        // Main Shell chrome stays outside the borrowed renderer. Inside it,
        // controls retain their layout/draft but are never thumbnail paint.
        assert.equal(node.visibility, "hidden", label + ": borrowed chrome " + node.name);
      } else {
        assert(
          Math.abs(node.opacity - (node.nested ? 1 : node.progress)) < 0.0001,
          label + ": destination chrome must use exactly one shared opacity: " + JSON.stringify(node),
        );
        if (node.progress < 1) assert(node.inert, label + ": invisible controls cannot accept input");
      }
      if (node.name.includes("side-chat-header"))
        assert.equal(node.transform, "none", label + ": no second title translation");
    }
  }
}

export async function assertChromeBoundaries(page: Page) {
  const result = await page.evaluate(() => {
    const root = document.createElement("div");
    root.className = "app-shell-root";
    root.style.setProperty("--scene-chrome-opacity", ".4");
    root.innerHTML = `<header data-retained-preview-chrome></header>
      <div class="thread-composer-overlay-host"><div class="thread-scroll-footer"></div></div>
      <section class="app-shell-root"><header data-retained-preview-chrome></header></section>`;
    document.body.append(root);
    try {
      const opacity = (selector: string) => Number(getComputedStyle(root.querySelector(selector)!).opacity);
      return {
        header: opacity(":scope > header"),
        host: opacity(".thread-composer-overlay-host"),
        footer: opacity(".thread-scroll-footer"),
        nestedShell: opacity("section header"),
      };
    } finally {
      root.remove();
    }
  });
  assert.deepEqual(
    result,
    { header: 0.4, host: 0.4, footer: 1, nestedShell: 1 },
    "floating composer alpha is not squared; independent Shell does not inherit another scene",
  );
}
