import test from "node:test";
import assert from "node:assert/strict";
import {
  groupCreateOptions,
  installCommunicationExtension,
} from "../../packages/access-control/src/communication-extension";

const label = { id: "fixture.option", defaultMessage: "Fixture option" };

test("malformed group creation declarations fail at installation and install nothing", () => {
  for (const groupCreateOptions of [
    [{ id: "Upper", label, defaultSelected: false }],
    [{ id: "core-route", label: { id: "has space", defaultMessage: "x" }, defaultSelected: false }],
    [{ id: "empty", label: { id: "fixture.empty", defaultMessage: "" }, defaultSelected: false }],
    [{ id: "no-default", label }],
    [
      { id: "twice", label, defaultSelected: true },
      { id: "twice", label, defaultSelected: false },
    ],
    Array.from({ length: 9 }, (_, index) => ({ id: "option-" + index, label, defaultSelected: false })),
  ])
    assert.throws(
      () => installCommunicationExtension({ groupCreateOptions } as never),
      /Invalid group creation options/,
    );
  assert.deepEqual(groupCreateOptions(), []);
  const valid = { groupCreateOptions: [{ id: "linked-group", label, defaultSelected: true }] };
  installCommunicationExtension(valid);
  assert.deepEqual(groupCreateOptions(), valid.groupCreateOptions);
});
