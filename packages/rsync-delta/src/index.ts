/** Rsync-style byte deltas. No filesystem, transport, crypto implementation or
 * directory ownership lives here. The caller supplies a trusted SHA-256 port. */
export interface Manifest { id: string; length: number; sha256: string }
export interface BlockSignature { length: number; weak: number; strong: string }
export interface Signatures {
  version: 1; context: string; basis: Manifest; blockSize: number; blocks: BlockSignature[];
}
export type Operation = { type: "copy"; offset: number; length: number } | { type: "literal"; data: Uint8Array };
export interface Delta { version: 1; context: string; basis: Manifest; target: Manifest; operations: Operation[] }
export interface Limits { maxBytes: number; maxBlocks: number; maxOperations: number; maxHashBytes: number }
export interface Statistics { copiedBytes: number; literalBytes: number; strongChecks: number; rollingSteps: number; hashedBytes: number }
export type Sha256 = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
export interface Cancellation { readonly aborted: boolean }
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxBytes: 64 * 1024 * 1024, maxBlocks: 65536, maxOperations: 65536, maxHashBytes: 512 * 1024 * 1024,
});
export class RsyncError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "CONTEXT_MISMATCH" | "BASIS_MISMATCH" | "TARGET_MISMATCH" | "LIMIT_EXCEEDED" | "ABORTED", message: string) { super(message); }
}
const invalid = (): never => { throw new RsyncError("INVALID_INPUT", "Invalid rsync delta input"); };
const integer = (n: number, min = 0): boolean => Number.isSafeInteger(n) && n >= min;
const identity = (s: string): string => { if (typeof s !== "string" || !s || s.length > 4096) invalid(); return s; };
const digest = (s: string): string => { if (typeof s !== "string" || !/^[a-f0-9]{64}$/.test(s)) invalid(); return s; };
const pack = (a: number, b: number): number => ((b << 16) | a) >>> 0;

/** a = sum(bytes), b = sum((length-i)*byte[i]), both modulo 2^16. */
export function rollingChecksum(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array)) invalid();
  let a = 0, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]!) & 65535; b = (b + a) & 65535; }
  return pack(a, b);
}
/** Precondition: checksum describes the previous window of this length, whose
 * first byte is outgoing. Reducing length before multiplying avoids JS overflow. */
export function rollChecksum(checksum: number, length: number, outgoing: number, incoming: number): number {
  if (!integer(checksum) || checksum > 0xffffffff || !integer(length, 1)
    || !integer(outgoing) || outgoing > 255 || !integer(incoming) || incoming > 255) invalid();
  const a = ((checksum & 65535) - outgoing + incoming) & 65535;
  const b = ((checksum >>> 16) - (length & 65535) * outgoing + a) & 65535;
  return pack(a, b);
}

class Work {
  hashedBytes = 0;
  constructor(readonly hash: Sha256, readonly limits: Limits, readonly signal?: Cancellation) {}
  check(): void { if (this.signal?.aborted) throw new RsyncError("ABORTED", "Rsync operation cancelled"); }
  async sha(bytes: Uint8Array): Promise<string> {
    this.check();
    if (bytes.length > this.limits.maxHashBytes - this.hashedBytes) throw new RsyncError("LIMIT_EXCEEDED", "Rsync hash budget exhausted");
    this.hashedBytes += bytes.length;
    // The provider borrows a copy: it cannot mutate the algorithm's snapshots.
    const result = await this.hash(bytes.slice()); this.check();
    if (!(result instanceof Uint8Array) || result.length !== 32) invalid();
    let hex = ""; for (const byte of result) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }
}

