export function createIdempotencyKey() {
  return createRandomKey("cmd");
}

export function createSessionIdempotencyKey() {
  return createRandomKey("ses");
}

export function createConfigIdempotencyKey() {
  return createRandomKey("cfg");
}

function createRandomKey(prefix: string) {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const suffix = Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
  return `${prefix}_${suffix}`;
}
