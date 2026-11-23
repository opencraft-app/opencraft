import { appendFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

/** Communication extension selected through Headless composition in tests. A
 * storage Worker that re-imports this module records it in the marker file. */
if (!isMainThread && process.env.OPENCRAFT_TEST_EXTENSION_MARKER)
  appendFileSync(process.env.OPENCRAFT_TEST_EXTENSION_MARKER, "worker\n");
export const communicationExtension = Object.freeze({
  channelFiles: (source) => source === "fixture/composed",
  groupCreateOptions: Object.freeze([
    Object.freeze({ id: "mirror", label: { id: "fixture.mirror", defaultMessage: "Mirror" }, defaultSelected: false }),
  ]),
});
