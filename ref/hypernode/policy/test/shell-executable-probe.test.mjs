import assert from "node:assert/strict";
import test from "node:test";

import { executableFromCommandVProbe } from "../src/services/shell-executable-probe.ts";

test("vSSH executable probes accept the DSH command -v spelling", () => {
  assert.equal(executableFromCommandVProbe("command -v bash"), "bash");
  assert.equal(executableFromCommandVProbe("command -v -- bash"), "bash");
  assert.equal(executableFromCommandVProbe("command -v -- 'bash'"), "bash");
  assert.equal(executableFromCommandVProbe('command -v -- "bash"'), "bash");
});

test("vSSH executable probes reject extra shell syntax", () => {
  assert.equal(executableFromCommandVProbe("command -v -- 'bash'; id"), null);
  assert.equal(executableFromCommandVProbe("command -v -- bash whoami"), null);
  assert.equal(executableFromCommandVProbe("command -v -- $(whoami)"), null);
});
