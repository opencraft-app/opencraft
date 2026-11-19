import { createHash } from 'node:crypto';
import { occupied } from '../remote-browser-state-file.mjs';

// Immutable owner tree: publishing one account preserves old snapshots without
// copying the other accounts. Deterministic hash priorities balance the tree.
const count = node => node?.used ?? 0;
const weights = new WeakMap();
function weight(account) {
  if (!weights.has(account)) weights.set(account, account.pages.filter(occupied).length);
  return weights.get(account);
}
function node(key, value, priority, left = null, right = null) {
  return { key, value, priority, left, right,
    used: count(left) + count(right) + weight(value),
    pageCount: (left?.pageCount ?? 0) + (right?.pageCount ?? 0) + value.pages.length };
}
function put(root, key, value, priority) {
  if (!root) return node(key, value, priority);
  if (key === root.key) return node(key, value, root.priority, root.left, root.right);
  if (key < root.key) {
    const left = put(root.left, key, value, priority);
    const next = node(root.key, root.value, root.priority, left, root.right);
    return left.priority < next.priority
      ? node(left.key, left.value, left.priority, left.left, node(next.key, next.value, next.priority, left.right, next.right)) : next;
  }
  const right = put(root.right, key, value, priority);
  const next = node(root.key, root.value, root.priority, root.left, right);
  return right.priority < next.priority
    ? node(right.key, right.value, right.priority, node(next.key, next.value, next.priority, next.left, right.left), right.right) : next;
}
function* entries(root) {
  if (!root) return;
  yield* entries(root.left); yield [root.key, root.value]; yield* entries(root.right);
}
function* pages(root) {
  if (!root?.pageCount) return;
  yield* pages(root.left); yield* root.value.pages; yield* pages(root.right);
}
export class AccountDirectory {
  constructor(root = null) { this.root = root; }
  get used() { return count(this.root); }
  get(key) {
    let root = this.root;
    while (root) { if (key === root.key) return root.value; root = key < root.key ? root.left : root.right; }
  }
  page(key) {
    const identity = JSON.parse(key);
    if (!Array.isArray(identity) || typeof identity[0] !== "string") throw Error("Invalid browser resource key");
    return this.get(identity[0])?.pages.find(page => page.key === key);
  }
  set(key, value) {
    return new AccountDirectory(put(this.root, key, value, createHash('sha256').update(key).digest('hex')));
  }
  projection(base) {
    const snapshot = { ...base };
    for (const field of ['pages', 'states', 'closedTabs']) {
      let cache;
      Object.defineProperty(snapshot, field, { enumerable: true, get: () => cache ??= field === 'pages' ? [...pages(this.root)] : [...entries(this.root)].flatMap(([, account]) => account[field]) });
    }
    return snapshot;
  }
}
