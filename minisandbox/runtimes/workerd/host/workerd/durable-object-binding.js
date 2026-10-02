const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const ROUTER_TOKEN_HEADER = "X-Rivet-Object-Router-Token";
const ORIGINAL_URL_HEADER = "X-Rivet-Original-URL";
const UTF8 = new TextEncoder();
const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value, count) {
	return (value >>> count) | (value << (32 - count));
}

function sha256(value) {
	const input = UTF8.encode(value);
	const bitLength = input.length * 8;
	const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);
	const hash = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
		0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const words = new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index++) {
			words[index] = view.getUint32(offset + index * 4, false);
		}
		for (let index = 16; index < 64; index++) {
			const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
			const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
			words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = hash;
		for (let index = 0; index < 64; index++) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temporary1 = (h + sum1 + choice + SHA256_K[index] + words[index]) >>> 0;
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sum0 + majority) >>> 0;
			[h, g, f, e, d, c, b, a] = [g, f, e, (d + temporary1) >>> 0, c, b, a, (temporary1 + temporary2) >>> 0];
		}
		hash[0] = (hash[0] + a) >>> 0;
		hash[1] = (hash[1] + b) >>> 0;
		hash[2] = (hash[2] + c) >>> 0;
		hash[3] = (hash[3] + d) >>> 0;
		hash[4] = (hash[4] + e) >>> 0;
		hash[5] = (hash[5] + f) >>> 0;
		hash[6] = (hash[6] + g) >>> 0;
		hash[7] = (hash[7] + h) >>> 0;
	}
	return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

class RivetDurableObjectId {
	#namespace;
	#value;

	constructor(namespace, value) {
		this.#namespace = namespace;
		this.#value = value;
		Object.freeze(this);
	}

	belongsTo(namespace) {
		return this.#namespace === namespace;
	}

	equals(other) {
		return other instanceof RivetDurableObjectId && other.#value === this.#value && other.#namespace === this.#namespace;
	}

	toString() {
		return this.#value;
	}
}

class RivetDurableObjectStub {
	#className;
	#id;
	#router;
	#token;
	#worker;

	constructor(router, token, worker, className, id) {
		this.#router = router;
		this.#token = token;
		this.#worker = worker;
		this.#className = className;
		this.#id = id;
		Object.freeze(this);
	}

	get id() {
		return this.#id;
	}

	async fetch(input, init) {
		const request = new Request(input, init);
		const target = new URL(
			"http://object-router/internal/v1/workers/" + encodeURIComponent(this.#worker) +
				"/objects/" + encodeURIComponent(this.#className) + "/" +
				encodeURIComponent(this.#id.toString()) + "/fetch",
		);
		const forwarded = new Request(target, request);
		for (const name of [...forwarded.headers.keys()]) {
			if (name.toLowerCase().startsWith("x-rivet-")) forwarded.headers.delete(name);
		}
		forwarded.headers.set(ORIGINAL_URL_HEADER, request.url);
		forwarded.headers.set(ROUTER_TOKEN_HEADER, this.#token);
		return this.#router.fetch(forwarded);
	}
}

class RivetDurableObjectNamespace {
	#className;
	#domain;
	#router;
	#token;
	#worker;

	constructor(router, token, tenant, namespace, namespaceKey, worker, className) {
		this.#router = router;
		this.#token = token;
		this.#worker = worker;
		this.#className = className;
		this.#domain = `rivet-do-id/v1\0${tenant}\0${namespace}\0${namespaceKey}\0`;
		Object.freeze(this);
	}

	idFromName(name) {
		if (typeof name !== "string") throw new TypeError("Durable Object name must be a string");
		return new RivetDurableObjectId(this, sha256(this.#domain + name));
	}

	idFromString(value) {
		if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
			throw new TypeError("Durable Object ID must contain 64 lowercase hexadecimal characters");
		}
		return new RivetDurableObjectId(this, value);
	}

	newUniqueId() {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return new RivetDurableObjectId(
			this,
			[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
		);
	}

	get(id) {
		if (!(id instanceof RivetDurableObjectId) || !id.belongsTo(this)) {
			throw new TypeError("Durable Object ID belongs to another namespace");
		}
		return new RivetDurableObjectStub(this.#router, this.#token, this.#worker, this.#className, id);
	}
}

export function createDurableObjectNamespace(router, token, specification) {
	if (router === undefined || typeof token !== "string" || token.length < 16) {
		throw new Error("Durable Object routing capability is unavailable");
	}
	return new RivetDurableObjectNamespace(
		router,
		token,
		specification.tenant,
		specification.namespace,
		specification.namespaceKey,
		specification.worker,
		specification.className,
	);
}
