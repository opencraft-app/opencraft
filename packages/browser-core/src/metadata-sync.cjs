"use strict";
const { canonical, mergeMetadataValue } = require("./metadata-merge.cjs");
// Portable browser-metadata reconciliation helpers shared by the Server and Web
// client. SHA-256 is a content fingerprint for anti-entropy, never authority.
const BROWSER_METADATA_FIELDS = Object.freeze(["bindings", "pages", "resourceSignals", "sideChats", "storage", "tabs"]);
const PUSH_INLINE_LIMIT = 64 * 1024;

const K = [],
  H0 = [];
for (let p = 2; K.length < 64; p++) {
  let prime = true;
  for (let d = 2; d * d <= p; d++)
    if (p % d === 0) {
      prime = false;
      break;
    }
  if (!prime) continue;
  if (H0.length < 8) H0.push(((Math.sqrt(p) % 1) * 0x100000000) | 0);
  K.push(((Math.cbrt(p) % 1) * 0x100000000) | 0);
}
function utf8(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  return Uint8Array.from(Buffer.from(text, "utf8"));
}
function sha256(text) {
  const bytes = utf8(text),
    size = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(size);
  data.set(bytes);
  data[bytes.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(size - 4, bytes.length * 8);
  const state = H0.slice(),
    w = new Int32Array(64);
  const rotate = (x, n) => (x >>> n) | (x << (32 - n));
  for (let at = 0; at < size; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        (w[i - 16] +
          (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
          w[i - 7] +
          (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) |
        0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => {
      state[i] = (state[i] + v) | 0;
    });
  }
  return state.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}
/** Leaf = one metadata field. Missing fields hash as the empty leaf. */
function metadataLeafHash(key, value, hash = sha256) {
  return hash("browser-metadata-leaf-v1:" + key + ":" + (typeof value === "string" ? value : ""));
}
/** Root over the fixed, sorted field set; revisions make stale-equal content still diverge. */
function metadataRoot(leaves, hash = sha256) {
  return hash(
    "browser-metadata-root-v1:" +
      BROWSER_METADATA_FIELDS.map((key) => {
        const leaf = leaves[key];
        return (
          key + ":" + (leaf ? leaf.keyRevision : 0) + ":" + (leaf ? leaf.hash : metadataLeafHash(key, undefined, hash))
        );
      }).join("\n"),
  );
}
function metadataLeaves(values, keyRevisions, hash = sha256) {
  return Object.fromEntries(
    BROWSER_METADATA_FIELDS.map((key) => [
      key,
      {
        keyRevision: (keyRevisions && keyRevisions[key]) || 0,
        hash: metadataLeafHash(key, values ? values[key] : undefined, hash),
      },
    ]),
  );
}

module.exports = {
  BROWSER_METADATA_FIELDS,
  PUSH_INLINE_LIMIT,
  sha256,
  canonical,
  metadataLeafHash,
  metadataRoot,
  metadataLeaves,
  mergeMetadataValue,
};
