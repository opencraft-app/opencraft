import assert from "node:assert/strict";
import test from "node:test";
import { WebConversationViewportOwner } from "../../packages/timeline-host-web/src/conversation-viewport-owner";

test("partial-row reflow uses the visible text, not the entire row height delta", () => {
  const owner = new WebConversationViewportOwner(350);
  let y = 30,
    rowHeight = 1200,
    width = 390,
    scale = 1,
    attached = true;
  const text = { getBoundingClientRect: () => ({ top: y, bottom: y + 22, width: 300 }) };
  const root = {
    scrollTop: -350,
    clientHeight: 844,
    scrollHeight: 2400,
    get clientWidth() {
      return width;
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 844 * scale, height: 844 * scale }),
    contains: (node: unknown) => node === text && attached,
  } as unknown as HTMLDivElement;
  const row = {
    get offsetHeight() {
      return rowHeight;
    },
    getBoundingClientRect: () => ({ top: -100, bottom: 1100 }),
    querySelectorAll: () => [text],
    contains: (node: unknown) => node === text,
  } as unknown as HTMLDivElement;
  owner.scrollElementRef.current = root;
  owner.turnElementsRef.current.set("turn", row);
  owner.captureReadingAnchor({ turn: 1200 });
  assert.equal(owner.readingAnchorDistance(), 350);
  // A shrinking resource above the reader leaves their paragraph stationary
  // in bottom-relative flow. Applying the row's -180 delta would move it.
  rowHeight = 1020;
  assert.equal(owner.readingAnchorDistance(), 350);
  // A resize below the paragraph does move it: compensate exactly that offset.
  y += 60;
  owner.captureReadingAnchor({ turn: 1200 }); // stale measurement cannot overwrite anchor
  assert.equal(owner.readingAnchorDistance(), 290);
  root.scrollTop = -290;
  y = 30;
  owner.captureReadingAnchor({ turn: 1020 });
  assert.equal(owner.readingAnchorDistance(), 290);
  width = 400;
  assert.equal(owner.readingAnchorDistance(), null);
  width = 390;
  scale = 0.5;
  assert.equal(owner.readingAnchorDistance(), null);
  scale = 1;
  attached = false;
  assert.equal(owner.readingAnchorDistance(), null);
  attached = true;
  root.scrollTop = 0;
  assert.equal(owner.readingAnchorDistance(), null);
  root.scrollTop = -350;
  owner.captureReadingAnchor({ turn: 1020 });
  // Input/targeting can publish a new position before React samples its anchor.
  // A resize in that interval must not pull the reader back to the old one.
  root.scrollTop = -420;
  owner.scrollController.reportPlatformScroll("user");
  assert.equal(owner.readingAnchorDistance(), null);
});

test("empty timelines do not force layout and retire the previous reading anchor", () => {
  const owner = new WebConversationViewportOwner(350);
  const text = { getBoundingClientRect: () => ({ top: 30, bottom: 52, width: 300 }) };
  const root = {
    scrollTop: -350,
    clientHeight: 844,
    clientWidth: 390,
    getBoundingClientRect: () => ({ top: 0, bottom: 844, height: 844 }),
    contains: () => true,
  } as unknown as HTMLDivElement;
  owner.scrollElementRef.current = root;
  owner.turnElementsRef.current.set("turn", {
    offsetHeight: 1200,
    getBoundingClientRect: () => ({ top: -100, bottom: 1100 }),
    querySelectorAll: () => [text],
    contains: (node: unknown) => node === text,
  } as unknown as HTMLDivElement);
  owner.captureReadingAnchor({ turn: 1200 });
  assert.equal(owner.readingAnchorDistance(), 350);
  owner.turnElementsRef.current.clear();
  const noGeometry = new Proxy(root, {
    get() {
      throw new Error("unexpected layout read");
    },
  });
  owner.scrollElementRef.current = noGeometry;
  owner.captureReadingAnchor({});
  owner.scrollElementRef.current = root;
  assert.equal(owner.readingAnchorDistance(), null);
});

test("an active scroll animation skips anchor geometry reads", () => {
  const owner = new WebConversationViewportOwner(350);
  owner.scrollElementRef.current = new Proxy(
    {},
    {
      get() {
        throw new Error("unexpected layout read");
      },
    },
  ) as HTMLDivElement;
  owner.turnElementsRef.current.set("turn", {} as HTMLDivElement);
  owner.scrollController.getState = () =>
    ({ isScrollAnimationActive: true }) as ReturnType<typeof owner.scrollController.getState>;
  owner.captureReadingAnchor({ turn: 1200 });
});

