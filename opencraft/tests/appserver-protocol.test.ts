import assert from "node:assert/strict";
import test from "node:test";

import { buildResumeHistoryRequest } from "@opencraft/appserver-protocol";

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
