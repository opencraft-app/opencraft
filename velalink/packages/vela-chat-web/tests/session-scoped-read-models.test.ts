import assert from "node:assert/strict";
import test from "node:test";

import {
  isCurrentSessionRequest,
  pendingRequestsForActiveSession,
  readModelForActiveSession,
} from "../../vela-chat-controller/src/sessionScopedReadModels";

test("read model envelopes are only usable for the active session", () => {
  const transcript = {
    session_id: "sess_active",
    rows: [],
    cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
  };

  assert.equal(readModelForActiveSession("sess_active", transcript), transcript);
  assert.equal(readModelForActiveSession("sess_other", transcript), null);
  assert.equal(readModelForActiveSession("", transcript), null);
  assert.equal(readModelForActiveSession("sess_active", null), null);
});

test("pending request views reject request rows from another session", () => {
  const requests = {
    requests: [
      {
        id: "req_1",
        session_id: "sess_active",
        type: "tool_confirmation",
        status: "pending",
        created_at: "2026-06-20T00:00:00Z",
      },
    ],
    cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
  };
  const staleRequests = {
    ...requests,
    requests: [
      {
        ...requests.requests[0]!,
        session_id: "sess_other",
      },
    ],
  };

  assert.equal(pendingRequestsForActiveSession("sess_active", requests), requests);
  assert.equal(pendingRequestsForActiveSession("sess_active", staleRequests), null);
  assert.equal(
    pendingRequestsForActiveSession("sess_active", {
      requests: [],
      cursor: { event_id: "evt_empty_from_unknown_session", epoch: 1, seq: 2 },
    }),
    null,
  );
  assert.equal(pendingRequestsForActiveSession("", requests), null);
  assert.equal(pendingRequestsForActiveSession("sess_active", null), null);
});

test("late async responses are ignored after the active session changes", () => {
  assert.equal(isCurrentSessionRequest("sess_active", "sess_active"), true);
  assert.equal(isCurrentSessionRequest("sess_next", "sess_active"), false);
  assert.equal(isCurrentSessionRequest("", "sess_active"), false);
});
