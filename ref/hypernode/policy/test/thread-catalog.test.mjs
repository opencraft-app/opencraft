import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCatalogStatuses } from "../src/services/thread-catalog.ts";

test("thread catalog reconciliation announces authoritative status once and on change", () => {
  const notifications = [];
  const ctx = {
    appServer: {
      notifyAfter(_connection, method, params) {
        notifications.push({ method, params });
      },
    },
  };
  const connection = {};

  reconcileCatalogStatuses(ctx, connection, [
    { id: "thread-idle", status: { type: "idle" } },
    { id: "thread-default" },
  ]);
  reconcileCatalogStatuses(ctx, connection, [
    { id: "thread-idle", status: { type: "idle" } },
    { id: "thread-default" },
  ]);
  reconcileCatalogStatuses(ctx, connection, [
    { id: "thread-idle", status: { type: "active", activeFlags: [] } },
  ]);

  assert.deepEqual(notifications, [
    {
      method: "thread/status/changed",
      params: { threadId: "thread-idle", status: { type: "idle" } },
    },
    {
      method: "thread/status/changed",
      params: { threadId: "thread-default", status: { type: "idle" } },
    },
    {
      method: "thread/status/changed",
      params: { threadId: "thread-idle", status: { type: "active", activeFlags: [] } },
    },
  ]);
});
