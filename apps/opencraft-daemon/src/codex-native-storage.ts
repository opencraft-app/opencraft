import { canonicalRolloutPath, type NativeRolloutSource } from "@opencraft/native-history-node/codex-rollout-reader";

/** Storage metadata only: the single AppServer's native HOME. This never claims
 * a Host lease or starts a runtime. */
export class CodexNativeStorage {
  constructor(private readonly home: () => string) {}

  private source(home: string): NativeRolloutSource {
    if (!home) throw new Error("Native HOME is unavailable");
    return { nativeHome: home, key: JSON.stringify(["single", home]), validate: async () => {
      if (this.home() !== home) throw new Error("Native storage owner changed during read");
    } };
  }

  async homes(): Promise<readonly NativeRolloutSource[]> {
    return [this.source(this.home())];
  }

  async resolve(_threadId: string, path: string): Promise<NativeRolloutSource> {
    const source = this.source(this.home());
    await canonicalRolloutPath(path, source.nativeHome);
    return source;
  }
}
