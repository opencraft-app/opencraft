import assert from "node:assert/strict";
import test from "node:test";
import { WebConversationViewportOwner } from "@opencraft/timeline-host-web";

function fixture() {
  const values = new Map<string, [string, string]>();
  const events: string[] = [];
  const style = {
    getPropertyValue: (key: string) => values.get(key)?.[0] ?? "",
    getPropertyPriority: (key: string) => values.get(key)?.[1] ?? "",
    setProperty(key: string, value: string, priority = "") { events.push(`set:${key}`); values.set(key, [value, priority]); },
    removeProperty(key: string) { events.push(`remove:${key}`); values.delete(key); return ""; },
  } as unknown as CSSStyleDeclaration;
  let height = 17042, connected = true, fail = false, reads = 0;
  const spacer = { style, get offsetHeight() {
    reads++;
    events.push("measure");
    if (fail) throw new Error("measurement failed");
    return height;
  } } as HTMLElement;
  const root = { clientHeight: 690, scrollHeight: 17208, scrollTop: -16518, style,
    contains: (element: unknown) => connected && element === spacer,
    scrollTo: () => assert.fail("handoffs must not acquire scroll-write ownership"),
  } as unknown as HTMLDivElement;
  const owner = new WebConversationViewportOwner(16518);
  owner.scrollElementRef.current = root;
  return { owner, root, spacer, events, get reads() { return reads; },
    resize: (next: number) => { height = next; },
    detach: () => { connected = false; },
    fail: () => { fail = true; },
  };
}

test("a window handoff resolves replacement layout before releasing its height, without rewinding user movement", () => {
  const f = fixture();
  const lease = f.owner.protectWindowHandoff(f.spacer)!;
  assert.equal(f.spacer.style.getPropertyValue("min-height"), "17042px");
  f.resize(21981);
  f.root.scrollTop += 40; // Physical motion whose scroll receipt has not reached JS.
  lease.complete();
  assert.equal(f.root.scrollTop, -16478);
  assert.equal(f.spacer.style.getPropertyValue("min-height"), "");
  assert.deepEqual(f.events, ["measure", "set:min-height", "measure", "remove:min-height"]);
  lease.complete(); lease.cancel();
  assert.equal(f.reads, 2, "completion/cancellation is idempotent");
  f.owner.dispose();
});

test("handoff cancellation restores an existing minimum and priority without measuring", () => {
  const f = fixture();
  f.spacer.style.setProperty("min-height", "25px", "important");
  const lease = f.owner.protectWindowHandoff(f.spacer)!;
  lease.cancel();
  assert.equal(f.spacer.style.getPropertyValue("min-height"), "25px");
  assert.equal(f.spacer.style.getPropertyPriority("min-height"), "important");
  assert.equal(f.reads, 1);
  f.owner.dispose();
});

test("a replaced handoff cannot retire the replacement's protection", () => {
  const f = fixture();
  const previous = f.owner.protectWindowHandoff(f.spacer)!;
  f.resize(20000);
  const replacement = f.owner.protectWindowHandoff(f.spacer)!;
  previous.complete(); previous.cancel();
  assert.equal(f.spacer.style.getPropertyValue("min-height"), "20000px");
  replacement.complete();
  assert.equal(f.spacer.style.getPropertyValue("min-height"), "");
  f.owner.dispose();
});

for (const retirement of ["detach", "dispose", "replace-port"] as const) {
  test(`a ${retirement} retires protection without a stale geometry read`, () => {
    const f = fixture();
    const lease = f.owner.protectWindowHandoff(f.spacer)!;
    if (retirement === "detach") f.detach();
    else if (retirement === "dispose") f.owner.dispose();
    else f.owner.attachScrollElement(null);
    lease.complete();
    assert.equal(f.reads, 1);
    assert.equal(f.spacer.style.getPropertyValue("min-height"), "");
    f.owner.dispose();
  });
}

test("failed replacement layout still releases the floor", () => {
  const f = fixture();
  const lease = f.owner.protectWindowHandoff(f.spacer)!;
  f.fail();
  assert.throws(() => lease.complete(), /measurement failed/u);
  assert.equal(f.spacer.style.getPropertyValue("min-height"), "");
  lease.complete();
  assert.equal(f.reads, 2);
  f.owner.dispose();
});

test("parking a visible viewport retires its reservation without measuring the hidden child", () => {
  const f = fixture();
  const lease = f.owner.protectWindowHandoff(f.spacer)!;
  Reflect.set(f.root, "clientHeight", 0);
  lease.complete();
  assert.equal(f.reads, 1);
  assert.equal(f.spacer.style.getPropertyValue("min-height"), "");
  f.owner.dispose();
});

test("retirement does not overwrite an unrelated style writer", () => {
  const f = fixture();
  const lease = f.owner.protectWindowHandoff(f.spacer)!;
  f.spacer.style.setProperty("min-height", "50px");
  lease.cancel();
  assert.equal(f.spacer.style.getPropertyValue("min-height"), "50px");
  f.owner.dispose();
});

test("retirement respects a replacement priority even when the numeric height is unchanged", () => {
  const f = fixture();
  const lease = f.owner.protectWindowHandoff(f.spacer)!;
  f.spacer.style.setProperty("min-height", "17042px", "important");
  lease.cancel();
  assert.equal(f.spacer.style.getPropertyPriority("min-height"), "important");
  f.owner.dispose();
});

test("hidden, unowned and disposed viewports do not start a geometry transaction", () => {
  const f = fixture();
  Reflect.set(f.root, "clientHeight", 0);
  assert.equal(f.owner.protectWindowHandoff(f.spacer), null);
  Reflect.set(f.root, "clientHeight", 690);
  f.detach();
  assert.equal(f.owner.protectWindowHandoff(f.spacer), null);
  f.owner.dispose();
  assert.equal(f.owner.protectWindowHandoff(f.spacer), null);
  assert.equal(f.reads, 0);
});
