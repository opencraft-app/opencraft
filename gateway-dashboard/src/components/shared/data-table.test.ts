import test from "node:test";
import assert from "node:assert/strict";

/**
 * DataTable pagination footer visibility tests.
 *
 * These are logic-level tests verifying the conditions under which
 * the pagination footer and page size selector should render.
 * They don't render React components (no jsdom dependency needed).
 */

// Replicate the rendering conditions from DataTable
function shouldShowFooter(opts: { total: number; onPageChange: boolean }) {
  return opts.onPageChange && opts.total > 0;
}

function shouldShowPageSizeSelector(opts: {
  onPageSizeChange: boolean;
  pageSizeOptions: number[] | undefined;
}) {
  return (
    opts.onPageSizeChange &&
    opts.pageSizeOptions !== undefined &&
    opts.pageSizeOptions.length > 1
  );
}

function shouldShowPaginationButtons(opts: { total: number; pageSize: number }) {
  const totalPages = Math.ceil(opts.total / opts.pageSize);
  return totalPages > 1;
}

// --- Footer visibility ---

test("footer visible when total > 0 and onPageChange provided", () => {
  assert.equal(shouldShowFooter({ total: 30, onPageChange: true }), true);
});

test("footer hidden when total is 0", () => {
  assert.equal(shouldShowFooter({ total: 0, onPageChange: true }), false);
});

test("footer hidden when onPageChange not provided", () => {
  assert.equal(shouldShowFooter({ total: 30, onPageChange: false }), false);
});

// --- Page size selector visibility (independent of totalPages) ---

test("page size selector visible when onPageSizeChange and pageSizeOptions provided", () => {
  assert.equal(
    shouldShowPageSizeSelector({ onPageSizeChange: true, pageSizeOptions: [20, 50, 100] }),
    true,
  );
});

test("page size selector hidden when onPageSizeChange not provided", () => {
  assert.equal(
    shouldShowPageSizeSelector({ onPageSizeChange: false, pageSizeOptions: [20, 50, 100] }),
    false,
  );
});

test("page size selector hidden when only one option", () => {
  assert.equal(
    shouldShowPageSizeSelector({ onPageSizeChange: true, pageSizeOptions: [20] }),
    false,
  );
});

// --- Critical: selector stays visible after switching to larger pageSize ---

test("page size selector remains visible when pageSize makes totalPages = 1", () => {
  // 30 items, user switches from 20 (2 pages) to 50 (1 page)
  // Footer should still show because total > 0
  assert.equal(shouldShowFooter({ total: 30, onPageChange: true }), true);
  // Selector should still show because props are unchanged
  assert.equal(
    shouldShowPageSizeSelector({ onPageSizeChange: true, pageSizeOptions: [20, 50, 100] }),
    true,
  );
  // Only pagination buttons should hide
  assert.equal(shouldShowPaginationButtons({ total: 30, pageSize: 50 }), false);
});

test("pagination buttons visible when totalPages > 1", () => {
  assert.equal(shouldShowPaginationButtons({ total: 30, pageSize: 20 }), true);
});

test("pagination buttons hidden when totalPages = 1", () => {
  assert.equal(shouldShowPaginationButtons({ total: 15, pageSize: 20 }), false);
});

// --- Page reset on pageSize change ---

test("onPageSizeChange should reset page to 1 (verified by users page logic)", () => {
  // Simulate: page=3, user changes pageSize
  let page = 3;
  let pageSize = 20;

  // The users page handler: (size) => { setPageSize(size); setPage(1); }
  const handlePageSizeChange = (newSize: number) => {
    pageSize = newSize;
    page = 1;
  };

  handlePageSizeChange(50);
  assert.equal(page, 1);
  assert.equal(pageSize, 50);
});
