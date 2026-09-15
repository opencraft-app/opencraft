// Test-only preload: terminate the exact isolated engine after native flush
// but before the checkpoint rename. Never imported by production builds.
const fs = require("node:fs");
const promises = require("node:fs/promises");
const original = promises.rename;
promises.rename = async function (from, to) {
  const root = process.env.OPENCRAFT_TEST_CHECKPOINT_ROOT;
  const armed = process.env.OPENCRAFT_TEST_CHECKPOINT_ARM;
  if (root && armed && String(to).startsWith(root + "/") && String(to).endsWith(".json") && fs.existsSync(armed)) {
    fs.unlinkSync(armed);
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  return original.call(this, from, to);
};
require("node:module").syncBuiltinESMExports();
