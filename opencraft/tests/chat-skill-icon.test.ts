import assert from "node:assert/strict";
import test from "node:test";
import { skillIconUrl } from "../packages/codex-composer/src/skill-icon";

test("Skill icons accept explicit image sources but never renderer-local files or credentials", () => {
  assert.equal(skillIconUrl("https://example.test/icon.png"),"https://example.test/icon.png");
  assert.equal(skillIconUrl("data:image/png;base64,aGVsbG8="),"data:image/png;base64,aGVsbG8=");
  for (const value of [null,"/home/remote/icon.png","file:///private/icon.png","javascript:alert(1)","https://user:secret@example.test/icon.png","data:text/html;base64,aGVsbG8=","data:image/svg+xml,<svg/>"]) assert.equal(skillIconUrl(value),null);
});
