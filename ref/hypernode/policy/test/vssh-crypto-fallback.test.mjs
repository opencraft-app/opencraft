import assert from "node:assert/strict";
import test from "node:test";

import { vsshCryptoForTest as crypto } from "../src/services/vssh.js";

const fromHex = (value) => Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
const toHex = (value) => Buffer.from(value).toString("hex");

test("standalone policy uses the pure JavaScript crypto fallback", () => {
  assert.equal(crypto.native, false);
});

test("fallback SHA-256 and HMAC-SHA256 match fixed vectors", async () => {
  const abc = Uint8Array.of(97, 98, 99);
  assert.equal(toHex(await crypto.sha256(abc)),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(toHex(crypto.hmacSha256(Uint8Array.of(1, 2, 3), abc)),
    "200fd2f9dada90b91212225a6b5e5975512edffd02503bb98ea612ca904daa24");
});

test("fallback AES-128-CTR preserves stream state across packet-shaped updates", () => {
  const key = fromHex("2b7e151628aed2a6abf7158809cf4f3c");
  const iv = fromHex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
  const plain = fromHex(
    "6bc1bee22e409f96e93d7e117393172a" +
    "ae2d8a571e03ac9c9eb76fac45af8e51" +
    "30c81c46a35ce411e5fbc1191a0a52ef" +
    "f69f2445df4f9b17ad2b417be66c3710",
  );
  const cipher = crypto.createCipheriv(key, iv);
  const encrypted = Buffer.concat([
    Buffer.from(cipher.update(plain.slice(0, 4))),
    Buffer.from(cipher.update(plain.slice(4))),
  ]);
  assert.equal(encrypted.toString("hex"),
    "874d6191b620e3261bef6864990db6ce" +
    "9806f66b7970fdff8617187bb9fffdff" +
    "5ae4df3edbd5d35e5b4f09020db03eab" +
    "1e031dda2fbe03d1792170a0f3009cee");
});

test("fallback Ed25519 matches RFC 8032 test vector 1", () => {
  const privateKey = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  const publicKey = fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const signature = crypto.signEd25519(privateKey, new Uint8Array());
  assert.equal(toHex(signature),
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
    "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  assert.equal(crypto.verifyEd25519(publicKey, new Uint8Array(), signature), true);
});
