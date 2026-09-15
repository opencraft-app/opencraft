import { Service } from "@deepseek-ai/cordis";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import aesjs from "aes-js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { hmac as nobleHmac } from "@noble/hashes/hmac";

const VERSION = "SSH-2.0-Hypernode_vSSH_0.1";
const EMPTY = new Uint8Array(0);
const MAX_PACKET = 4 * 1024 * 1024;
const X25519_BASEPOINT = Uint8Array.of(9, ...new Uint8Array(31));
const nativeCrypto = typeof hostCrypto === "object" && hostCrypto !== null ? hostCrypto : null;
const disabledNativeCrypto = new Set();

function tryNative(name, callback) {
  if (!nativeCrypto?.[name] || disabledNativeCrypto.has(name)) return undefined;
  try {
    return callback(nativeCrypto[name]);
  } catch (error) {
    // Native crypto is an optional acceleration surface. A host bridge must
    // never make the SSH protocol unavailable: permanently fuse off the
    // failing primitive for this runtime and continue with the audited JS
    // implementation below.
    disabledNativeCrypto.add(name);
    console.warn(`[vssh] native crypto disabled primitive=${name} reason=${error?.message ?? String(error)}`);
    return undefined;
  }
}

function utf8Encode(value) {
  const output = [];
  for (const character of String(value)) {
    const point = character.codePointAt(0);
    if (point <= 0x7f) output.push(point);
    else if (point <= 0x7ff) output.push(0xc0 | (point >>> 6), 0x80 | (point & 0x3f));
    else if (point <= 0xffff) output.push(0xe0 | (point >>> 12), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
    else output.push(0xf0 | (point >>> 18), 0x80 | ((point >>> 12) & 0x3f), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
  }
  return Uint8Array.from(output);
}

function utf8Decode(value) {
  const input = bytes(value);
  let output = "";
  for (let index = 0; index < input.length;) {
    const first = input[index++];
    if (first < 0x80) output += String.fromCodePoint(first);
    else if (first < 0xe0) output += String.fromCodePoint(((first & 0x1f) << 6) | (input[index++] & 0x3f));
    else if (first < 0xf0) output += String.fromCodePoint(((first & 0x0f) << 12) | ((input[index++] & 0x3f) << 6) | (input[index++] & 0x3f));
    else output += String.fromCodePoint(((first & 7) << 18) | ((input[index++] & 0x3f) << 12) | ((input[index++] & 0x3f) << 6) | (input[index++] & 0x3f));
  }
  return output;
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return utf8Encode(value);
  return Uint8Array.from(value ?? []);
}

function concat(...parts) {
  const normalized = parts.map(bytes);
  const result = new Uint8Array(normalized.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of normalized) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u32(value) {
  return Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

function readU32(value, offset = 0) {
  return (((value[offset] << 24) >>> 0) | (value[offset + 1] << 16) |
    (value[offset + 2] << 8) | value[offset + 3]) >>> 0;
}

function sshString(value) {
  const encoded = bytes(value);
  return concat(u32(encoded.length), encoded);
}

function mpint(value) {
  let encoded = bytes(value);
  while (encoded.length > 0 && encoded[0] === 0) encoded = encoded.slice(1);
  if (encoded.length === 0) return u32(0);
  if ((encoded[0] & 0x80) !== 0) encoded = concat(Uint8Array.of(0), encoded);
  return sshString(encoded);
}

function randomBytes(size) {
  const native = tryNative("randomBytes", (random) => random(size));
  if (native !== undefined) return native;
  const hex = crypto.randomBytes(size);
  return Uint8Array.from({ length: size }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function equal(left, right) {
  const native = tryNative("timingSafeEqual", (timingSafeEqual) => timingSafeEqual(left, right));
  if (native !== undefined) return native;
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function sha256(value) {
  const native = tryNative("createHash", (createHash) => (
    createHash("sha256").update(bytes(value)).digest()
  ));
  if (native !== undefined) return native;
  return nobleSha256(bytes(value));
}

function hmacSha256(key, value) {
  const native = tryNative("createHmac", (createHmac) => (
    createHmac("sha256", bytes(key)).update(bytes(value)).digest()
  ));
  if (native !== undefined) return native;
  return nobleHmac(nobleSha256, bytes(key), bytes(value));
}

function createCipheriv(key, iv, decrypt = false) {
  const primitive = decrypt ? "createDecipheriv" : "createCipheriv";
  const native = tryNative(primitive, (createCipher) => createCipher("aes-128-ctr", key, iv));
  if (native !== undefined) return native;
  const cipher = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(iv));
  return {
    update(value) {
      return Uint8Array.from(decrypt ? cipher.decrypt(value) : cipher.encrypt(value));
    },
    close() {},
  };
}

function deriveX25519(privateKey, publicKey) {
  const native = tryNative("x25519", (x25519Native) => x25519Native(privateKey, publicKey));
  if (native !== undefined) return native;
  return x25519.getSharedSecret(privateKey, publicKey);
}

function signEd25519(privateKey, value) {
  const native = tryNative("ed25519Sign", (sign) => sign(privateKey, value));
  if (native !== undefined) return native;
  return ed25519.sign(value, privateKey);
}

function verifyEd25519(publicKey, value, signature) {
  const native = tryNative("ed25519Verify", (verify) => verify(publicKey, value, signature));
  if (native !== undefined) return native;
  return ed25519.verify(signature, value, publicKey);
}

export const vsshCryptoForTest = {
  native: nativeCrypto !== null,
  sha256,
  hmacSha256,
  createCipheriv,
  deriveX25519,
  signEd25519,
  verifyEd25519,
};

function base64Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(text).replace(/\s+/g, "");
  const output = [];
  for (let index = 0; index < clean.length; index += 4) {
    const a = alphabet.indexOf(clean[index]);
    const b = alphabet.indexOf(clean[index + 1]);
    const c = clean[index + 2] === "=" ? 0 : alphabet.indexOf(clean[index + 2]);
    const d = clean[index + 3] === "=" ? 0 : alphabet.indexOf(clean[index + 3]);
    const value = (a << 18) | (b << 12) | (c << 6) | d;
    output.push((value >>> 16) & 255);
    if (clean[index + 2] !== "=") output.push((value >>> 8) & 255);
    if (clean[index + 3] !== "=") output.push(value & 255);
  }
  return Uint8Array.from(output);
}

function base64Encode(value, padding = true) {
  const input = bytes(value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < input.length; index += 3) {
    const packed = (input[index] << 16) | ((input[index + 1] ?? 0) << 8) | (input[index + 2] ?? 0);
    output += alphabet[(packed >>> 18) & 63] + alphabet[(packed >>> 12) & 63];
    output += index + 1 < input.length ? alphabet[(packed >>> 6) & 63] : "=";
    output += index + 2 < input.length ? alphabet[packed & 63] : "=";
  }
  return padding ? output : output.replace(/=+$/, "");
}

class Reader {
  constructor(value) {
    this.value = bytes(value);
    this.offset = 0;
  }

  byte() {
    if (this.offset >= this.value.length) throw new Error("vSSH truncated byte");
    return this.value[this.offset++];
  }

  uint32() {
    if (this.offset + 4 > this.value.length) throw new Error("vSSH truncated uint32");
    const value = readU32(this.value, this.offset);
    this.offset += 4;
    return value;
  }

  take(size) {
    if (this.offset + size > this.value.length) throw new Error("vSSH truncated bytes");
    const result = this.value.slice(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }

  stringBytes() {
    return this.take(this.uint32());
  }

  string() {
    return utf8Decode(this.stringBytes());
  }

  boolean() {
    return this.byte() !== 0;
  }

  rest() {
    return this.take(this.value.length - this.offset);
  }
}

function parseOpenSSHPrivateKey(pem) {
  const encoded = String.fromCharCode(...bytes(pem))
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----|-----END OPENSSH PRIVATE KEY-----|\s+/g, "");
  const reader = new Reader(base64Decode(encoded));
  const magic = String.fromCharCode(...reader.take(15));
  if (magic !== "openssh-key-v1\0") throw new Error("vSSH host key is not OpenSSH v1");
  if (reader.string() !== "none" || reader.string() !== "none" || reader.stringBytes().length !== 0) {
    throw new Error("vSSH requires an unencrypted host key");
  }
  if (reader.uint32() !== 1) throw new Error("vSSH requires exactly one host key");
  reader.stringBytes();
  const privateReader = new Reader(reader.stringBytes());
  if (privateReader.uint32() !== privateReader.uint32()) throw new Error("vSSH host key checkints differ");
  if (privateReader.string() !== "ssh-ed25519") throw new Error("vSSH requires an Ed25519 host key");
  const publicKey = privateReader.stringBytes();
  const secretKey = privateReader.stringBytes();
  if (publicKey.length !== 32 || secretKey.length !== 64) throw new Error("vSSH Ed25519 host key is malformed");
  return { publicKey, secretKey: secretKey.slice(0, 32) };
}

function deriveKey(shared, exchangeHash, letter, sessionId, length) {
  let output = sha256(concat(mpint(shared), exchangeHash, bytes(letter), sessionId));
  while (output.length < length) output = concat(output, sha256(concat(mpint(shared), exchangeHash, output)));
  return output.slice(0, length);
}

class VSSHConnection {
  constructor(service, metadata) {
    this.service = service;
    this.metadata = metadata;
    this.input = EMPTY;
    this.output = [];
    this.phase = "identification";
    this.clientVersion = null;
    this.clientKexInit = null;
    this.serverKexInit = null;
    this.inboundSequence = 0;
    this.outboundSequence = 0;
    this.inboundCipher = null;
    this.outboundCipher = null;
    this.inboundMac = null;
    this.outboundMac = null;
    this.pendingEncryptedLength = null;
    this.channels = new Map();
    this.nextChannelId = 0;
    this.username = null;
    this.closed = false;
    this.outputSensitive = false;
    this.asyncError = null;
    this.queue(bytes(`${VERSION}\r\n`));
  }

  enqueue(value) {
    const input = Uint8Array.from(value ?? []);
    try {
      this.feed(input);
    } catch (error) {
      this.asyncError = error;
      this.closed = true;
      this.service.audit(this.metadata, "transport.error", {
        phase: this.phase,
        source: "async-feed",
        error: error?.message ?? String(error),
        stack: typeof error?.stack === "string" ? error.stack.slice(0, 4096) : null,
      });
    } finally {
      if (typeof hostEvents === "object" && hostEvents?.notify) hostEvents.notify();
    }
  }

  queue(value) {
    if (value.length > 0) this.output.push(bytes(value));
  }

  closeCrypto() {
    this.inboundCipher?.close?.();
    this.outboundCipher?.close?.();
    this.inboundCipher = null;
    this.outboundCipher = null;
  }

  drain() {
    const result = concat(...this.output);
    this.output = [];
    return result;
  }

  drainDecision() {
    const stdoutBytes = this.drain();
    const sensitive = this.outputSensitive;
    this.outputSensitive = false;
    return { allow: !this.closed, stdoutBytes, sensitive };
  }

  feed(value) {
    this.input = concat(this.input, value);
    if (this.phase === "identification") this.readIdentification();
    while (!this.closed && this.phase !== "identification") {
      const payload = this.readPacket();
      if (!payload) break;
      this.handle(payload);
    }
  }

  readIdentification() {
    const marker = this.input.findIndex((value, index) => value === 10 && index > 0);
    if (marker < 0) return;
    const line = String.fromCharCode(...this.input.slice(0, marker + 1)).trim();
    this.input = this.input.slice(marker + 1);
    if (!line.startsWith("SSH-2.0-")) throw new Error("vSSH requires SSH 2.0");
    this.clientVersion = line;
    this.service.identify(this.metadata, line);
    this.phase = "kex";
    this.sendKexInit();
  }

  sendKexInit() {
    const payload = concat(
      Uint8Array.of(20), randomBytes(16),
      sshString("curve25519-sha256"), sshString("ssh-ed25519"),
      sshString("aes128-ctr"), sshString("aes128-ctr"),
      sshString("hmac-sha2-256"), sshString("hmac-sha2-256"),
      sshString("none"), sshString("none"), sshString(""), sshString(""),
      Uint8Array.of(0), u32(0),
    );
    this.serverKexInit = payload;
    this.sendPacket(payload);
  }

  readPacket() {
    if (!this.inboundCipher) {
      if (this.input.length < 4) return null;
      const packetLength = readU32(this.input);
      if (packetLength < 5 || packetLength > MAX_PACKET || this.input.length < 4 + packetLength) return null;
      const packet = this.input.slice(0, 4 + packetLength);
      this.input = this.input.slice(4 + packetLength);
      return this.packetPayload(packet);
    }
    if (!this.pendingEncryptedLength) {
      if (this.input.length < 4) return null;
      const encrypted = this.input.slice(0, 4);
      this.input = this.input.slice(4);
      const plain = this.inboundCipher.update(encrypted);
      const packetLength = readU32(plain);
      if (packetLength < 5 || packetLength > MAX_PACKET) throw new Error("vSSH encrypted packet length invalid");
      this.pendingEncryptedLength = { packetLength, plain };
    }
    const { packetLength, plain } = this.pendingEncryptedLength;
    if (this.input.length < packetLength + 32) return null;
    const encrypted = this.input.slice(0, packetLength);
    const mac = this.input.slice(packetLength, packetLength + 32);
    this.input = this.input.slice(packetLength + 32);
    this.pendingEncryptedLength = null;
    const packet = concat(plain, this.inboundCipher.update(encrypted));
    const expected = hmacSha256(this.inboundMac, concat(u32(this.inboundSequence), packet));
    if (!equal(mac, expected)) throw new Error("vSSH packet MAC mismatch");
    return this.packetPayload(packet);
  }

  packetPayload(packet) {
    const packetLength = readU32(packet);
    const paddingLength = packet[4];
    if (paddingLength < 4 || paddingLength + 1 > packetLength) throw new Error("vSSH padding invalid");
    this.inboundSequence = (this.inboundSequence + 1) >>> 0;
    return packet.slice(5, 4 + packetLength - paddingLength);
  }

  sendPacket(payload) {
    const blockSize = this.outboundCipher ? 16 : 8;
    let paddingLength = blockSize - ((payload.length + 5) % blockSize);
    if (paddingLength < 4) paddingLength += blockSize;
    const packet = concat(u32(payload.length + paddingLength + 1), Uint8Array.of(paddingLength), payload, randomBytes(paddingLength));
    if (this.outboundCipher) {
      const mac = hmacSha256(this.outboundMac, concat(u32(this.outboundSequence), packet));
      this.queue(concat(this.outboundCipher.update(packet), mac));
    } else this.queue(packet);
    this.outboundSequence = (this.outboundSequence + 1) >>> 0;
  }

  handle(payload) {
    const type = payload[0];
    if (type === 1) {
      const reader = new Reader(payload.slice(1));
      let reasonCode = null;
      let description = "";
      try {
        reasonCode = reader.uint32();
        description = reader.string();
      } catch {}
      this.service.audit(this.metadata, "transport.disconnect", {
        phase: this.phase,
        reasonCode,
        descriptionBytes: description.length,
      });
      this.closed = true;
      return;
    }
    if (type === 20) return this.onKexInit(payload);
    if (type === 21) return this.onNewKeys();
    if (type === 30) return this.onKexEcdhInit(payload);
    if (type === 5) return this.onServiceRequest(payload);
    if (type === 50) return this.onUserAuth(payload);
    if (type === 80) return this.onGlobalRequest(payload);
    if (type === 90) return this.onChannelOpen(payload);
    if (type === 93) return this.onWindowAdjust(payload);
    if (type === 94) return this.onChannelData(payload);
    if (type === 96 || type === 97) return this.onChannelClose(payload, type === 97);
    if (type === 98) return this.onChannelRequest(payload);
    if (![2, 3, 4].includes(type)) this.sendPacket(concat(Uint8Array.of(3), u32(this.inboundSequence - 1)));
  }

  onKexInit(payload) {
    this.clientKexInit = payload;
    try {
      const reader = new Reader(payload.slice(17));
      this.service.audit(this.metadata, "transport.kexinit", {
        kexAlgorithms: reader.string().split(","),
        hostKeyAlgorithms: reader.string().split(","),
        clientCiphers: reader.string().split(","),
        serverCiphers: reader.string().split(","),
        clientMacs: reader.string().split(","),
        serverMacs: reader.string().split(","),
        clientCompression: reader.string().split(","),
        serverCompression: reader.string().split(","),
      });
    } catch (error) {
      this.service.audit(this.metadata, "transport.kexinit.invalid", {
        error: error?.message ?? String(error),
      });
    }
  }

  onKexEcdhInit(payload) {
    if (!this.clientKexInit) throw new Error("vSSH received ECDH before KEXINIT");
    const reader = new Reader(payload.slice(1));
    const clientPublic = reader.stringBytes();
    if (clientPublic.length !== 32) throw new Error("vSSH Curve25519 public key length invalid");
    const privateKey = randomBytes(32);
    const serverPublic = deriveX25519(privateKey, X25519_BASEPOINT);
    const shared = deriveX25519(privateKey, clientPublic);
    if (shared.every((value) => value === 0)) throw new Error("vSSH Curve25519 shared secret is zero");
    const hostKey = sshString(concat(sshString("ssh-ed25519"), sshString(this.service.hostKey.publicKey)));
    const exchangeHash = sha256(concat(
      sshString(this.clientVersion), sshString(VERSION), sshString(this.clientKexInit),
      sshString(this.serverKexInit), hostKey, sshString(clientPublic), sshString(serverPublic), mpint(shared),
    ));
    this.sessionId = exchangeHash;
    const [inboundIV, outboundIV, inboundKey, outboundKey, inboundMac, outboundMac] = [
      deriveKey(shared, exchangeHash, "A", this.sessionId, 16),
      deriveKey(shared, exchangeHash, "B", this.sessionId, 16),
      deriveKey(shared, exchangeHash, "C", this.sessionId, 16),
      deriveKey(shared, exchangeHash, "D", this.sessionId, 16),
      deriveKey(shared, exchangeHash, "E", this.sessionId, 32),
      deriveKey(shared, exchangeHash, "F", this.sessionId, 32),
    ];
    this.pendingKeys = { inboundIV, outboundIV, inboundKey, outboundKey, inboundMac, outboundMac };
    const signature = signEd25519(this.service.hostKey.secretKey, exchangeHash);
    const signatureBlob = concat(sshString("ssh-ed25519"), sshString(signature));
    this.sendPacket(concat(Uint8Array.of(31), hostKey, sshString(serverPublic), sshString(signatureBlob)));
    this.sendPacket(Uint8Array.of(21));
    this.activateOutboundKeys();
  }

  onNewKeys() {
    if (!this.pendingKeys) throw new Error("vSSH NEWKEYS without pending keys");
    const keys = this.pendingKeys;
    this.inboundCipher = createCipheriv(keys.inboundKey, keys.inboundIV, true);
    this.inboundMac = keys.inboundMac;
    this.pendingKeys = null;
    this.phase = "service";
  }

  activateOutboundKeys() {
    const keys = this.pendingKeys;
    this.outboundCipher = createCipheriv(keys.outboundKey, keys.outboundIV);
    this.outboundMac = keys.outboundMac;
  }

  onServiceRequest(payload) {
    const service = new Reader(payload.slice(1)).string();
    this.service.audit(this.metadata, "transport.service", { service });
    if (service !== "ssh-userauth") throw new Error(`vSSH unsupported service ${service}`);
    this.sendPacket(concat(Uint8Array.of(6), sshString(service)));
  }

  onUserAuth(payload) {
    const reader = new Reader(payload.slice(1));
    const username = reader.string();
    const service = reader.string();
    const method = reader.string();
    this.service.audit(this.metadata, "auth.attempt", { username, service, method });
    if (service !== "ssh-connection") throw new Error("vSSH userauth service mismatch");
    let allowed = false;
    if (method === "none") {
      allowed = this.service.ctx.userDirectory.allowNoneAuth({
        connectionId: this.metadata.connectionId, username,
        remoteAddr: this.metadata.remoteAddr, clientVersion: this.clientVersion, method,
      });
    } else if (method === "publickey") {
      const hasSignature = reader.boolean();
      const algorithm = reader.string();
      const publicKeyBlob = reader.stringBytes();
      const key = new Reader(publicKeyBlob);
      const keyAlgorithm = key.string();
      const publicKey = key.stringBytes();
      if (algorithm !== "ssh-ed25519" || keyAlgorithm !== algorithm || publicKey.length !== 32) {
        this.service.authResult(this.metadata, username, method, false, "unsupported-public-key");
        this.sendPacket(concat(Uint8Array.of(51), sshString("none,publickey"), Uint8Array.of(0)));
        return;
      }
      const fingerprint = `SHA256:${base64Encode(sha256(publicKeyBlob), false)}`;
      const authContext = {
        connectionId: this.metadata.connectionId, username,
        remoteAddr: this.metadata.remoteAddr, clientVersion: this.clientVersion,
        publicKey: `${algorithm} ${base64Encode(publicKeyBlob)}`,
        fingerprint, method,
      };
      const known = Boolean(this.service.ctx.userDirectory.acceptsPublicKey(authContext));
      if (!hasSignature) {
        this.service.audit(this.metadata, "auth.publickey.probe", {
          username, algorithm, fingerprint, known,
        });
        if (known) this.sendPacket(concat(Uint8Array.of(60), sshString(algorithm), sshString(publicKeyBlob)));
        else this.sendPacket(concat(Uint8Array.of(51), sshString("none,publickey"), Uint8Array.of(0)));
        return;
      }
      const signedPayload = payload.slice(0, reader.offset + 1);
      const signatureBlob = new Reader(reader.stringBytes());
      const signatureAlgorithm = signatureBlob.string();
      const signature = signatureBlob.stringBytes();
      const verified = known && signatureAlgorithm === algorithm && signature.length === 64 &&
        verifyEd25519(publicKey, concat(sshString(this.sessionId), signedPayload), signature);
      allowed = verified && this.service.ctx.userDirectory.authenticatePublicKey(authContext);
    }
    if (!allowed) {
      this.service.authResult(this.metadata, username, method, false, "rejected");
      this.sendPacket(concat(Uint8Array.of(51), sshString("none,publickey"), Uint8Array.of(0)));
      return;
    }
    this.username = username;
    this.identity = this.service.ctx.userDirectory.identityForConnection(this.metadata.connectionId);
    this.phase = "connection";
    this.service.authResult(this.metadata, username, method, true);
    this.sendPacket(Uint8Array.of(52));
  }

  onGlobalRequest(payload) {
    const reader = new Reader(payload.slice(1));
    reader.string();
    if (reader.boolean()) this.sendPacket(Uint8Array.of(82));
  }

  onChannelOpen(payload) {
    const reader = new Reader(payload.slice(1));
    const type = reader.string();
    const remoteId = reader.uint32();
    const remoteWindow = reader.uint32();
    const remoteMaxPacket = reader.uint32();
    let forward = null;
    let forwardTarget = null;
    if (type === "direct-tcpip") {
      forwardTarget = {
        hostname: reader.string(),
        port: reader.uint32(),
        originatorAddress: reader.string(),
        originatorPort: reader.uint32(),
      };
    } else if (type !== "session") {
      this.service.audit(this.metadata, "channel.open", {
        type, accepted: false, remoteWindow, remoteMaxPacket,
      });
      this.sendPacket(concat(Uint8Array.of(92), u32(remoteId), u32(1), sshString("unsupported channel"), sshString("en")));
      return;
    }
    const localId = this.nextChannelId++;
    const channel = {
      localId, remoteId, remoteWindow, remoteMaxPacket, localWindow: 2 * 1024 * 1024,
      sessionId: crypto.randomBytes(12), stream: null, closed: false, pendingOutput: [],
      finishPending: null,
      cols: 80, rows: 24, term: "xterm-256color", env: {}, type, forward: null,
    };
    if (type === "direct-tcpip") {
      try {
        forward = this.service.ctx.portForward.open(this, channel, forwardTarget);
        channel.forward = forward;
      } catch (error) {
        this.service.audit(this.metadata, "channel.open", {
          type, accepted: false, target: forwardTarget, error: error?.message ?? String(error),
        });
        this.sendPacket(concat(Uint8Array.of(92), u32(remoteId), u32(2), sshString("connect failed"), sshString("en")));
        return;
      }
    }
    this.channels.set(localId, channel);
    this.service.audit(this.metadata, "channel.open", {
      type, accepted: true, localId, remoteId, remoteWindow, remoteMaxPacket, target: forwardTarget,
    }, this.channels.get(localId).sessionId);
    this.sendPacket(concat(Uint8Array.of(91), u32(remoteId), u32(localId), u32(2 * 1024 * 1024), u32(32768)));
  }

  channelFromPayload(payload) {
    const reader = new Reader(payload.slice(1));
    const localId = reader.uint32();
    const channel = this.channels.get(localId);
    if (!channel) throw new Error(`vSSH unknown channel ${localId}`);
    return { channel, reader };
  }

  onWindowAdjust(payload) {
    const { channel, reader } = this.channelFromPayload(payload);
    channel.remoteWindow += reader.uint32();
    this.flushChannelData(channel);
  }

  onChannelData(payload) {
    const { channel, reader } = this.channelFromPayload(payload);
    const data = reader.stringBytes();
    this.sendPacket(concat(Uint8Array.of(93), u32(channel.remoteId), u32(data.length)));
    if (channel.forward) {
      this.service.audit(this.metadata, "channel.forward.input", {
        localId: channel.localId, remoteId: channel.remoteId, bytes: data.length,
      }, channel.sessionId);
      this.service.ctx.portForward.write(channel.forward, data);
      return;
    }
    if (!channel.stream) return;
    const decision = globalThis.policy.onStreamData({
      connectionId: this.metadata.connectionId, sessionId: channel.sessionId,
      stream: channel.stream, dataBytes: data,
    });
    this.writeDecision(channel, decision);
    if (decision.done) this.finishChannel(channel, decision.exitCode ?? 0);
  }

  onChannelRequest(payload) {
    const { channel, reader } = this.channelFromPayload(payload);
    const request = reader.string();
    const wantsReply = reader.boolean();
    let requestContext = {
      connectionId: this.metadata.connectionId,
      sessionId: channel.sessionId,
      request,
      cols: channel.cols,
      rows: channel.rows,
      term: channel.term,
      env: channel.env,
    };
    if (request === "exec") {
      const command = reader.string();
      requestContext = { ...requestContext, command };
      this.service.audit(this.metadata, "session.request", requestContext, channel.sessionId);
      const decision = globalThis.policy.onExec({
        connectionId: this.metadata.connectionId, sessionId: channel.sessionId, command,
        env: { ...channel.env },
      });
      const execAllowed = decision.allow !== false;
      if (wantsReply) this.sendPacket(concat(Uint8Array.of(execAllowed ? 99 : 100), u32(channel.remoteId)));
      if (execAllowed) {
        this.writeDecision(channel, decision);
        if (decision.stream) channel.stream = decision.stream;
        else this.finishChannel(channel, decision.exitCode ?? 0);
      }
      return;
    }
    if (request === "env") {
      const name = reader.string();
      const value = reader.string();
      channel.env[name] = value;
      requestContext = { ...requestContext, name, value };
    } else if (request === "pty-req") {
      channel.term = reader.string();
      channel.cols = reader.uint32();
      channel.rows = reader.uint32();
      const widthPixels = reader.uint32();
      const heightPixels = reader.uint32();
      const modes = reader.stringBytes();
      requestContext = {
        ...requestContext,
        term: channel.term,
        cols: channel.cols,
        rows: channel.rows,
        widthPixels,
        heightPixels,
        modes: Array.from(modes),
      };
    } else if (request === "window-change") {
      channel.cols = reader.uint32();
      channel.rows = reader.uint32();
      requestContext = {
        ...requestContext,
        cols: channel.cols,
        rows: channel.rows,
        widthPixels: reader.uint32(),
        heightPixels: reader.uint32(),
      };
    } else if (request === "signal") {
      requestContext = { ...requestContext, signal: reader.string() };
    } else if (request === "break") {
      requestContext = { ...requestContext, lengthMs: reader.uint32() };
    } else if (request === "subsystem") {
      requestContext = { ...requestContext, subsystem: reader.string() };
    }
    const supported = ["env", "pty-req", "window-change", "signal", "break", "shell"].includes(request);
    const decision = supported
      ? globalThis.policy.onRequest(requestContext)
      : { allow: false };
    const allowed = decision.allow !== false;
    this.service.audit(this.metadata, "session.request", {
      ...requestContext, allowed,
    }, channel.sessionId);
    if (wantsReply) this.sendPacket(concat(Uint8Array.of(allowed ? 99 : 100), u32(channel.remoteId)));
    if (allowed && request === "shell") {
      this.writeDecision(channel, decision);
      if (decision.stream) channel.stream = decision.stream;
      else this.finishChannel(channel, decision.exitCode ?? 0);
    }
  }

  writeDecision(channel, decision = {}) {
    if (decision.sensitive) this.outputSensitive = true;
    if (decision.stdoutBytes?.length) this.sendChannelData(channel, bytes(decision.stdoutBytes), false);
    if (decision.stdout) this.sendChannelData(channel, bytes(decision.stdout), false);
    if (decision.stderr) this.sendChannelData(channel, bytes(decision.stderr), true);
  }

  sendChannelData(channel, data, stderr) {
    if (data.length > 0) channel.pendingOutput.push({ data, offset: 0, stderr });
    this.flushChannelData(channel);
  }

  flushChannelData(channel) {
    while (channel.pendingOutput.length > 0 && channel.remoteWindow > 0) {
      const pending = channel.pendingOutput[0];
      const size = Math.min(pending.data.length - pending.offset, channel.remoteMaxPacket || 32768, channel.remoteWindow);
      if (size <= 0) return;
      const chunk = pending.data.slice(pending.offset, pending.offset + size);
      const prefix = pending.stderr
        ? concat(Uint8Array.of(95), u32(channel.remoteId), u32(1), sshString(chunk))
        : concat(Uint8Array.of(94), u32(channel.remoteId), sshString(chunk));
      this.sendPacket(prefix);
      channel.remoteWindow -= size;
      pending.offset += size;
      if (pending.offset === pending.data.length) channel.pendingOutput.shift();
    }
    if (channel.pendingOutput.length === 0 && channel.finishPending && !channel.closed) {
      const finish = channel.finishPending;
      channel.finishPending = null;
      if (finish.kind === "forward") this.finishForwardChannel(channel, finish.error);
      else this.finishChannel(channel, finish.exitCode);
    }
  }

  poll() {
    for (const channel of this.channels.values()) {
      if (channel.forward && !channel.closed) {
        const drained = this.service.ctx.portForward.drain(channel.forward);
        if (drained.dataBytes?.length || drained.closed || drained.error) {
          this.service.audit(this.metadata, "channel.forward.output", {
            localId: channel.localId, remoteId: channel.remoteId,
            bytes: drained.dataBytes?.length ?? 0, closed: drained.closed === true,
            error: drained.error || null,
          }, channel.sessionId);
        }
        if (drained.dataBytes?.length) this.sendChannelData(channel, bytes(drained.dataBytes), false);
        if (drained.closed) this.finishForwardChannel(channel, drained.error);
        continue;
      }
      if (!channel.stream || channel.closed || channel.finishPending) continue;
      const decision = globalThis.policy.onStreamPoll({
        connectionId: this.metadata.connectionId, sessionId: channel.sessionId, stream: channel.stream,
      });
      this.writeDecision(channel, decision);
      if (decision.done) this.finishChannel(channel, decision.exitCode ?? 0);
    }
  }

  onChannelClose(payload, close) {
    const { channel } = this.channelFromPayload(payload);
    if (!close) {
      if (channel.forward) this.service.ctx.portForward.closeWrite(channel.forward);
      return;
    }
    this.service.audit(this.metadata, "channel.close", {
      localId: channel.localId, remoteId: channel.remoteId, stream: channel.stream,
    }, channel.sessionId);
    if (channel.stream) globalThis.policy.onStreamClose({
      connectionId: this.metadata.connectionId, sessionId: channel.sessionId, stream: channel.stream,
    });
    if (channel.forward) this.service.ctx.portForward.close(channel.forward);
    channel.closed = true;
    if (!channel.closeSent) this.sendPacket(concat(Uint8Array.of(97), u32(channel.remoteId)));
    this.channels.delete(channel.localId);
  }

  finishChannel(channel, exitCode) {
    if (channel.closed) return;
    if (channel.pendingOutput.length > 0) {
      channel.finishPending = { kind: "session", exitCode };
      return;
    }
    this.sendPacket(concat(Uint8Array.of(98), u32(channel.remoteId), sshString("exit-status"), Uint8Array.of(0), u32(exitCode)));
    this.sendPacket(concat(Uint8Array.of(96), u32(channel.remoteId)));
    this.sendPacket(concat(Uint8Array.of(97), u32(channel.remoteId)));
    channel.closed = true;
    channel.closeSent = true;
  }

  finishForwardChannel(channel, error) {
    if (channel.closed) return;
    if (channel.pendingOutput.length > 0) {
      channel.finishPending = { kind: "forward", error };
      return;
    }
    this.service.audit(this.metadata, "channel.forward.closed", {
      localId: channel.localId,
      remoteId: channel.remoteId,
      target: channel.forward ? { hostname: channel.forward.hostname, port: channel.forward.port } : null,
      error: error || null,
    }, channel.sessionId);
    this.service.ctx.portForward.close(channel.forward);
    this.sendPacket(concat(Uint8Array.of(96), u32(channel.remoteId)));
    this.sendPacket(concat(Uint8Array.of(97), u32(channel.remoteId)));
    channel.closed = true;
    channel.closeSent = true;
  }
}

export { VSSHConnection as VSSHConnectionForTest };

export class VSSHService extends Service {
  constructor(ctx) {
    super(ctx, "vssh");
    this.ctx = ctx;
    this.connections = new Map();
    this.hostKey = null;
  }

  audit(metadata, type, payload = {}, sessionId = "") {
    const connectionId = metadata?.connectionId ?? "";
    const record = {
      remoteAddr: metadata?.remoteAddr ?? null,
      ...payload,
    };
    // Normal protocol telemetry is intentionally silent. Crossing the host
    // logging bridge once per SSH packet/channel is itself enough to starve a
    // busy Desktop connection. Connection/authentication state remains in the
    // dedicated connections table; only malformed/error paths reach journal.
    if (type.endsWith(".error") || type.endsWith(".invalid")) {
      console.warn(`[vssh] ${type} connection=${connectionId} session=${sessionId || "-"} ${JSON.stringify(record)}`);
    } else if (type === "transport.disconnect") {
      console.info(`[vssh] transport.disconnect ${JSON.stringify({
        connectionId,
        phase: payload.phase ?? null,
        reasonCode: payload.reasonCode ?? null,
        descriptionBytes: payload.descriptionBytes ?? 0,
      })}`);
    } else if (type === "transport.close") {
      console.info(`[vssh] transport.close ${JSON.stringify({
        connectionId,
        phase: payload.phase ?? null,
        channels: payload.channels ?? 0,
        transportOutputBytes: payload.transportOutputBytes ?? 0,
        channelPendingOutputBytes: payload.channelPendingOutputBytes ?? 0,
      })}`);
    }
  }

  identify(metadata, clientVersion) {
    if (this.ctx.storage.available && metadata?.connectionId) {
      this.ctx.storage.sql.exec(
        "UPDATE connections SET client_version = ? WHERE id = ?",
        clientVersion, metadata.connectionId,
      );
    }
    this.audit(metadata, "transport.identification", { clientVersion });
  }

  authResult(metadata, username, method, accepted, reason = null) {
    if (this.ctx.storage.available && metadata?.connectionId) {
      this.ctx.storage.sql.exec(
        "UPDATE connections SET username = ?, authenticated = ? WHERE id = ?",
        username, accepted ? 1 : 0, metadata.connectionId,
      );
    }
    this.audit(metadata, "auth.result", { username, method, accepted, reason });
  }

  loadHostKey() {
    if (this.ctx.storage.available) {
      const row = this.ctx.storage.sql.exec(
        "SELECT private_material FROM node_identities WHERE kind = ?",
        "ssh-ed25519",
      ).toArray()[0];
      if (row?.private_material) return parseOpenSSHPrivateKey(row.private_material);
    }
    const stored = policyStore.get("vssh", "ephemeralHostSecret");
    const secret = stored ? base64Decode(stored) : randomBytes(32);
    if (!stored) {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let encoded = "";
      for (let index = 0; index < secret.length; index += 3) {
        const value = (secret[index] << 16) | ((secret[index + 1] ?? 0) << 8) | (secret[index + 2] ?? 0);
        encoded += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63] +
          (index + 1 < secret.length ? alphabet[(value >>> 6) & 63] : "=") +
          (index + 2 < secret.length ? alphabet[value & 63] : "=");
      }
      policyStore.set("vssh", "ephemeralHostSecret", encoded);
    }
    return { publicKey: ed25519.getPublicKey(secret), secretKey: secret };
  }

  open(metadata) {
    this.hostKey ||= this.loadHostKey();
    const connection = new VSSHConnection(this, metadata);
    this.connections.set(metadata.connectionId, connection);
    this.audit(metadata, "transport.open", { serverVersion: VERSION });
    return connection.drainDecision();
  }

  data(metadata) {
    const connection = this.connections.get(metadata.connectionId);
    if (!connection) return { allow: false };
    try {
      connection.enqueue(metadata.dataBytes);
      return connection.drainDecision();
    } catch (error) {
      this.audit(metadata, "transport.error", {
        phase: connection.phase,
        error: error?.message ?? String(error),
        stack: typeof error?.stack === "string" ? error.stack.slice(0, 4096) : null,
      });
      return { allow: false, stderr: error.message || String(error) };
    }
  }

  poll(metadata) {
    const connection = this.connections.get(metadata.connectionId);
    if (!connection) return { allow: false };
    try {
      if (connection.asyncError) throw connection.asyncError;
      connection.poll();
      return connection.drainDecision();
    } catch (error) {
      this.audit(metadata, "transport.error", {
        phase: connection.phase,
        source: "poll",
        error: error?.message ?? String(error),
        stack: typeof error?.stack === "string" ? error.stack.slice(0, 4096) : null,
      });
      return { allow: false, stderr: error?.message ?? String(error) };
    }
  }

  close(metadata) {
    const connection = this.connections.get(metadata.connectionId);
    const transportOutputBytes = (connection?.output ?? []).reduce(
      (total, chunk) => total + (chunk?.length ?? 0),
      0,
    );
    const channelPendingOutputBytes = [...(connection?.channels.values() ?? [])].reduce(
      (total, channel) => total + channel.pendingOutput.reduce(
        (channelTotal, pending) => channelTotal + Math.max(0, pending.data.length - pending.offset),
        0,
      ),
      0,
    );
    for (const channel of connection?.channels.values() ?? []) {
      if (channel.stream) globalThis.policy.onStreamClose({
        connectionId: metadata.connectionId, sessionId: channel.sessionId, stream: channel.stream,
      });
      if (channel.forward) this.ctx.portForward.close(channel.forward);
    }
    connection?.closeCrypto();
    this.audit(metadata, "transport.close", {
      phase: connection?.phase ?? "unknown",
      clientVersion: connection?.clientVersion ?? null,
      username: connection?.username ?? null,
      channels: connection?.channels.size ?? 0,
      transportOutputBytes,
      channelPendingOutputBytes,
    });
    this.connections.delete(metadata.connectionId);
    return { allow: true };
  }
}

VSSHService.inject = ["portForward", "storage", "userDirectory"];
