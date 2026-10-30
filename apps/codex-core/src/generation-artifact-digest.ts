import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";

const fileStamp = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mode, info.uid, info.gid, info.mtimeNs, info.ctimeNs].join(":");
const filesystem = {
  open: (path: string) => open(path, constants.O_RDONLY | constants.O_NONBLOCK),
  stat: (path: string) => stat(path, { bigint: true }),
};

/** Only fixed program artifacts belong here; mutable registry/HOME state is always read afresh. */
export class GenerationArtifactDigests {
  private readonly digests = new Map<string, string>();
  constructor(private readonly io = filesystem) {}

  async sha256(path: string): Promise<string> {
    const file = await this.io.open(path);
    let stamp: string | undefined;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new Error("Generation artifact must be a regular file");
      stamp = fileStamp(before);
      let digest = this.digests.get(stamp);
      if (!digest) {
        const hash = createHash("sha256");
        for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
        digest = hash.digest("hex");
      }
      // Check both the opened file and its current path, including on cache hits.
      // This rejects writes, metadata changes and atomic replacement during observation.
      if (fileStamp(await file.stat({ bigint: true })) !== stamp || fileStamp(await this.io.stat(path)) !== stamp) {
        throw new Error("Generation artifact changed during observation");
      }
      if (this.digests.size >= 64 && !this.digests.has(stamp)) this.digests.delete(this.digests.keys().next().value!);
      this.digests.set(stamp, digest);
      return digest;
    } catch (reason) {
      if (stamp) this.digests.delete(stamp);
      throw reason;
    } finally { await file.close(); }
  }
}

export const generationArtifactDigest = new GenerationArtifactDigests();
