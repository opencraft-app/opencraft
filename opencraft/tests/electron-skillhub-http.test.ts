import assert from "node:assert/strict";
import test from "node:test";

import {
  requestDesktopSkillHub,
  validateDesktopSkillHubPath,
} from "../apps/workbench-electron/src/skillhub-http.js";

test("Electron SkillHub capability fixes the host, method, and public API path", async () => {
  const calls: Array<{ url: string; method: string; cookie: string | null }> = [];
  const response = await requestDesktopSkillHub("/api/v1/skillsets?scene=finance", async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? "",
      cookie: new Headers(init?.headers).get("cookie"),
    });
    return new Response(JSON.stringify({ skillSets: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.body)), { skillSets: [] });
  assert.deepEqual(calls, [{
    url: "https://api.skillhub.cn/api/v1/skillsets?scene=finance",
    method: "GET",
    cookie: null,
  }]);
});

test("Electron SkillHub capability rejects arbitrary hosts and non-API paths", () => {
  assert.throws(() => validateDesktopSkillHubPath("https://example.invalid/api/v1/skillsets"));
  assert.throws(() => validateDesktopSkillHubPath("/auth/profile"));
  assert.throws(() => validateDesktopSkillHubPath("/api/v1/skillsets#fragment"));
});

test("Electron SkillHub capability follows only the fixed public artifact CDN", async () => {
  const calls: string[] = [];
  const artifactUrl = "https://skillhub-1388575217.cos.accelerate.myqcloud.com/skills/demo/1.0.0/files/SKILL.md";
  const response = await requestDesktopSkillHub("/api/v1/skills/demo/file?path=SKILL.md", async (url) => {
    calls.push(url.toString());
    if (url.origin === "https://api.skillhub.cn") {
      return new Response(null, { status: 302, headers: { location: artifactUrl } });
    }
    return new Response("# Demo", { status: 200, headers: { "content-type": "application/octet-stream" } });
  });
  assert.equal(new TextDecoder().decode(response.body), "# Demo");
  assert.deepEqual(calls, [
    "https://api.skillhub.cn/api/v1/skills/demo/file?path=SKILL.md",
    artifactUrl,
  ]);
});

test("Electron SkillHub capability rejects redirects outside the fixed artifact CDN", async () => {
  await assert.rejects(
    requestDesktopSkillHub("/api/v1/skills/demo/file?path=SKILL.md", async () => (
      new Response(null, { status: 302, headers: { location: "https://example.invalid/SKILL.md" } })
    )),
    /不受支持的下载地址/u,
  );
});