export class RsyncDelta {
  private readonly limits: Limits;
  constructor(private readonly sha256: Sha256, limits: Partial<Limits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (typeof sha256 !== "function" || Object.values(this.limits).some(n => !integer(n)) || this.limits.maxBytes > 0x7fffffff) invalid();
  }
  private bytes(value: Uint8Array): Uint8Array {
    if (!(value instanceof Uint8Array)) invalid();
    const length = value.length;
    if (length > this.limits.maxBytes) throw new RsyncError("LIMIT_EXCEEDED", "Rsync byte budget exhausted");
    // Fix the checked length even for a length-tracking growable shared view.
    const copy = new Uint8Array(length);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, length));
    return copy;
  }
  private manifest(value: Manifest): Manifest {
    if (!value || typeof value !== "object" || !integer(value.length)) invalid();
    if (value.length > this.limits.maxBytes) throw new RsyncError("LIMIT_EXCEEDED", "Rsync byte budget exhausted");
    return { id: identity(value.id), length: value.length, sha256: digest(value.sha256) };
  }
  async createSignatures(input: Uint8Array, options: { context: string; basisId: string; blockSize: number }, signal?: Cancellation): Promise<Signatures> {
    const context = identity(options.context), id = identity(options.basisId), blockSize = options.blockSize;
    if (!integer(blockSize, 1) || blockSize > 0x7fffffff) invalid();
    const bytes = this.bytes(input), work = new Work(this.sha256, this.limits, signal);
    if (Math.ceil(bytes.length / blockSize) > this.limits.maxBlocks) throw new RsyncError("LIMIT_EXCEEDED", "Too many rsync signatures");
    const basis = { id, length: bytes.length, sha256: await work.sha(bytes) }, blocks: BlockSignature[] = [];
    for (let at = 0; at < bytes.length; at += blockSize) {
      const block = bytes.subarray(at, Math.min(at + blockSize, bytes.length));
      blocks.push({ length: block.length, weak: rollingChecksum(block), strong: await work.sha(block) });
    }
    return { version: 1, context, basis, blockSize, blocks };
  }
  private signatures(value: Signatures): Signatures {
    if (!value || value.version !== 1 || !integer(value.blockSize, 1) || value.blockSize > 0x7fffffff || !Array.isArray(value.blocks)) invalid();
    const basis = this.manifest(value.basis), context = identity(value.context);
    if (value.blocks.length > this.limits.maxBlocks) throw new RsyncError("LIMIT_EXCEEDED", "Too many rsync signatures");
    if (value.blocks.length !== Math.ceil(basis.length / value.blockSize)) invalid();
    const blocks = Array.from(value.blocks, (block, index) => {
      if (!block || block.length !== Math.min(value.blockSize, basis.length - index * value.blockSize)
        || !integer(block.weak) || block.weak > 0xffffffff) invalid();
      return { length: block.length, weak: block.weak, strong: digest(block.strong) };
    });
    return { version: 1, context, basis, blockSize: value.blockSize, blocks };
  }
  async createDelta(input: Uint8Array, signatures: Signatures, expected: { context: string; basisId: string; targetId: string }, signal?: Cancellation): Promise<{ delta: Delta; statistics: Statistics }> {
    const sig = this.signatures(signatures), context = identity(expected.context), targetId = identity(expected.targetId);
    if (sig.context !== context) throw new RsyncError("CONTEXT_MISMATCH", "Rsync context differs");
    if (sig.basis.id !== identity(expected.basisId)) throw new RsyncError("BASIS_MISMATCH", "Rsync basis identity differs");
    const bytes = this.bytes(input), work = new Work(this.sha256, this.limits, signal);
    const target = { id: targetId, length: bytes.length, sha256: await work.sha(bytes) };
    // Length -> weak checksum -> strong digest -> first matching basis offset.
    const index = new Map<number, Map<number, Map<string, number>>>();
    sig.blocks.forEach((block, i) => {
      let lengths = index.get(block.length); if (!lengths) index.set(block.length, lengths = new Map());
      let weak = lengths.get(block.weak); if (!weak) lengths.set(block.weak, weak = new Map());
      if (!weak.has(block.strong)) weak.set(block.strong, i * sig.blockSize);
    });
    const windows = [...index.keys()].sort((a, b) => b - a).filter(length => length <= bytes.length)
      .map(length => ({ length, at: 0, weak: rollingChecksum(bytes.subarray(0, length)) }));
    const operations: Operation[] = [], statistics: Statistics = { copiedBytes: 0, literalBytes: 0, strongChecks: 0, rollingSteps: 0, hashedBytes: 0 };
    const push = (op: Operation) => {
      const previous = operations.at(-1);
      if (op.type === "copy" && previous?.type === "copy" && previous.offset + previous.length === op.offset) previous.length += op.length;
      else {
        if (operations.length >= this.limits.maxOperations) throw new RsyncError("LIMIT_EXCEEDED", "Too many rsync operations");
        operations.push(op);
      }
    };
    let at = 0, literal = 0;
    const flush = () => { if (literal < at) { push({ type: "literal", data: bytes.slice(literal, at) }); statistics.literalBytes += at - literal; } };
    while (at < bytes.length) {
      work.check(); let match: { offset: number; length: number } | undefined;
      for (const rolling of windows) {
        if (rolling.length > bytes.length - at) continue;
        while (rolling.at < at) {
          rolling.weak = rollChecksum(rolling.weak, rolling.length, bytes[rolling.at]!, bytes[rolling.at + rolling.length]!);
          rolling.at++; statistics.rollingSteps++;
        }
        const candidates = index.get(rolling.length)!.get(rolling.weak); if (!candidates) continue;
        statistics.strongChecks++;
        const strong = await work.sha(bytes.subarray(at, at + rolling.length));
        const offset = candidates.get(strong);
        if (offset !== undefined) { match = { offset, length: rolling.length }; break; }
      }
      if (match) {
        flush(); push({ type: "copy", ...match }); statistics.copiedBytes += match.length;
        at += match.length; literal = at;
      } else at++;
    }
    flush(); statistics.hashedBytes = work.hashedBytes;
    return { delta: { version: 1, context, basis: sig.basis, target, operations }, statistics };
  }
  async applyDelta(input: Uint8Array, value: Delta, expected: { context: string; basisId: string; target: Manifest }, signal?: Cancellation): Promise<Uint8Array> {
    if (!value || value.version !== 1 || !Array.isArray(value.operations)) invalid();
    const context = identity(value.context), basis = this.manifest(value.basis), target = this.manifest(value.target), wanted = this.manifest(expected.target);
    if (context !== identity(expected.context)) throw new RsyncError("CONTEXT_MISMATCH", "Rsync context differs");
    if (basis.id !== identity(expected.basisId)) throw new RsyncError("BASIS_MISMATCH", "Rsync basis identity differs");
    if (target.id !== wanted.id || target.length !== wanted.length || target.sha256 !== wanted.sha256) throw new RsyncError("TARGET_MISMATCH", "Rsync target manifest differs");
    if (value.operations.length > this.limits.maxOperations) throw new RsyncError("LIMIT_EXCEEDED", "Too many rsync operations");
    let produced = 0;
    // Validate and snapshot every instruction before allocating output/awaiting
    // crypto. No aliased literal or header may change under an async digest.
    const operations: Operation[] = Array.from(value.operations, op => {
      if (!op || typeof op !== "object") invalid();
      if (op.type === "copy") {
        if (!integer(op.offset) || !integer(op.length, 1) || op.offset > basis.length || op.length > basis.length - op.offset || op.length > target.length - produced) invalid();
        produced += op.length; return { type: "copy", offset: op.offset, length: op.length };
      }
      if (op.type !== "literal" || !(op.data instanceof Uint8Array)) invalid();
      const data = this.bytes(op.data);
      if (!data.length || data.length > target.length - produced) invalid();
      produced += data.length; return { type: "literal", data };
    });
    if (produced !== target.length) invalid();
    const bytes = this.bytes(input), work = new Work(this.sha256, this.limits, signal);
    if (bytes.length !== basis.length || await work.sha(bytes) !== basis.sha256) throw new RsyncError("BASIS_MISMATCH", "Rsync basis bytes differ");
    const output = new Uint8Array(target.length); let at = 0;
    for (const op of operations) {
      work.check();
      const data = op.type === "copy" ? bytes.subarray(op.offset, op.offset + op.length) : op.data;
      output.set(data, at); at += data.length;
    }
    if (await work.sha(output) !== target.sha256) throw new RsyncError("TARGET_MISMATCH", "Rsync reconstruction digest differs");
    return output;
  }
}
