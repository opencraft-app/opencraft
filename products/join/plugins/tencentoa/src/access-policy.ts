import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Installation admission is separate from employee authentication and resource permissions. */
export class TencentOaAccessPolicy {
  private readonly names: ReadonlySet<string>;
  constructor(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid employee access policy");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !["schemaVersion", "loginNames"].includes(key)) || input.schemaVersion !== 1
      || !Array.isArray(input.loginNames) || input.loginNames.length > 100_000
      || !input.loginNames.every(name => typeof name === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(name))) {
      throw new Error("Invalid employee access policy");
    }
    this.names = new Set((input.loginNames as string[]).map(name => name.toLowerCase()));
  }
  allows(loginName: string): boolean { return this.names.has(loginName.toLowerCase()); }
  /** Legacy names are a one-time input to instance-owned membership storage. */
  bindings(): readonly { provider: string; subject: string }[] { return [...this.names].map(name => ({ provider: 'tencentoa', subject: 'login:' + name })); }
  static async fromFile(path: string): Promise<TencentOaAccessPolicy> {
    if (!isAbsolute(path)) throw new Error("Employee access policy requires an absolute private path");
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_000_000 || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) throw new Error();
      return new TencentOaAccessPolicy(JSON.parse(await handle.readFile("utf8")));
    } catch { throw new Error("Employee access policy is unavailable or invalid"); }
    finally { await handle?.close(); }
  }
}
