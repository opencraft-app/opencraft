import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveAnnouncementMediaUrl } from "../apps/workbench-web/src/components/modal/announcement-media-url";

test("announcement media URLs become absolute against the renderer module", () => {
  assert.equal(
    resolveAnnouncementMediaUrl("./announcement.svg", "http://127.0.0.1:4567/assets/workbench.js"),
    "http://127.0.0.1:4567/assets/announcement.svg",
  );
  assert.equal(
    resolveAnnouncementMediaUrl("/assets/announcement.svg", "https://lightvela.ai/settings/laboratory"),
    "https://lightvela.ai/assets/announcement.svg",
  );
  assert.equal(resolveAnnouncementMediaUrl("blob:https://lightvela.ai/id", "https://lightvela.ai/app.js"),
    "blob:https://lightvela.ai/id");
  assert.throws(
    () => resolveAnnouncementMediaUrl("data:text/html,unsafe", "https://lightvela.ai/app.js"),
    /HTTP\(S\) or blob/u,
  );
});

test("the packaged Laboratory image remains a loopback-served asset", async () => {
  const source = await readFile(
    new URL("../apps/workbench-web/src/components/modal/announcement-lab.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /announcement-lab\.svg\?url&no-inline/u);
});
