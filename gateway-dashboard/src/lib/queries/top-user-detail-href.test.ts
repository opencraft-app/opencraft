import test from "node:test";
import assert from "node:assert/strict";
import { getTopUserDetailHref } from "./top-user-detail-href.ts";

test("getTopUserDetailHref uses business user_id instead of internal id", () => {
  const href = getTopUserDetailHref({
    user_id: "usr_000001",
  });

  assert.equal(href, "/users/usr_000001");
});

test("getTopUserDetailHref returns null when user_id is blank", () => {
  const href = getTopUserDetailHref({
    user_id: "   ",
  });

  assert.equal(href, null);
});
