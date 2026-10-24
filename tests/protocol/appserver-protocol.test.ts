import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResumeHistoryRequest,
  OPENCRAFT_ATTACHMENT_STAGING_EXTENSION,
  parseAttachmentStagingCapability,
  parseThreadLifecycleCapability,
} from "@opencraft/appserver-protocol";

test("attachment staging capability is explicit and forward-compatible", () => {
  assert.equal(OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, "opencraft/attachment-staging");
  assert.deepEqual(parseAttachmentStagingCapability({
    version: 1,
    sources: ["client-bytes"],
    locations: ["host-file"],
    maxBytes: 32 * 1024 * 1024,
  }), {
    version: 1,
    sources: ["client-bytes"],
    locations: ["host-file"],
    maxBytes: 32 * 1024 * 1024,
  });
  assert.throws(
    () => parseAttachmentStagingCapability({ version: 1, sources: [], locations: [], maxBytes: 0 }),
    /unsupported or incompatible/i,
  );
});

test("Thread lifecycle capability requires a known version and explicit operation flags", () => {
  assert.equal(parseThreadLifecycleCapability(undefined), null);
  assert.equal(parseThreadLifecycleCapability({ version: 2, fork: true }), null);
  assert.deepEqual(parseThreadLifecycleCapability({ version: 1, fork: true }), {
    version: 1,
    fork: true,
    ephemeralFork: false,
    ephemeral: false,
    injectItems: false,
    unsubscribe: false,
    rename: false,
    archive: false,
    delete: false,
  });
  assert.equal(parseThreadLifecycleCapability({ version: 1, fork: "true" })?.fork, false);
});

test("legacy Resume keeps turns in the response", () => {
  assert.deepEqual(buildResumeHistoryRequest({
    useTailHydration: false,
    isDurableHost: false,
    supportsPaginatedHistory: false,
  }), {
    excludeTurns: false,
  });
});

test("ordinary tail hydration asks Resume for the newest five full Turns", () => {
  assert.deepEqual(buildResumeHistoryRequest({
    useTailHydration: true,
    isDurableHost: false,
    supportsPaginatedHistory: false,
  }), {
    excludeTurns: true,
    initialTurnsPage: {
      limit: 5,
      itemsView: "full",
      sortDirection: "desc",
    },
  });
});

test("paginated history receives cursor heads instead of an initial Resume page", () => {
  assert.deepEqual(buildResumeHistoryRequest({
    useTailHydration: true,
    isDurableHost: false,
    supportsPaginatedHistory: true,
  }), {
    excludeTurns: true,
  });
});

test("Durable history is loaded outside Resume", () => {
  assert.deepEqual(buildResumeHistoryRequest({
    useTailHydration: true,
    isDurableHost: true,
    supportsPaginatedHistory: true,
  }), {
    excludeTurns: true,
  });
});


test("advertised initial-page support also applies to durable providers", () => {
  assert.deepEqual(buildResumeHistoryRequest({ useTailHydration: true, isDurableHost: true,
    supportsPaginatedHistory: false, supportsInitialTurnsPage: true }), {
    excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
  });
});
