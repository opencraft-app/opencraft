import assert from "node:assert/strict";
import test from "node:test";
import { TouchContactCoordinator } from "../../packages/design-system-web/src/touch-contact";

test("Composer contact coordinator admits one owner and retires only its contact", () => {
  const contacts = new TouchContactCoordinator();
  assert.equal(contacts.claim(4, "editor", 10), true);
  assert.deepEqual(contacts.active, { id: 4, origin: "editor", startedAt: 10 });
  assert.equal(contacts.claim(4, "menu"), false, "one physical contact cannot change owner");
  assert.equal(contacts.claim(5, "menu"), false, "a second contact cannot steal the first lease");
  contacts.release(5);
  assert.equal(contacts.owns(4, "editor"), true);
  contacts.release(4);
  assert.equal(contacts.active, null);
  assert.equal(contacts.claim(5, "menu", 20), true);
});

test("Composer contact cancellation is idempotent and origin-scoped", () => {
  const contacts = new TouchContactCoordinator();
  assert.equal(contacts.claim(1, "microphone"), true);
  assert.equal(contacts.owns(1, "editor"), false);
  contacts.cancel(2);
  assert.equal(contacts.owns(1, "microphone"), true);
  contacts.cancel(1);
  contacts.cancel(1);
  assert.equal(contacts.active, null);
});
