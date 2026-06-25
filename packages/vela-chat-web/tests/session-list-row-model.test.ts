import assert from "node:assert/strict";
import test from "node:test";

import type { SessionListItemWire } from "../../vela-chat-client/src";
import { buildSessionListRowModel } from "../src/session-list/sessionListRowModel";

const baseSession: SessionListItemWire = {
  id: "ses_model",
  title: "Model row",
  backend: "codex",
  status: "idle",
  working_directory: "/Users/skipzhang/code/velaChat",
  created_at: "2026-06-25T00:00:00.000Z",
  updated_at: "2026-06-25T00:00:00.000Z",
  last_activity_at: "2026-06-25T00:00:00.000Z",
  preview: "A modeled session row",
  pending_request_count: 0,
  running: false,
  model: "gpt-5.3",
};

test("session list rail suppresses fresh minute-level time", () => {
  const row = buildSessionListRowModel(
    {
      ...baseSession,
      last_activity_at: "2026-06-25T00:08:00.000Z",
    },
    undefined,
    { nowMs: Date.parse("2026-06-25T00:10:00.000Z") },
  );

  assert.equal(row.rail, null);
});

test("session list rail uses compact coarse labels after the fresh window", () => {
  const nowMs = Date.parse("2026-06-25T12:00:00.000Z");

  assert.deepEqual(
    buildSessionListRowModel(
      { ...baseSession, last_activity_at: "2026-06-25T11:48:00.000Z" },
      undefined,
      { nowMs },
    ).rail,
    { label: "12分", recency: "minutes" },
  );
  assert.deepEqual(
    buildSessionListRowModel(
      { ...baseSession, last_activity_at: "2026-06-25T09:00:00.000Z" },
      undefined,
      { nowMs },
    ).rail,
    { label: "3时", recency: "hours" },
  );
  assert.deepEqual(
    buildSessionListRowModel(
      { ...baseSession, last_activity_at: "2026-06-23T12:00:00.000Z" },
      undefined,
      { nowMs },
    ).rail,
    { label: "2天", recency: "days" },
  );
});
