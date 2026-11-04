import test from "node:test";
import assert from "node:assert/strict";
import { externalGenerationAppBundle } from "../../apps/codex-core/src/generation-supervisor.js";

const args = ["/fixed/node", "/independent/current-app.cjs", "--endpoint", "/run/native/control.sock"];
const launch = (argv = args.join(" "), executable = args[0]) => `{ path=${executable} ; argv[]=${argv} ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

test("host reboot observes an adopted APP from its resolved independent unit", () => {
  assert.equal(externalGenerationAppBundle(launch(), args), "/independent/current-app.cjs");
});

test("a changed unit program or selector cannot authorize the running APP", () => {
  assert.throws(() => externalGenerationAppBundle(launch(args.join(" ").replace("current-app", "other-app")), args));
  assert.throws(() => externalGenerationAppBundle(launch(args.join(" ").replace("/run/native", "/run/foreign")), args));
  assert.throws(() => externalGenerationAppBundle(launch(args.join(" "), "/foreign/node"), args));
});

test("missing, multiple, relative and permissive unit declarations fail closed", () => {
  assert.throws(() => externalGenerationAppBundle("", args));
  assert.throws(() => externalGenerationAppBundle(launch() + " " + launch(), args));
  assert.throws(() => externalGenerationAppBundle(launch().replace("ignore_errors=no", "ignore_errors=yes"), args));
  assert.throws(() => externalGenerationAppBundle(launch("/fixed/node relative.cjs"), ["/fixed/node", "relative.cjs"]));
});