function retainedAnchorFixture() {
  const owner = new WebConversationViewportOwner(350);
  let y = 30,
    rowHeight = 1200,
    queries = 0,
    attached = true;
  const text = { getBoundingClientRect: () => ({ top: y, bottom: y + 22, width: 300 }) };
  const root = {
    scrollTop: -350,
    clientHeight: 844,
    clientWidth: 390,
    scrollHeight: 2400,
    getBoundingClientRect: () => ({ top: 0, bottom: 844, height: 844 }),
    contains: (node: unknown) => attached && node === text,
  } as unknown as HTMLDivElement;
  const row = {
    get offsetHeight() {
      return rowHeight;
    },
    getBoundingClientRect: () => ({ top: -100, bottom: 1100 }),
    contains: (node: unknown) => attached && node === text,
    querySelectorAll: () => {
      queries++;
      return [text];
    },
  } as unknown as HTMLDivElement;
  owner.scrollElementRef.current = root;
  owner.turnElementsRef.current.set("turn", row);
  const heights = { turn: 1200 };
  owner.captureReadingAnchor(heights);
  return {
    owner,
    root,
    row,
    heights,
    queries: () => queries,
    move: (value: number) => {
      y = value;
    },
    resize: (value: number) => {
      rowHeight = value;
    },
    detach: () => {
      attached = false;
    },
  };
}

test("stable mounted reading text avoids repeated paragraph and row scans", () => {
  const f = retainedAnchorFixture();
  assert.equal(f.queries(), 1);
  f.row.getBoundingClientRect = () => {
    throw new Error("stable anchor must not scan rows");
  };
  f.owner.captureReadingAnchor(f.heights);
  f.owner.captureReadingAnchor({ ...f.heights });
  assert.equal(f.queries(), 1);
  assert.equal(f.owner.readingAnchorDistance(), 350);
});

test("unmeasured reflow retains the old text position until compensation", () => {
  const f = retainedAnchorFixture();
  f.move(90);
  f.resize(1260);
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 1, "unmeasured row must not replace the pre-reflow text");
  assert.equal(f.owner.readingAnchorDistance(), 290);
  f.root.scrollTop = -290;
  f.move(30);
  f.owner.captureReadingAnchor({ turn: 1260 });
  assert.equal(f.queries(), 2);
  assert.equal(f.owner.readingAnchorDistance(), 290);
});

test("scroll and viewport changes recapture; layout movement preserves the original reading position", () => {
  const f = retainedAnchorFixture();
  f.root.scrollTop = -400;
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 2, "physical scroll invalidates even before its native event");
  Object.defineProperty(f.root, "clientWidth", { value: 400 });
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 3);
  f.move(50);
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 3, "same-height movement retains the pre-reflow text top");
  assert.equal(f.owner.readingAnchorDistance(), 380);
  f.root.scrollTop = -380;
  f.move(30);
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 4);
  assert.equal(f.owner.readingAnchorDistance(), 380);
});

test("retired rows and detached text cannot reuse the previous anchor", () => {
  const f = retainedAnchorFixture();
  const replacement = { ...f.row } as HTMLDivElement;
  f.owner.turnElementsRef.current.set("turn", replacement);
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 2, "same Turn key does not mean same mounted row");
  f.detach();
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 3);
  assert.equal(f.owner.readingAnchorDistance(), null);
});

test("reflow in another Turn cannot replace a text anchor moved outside the viewport", () => {
  const f = retainedAnchorFixture();
  f.move(-170);
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 1);
  assert.equal(f.owner.readingAnchorDistance(), 550);
  f.root.scrollTop = -550;
  f.move(30);
  f.owner.captureReadingAnchor(f.heights);
  assert.equal(f.queries(), 2);
  assert.equal(f.owner.readingAnchorDistance(), 550);
});

test("unreported inertia is excluded from text-layout correction", () => {
  const f = retainedAnchorFixture();
  f.root.scrollTop = -390;
  f.move(70); // +40px distance moves the text +40px
  assert.equal(f.owner.readingAnchorDistance(), 390, "preserve pending user movement");
  f.move(100); // another +30px is actual content reflow
  assert.equal(f.owner.readingAnchorDistance(), 360, "only the 30px layout delta is corrected");
});

test("text-anchor correction retains momentum between its sample and commit", () => {
  const f = retainedAnchorFixture();
  f.root.scrollTop = -390;
  f.move(100); // 40px scroll + 30px layout
  const correction = f.owner.readingAnchorCorrection()!;
  assert.deepEqual(correction, { distanceFromBottomPx: 360, baseDistanceFromBottomPx: 390 });
  f.root.scrollTo = ((options: ScrollToOptions) => {
    f.root.scrollTop = options.top!;
  }) as typeof f.root.scrollTo;
  f.root.scrollTop = -410; // another 20px arrives before the measurement commit
  f.owner.scrollController.compensateLayoutToDistanceFromBottomPx(
    correction.distanceFromBottomPx,
    correction.baseDistanceFromBottomPx,
  );
  assert.equal(f.root.scrollTop, -380, "retain both user movements and compensate only the -30px layout delta");
});
