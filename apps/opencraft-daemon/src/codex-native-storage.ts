import { realpath } from "node:fs/promises";
import type { CodexCoreControlClient, CodexGenerationDirectory } from "@opencraft/account-pool-host";
import { canonicalRolloutPath, RolloutOutsideHomeError, type NativeRolloutSource } from "@opencraft/native-history-node/codex-rollout-reader";

type Home = CodexGenerationDirectory["homes"][number];

/** Storage metadata only. This never claims a Host lease or starts a runtime. */
export class CodexNativeStorage {
  constructor(private readonly control: Pick<CodexCoreControlClient, "generationDirectory"> | null,
    private readonly legacyHome: () => string) {}

  private directory(threadId?: string): Promise<CodexGenerationDirectory | null> {
    return this.control?.generationDirectory(threadId, AbortSignal.timeout(5_000)) ?? Promise.resolve(null);
  }

  private single(home: string, threadId?: string): NativeRolloutSource {
    if (!home) throw new Error("Native HOME is unavailable");
    return { nativeHome: home, key: JSON.stringify(["single", home]), validate: async () => {
      if (await this.directory(threadId) !== null || this.legacyHome() !== home) throw new Error("Native storage owner changed during read");
    } };
  }

  private source(directory: CodexGenerationDirectory, home: Home, threadId?: string): NativeRolloutSource {
    return { nativeHome: home.codexHome,
      key: JSON.stringify([directory.routingEpoch, home.generationId, home.incarnation, home.codexHome]),
      validate: async () => {
        const current = await this.directory(threadId), target = current?.homes.find(h => h.generationId === home.generationId);
        if (!current || current.routingEpoch !== directory.routingEpoch || !target
          || target.codexHome !== home.codexHome || target.incarnation !== home.incarnation
          || current.route && current.route.generationId !== home.generationId
          || directory.route && !current.route) throw new Error("Native storage owner changed during read");
      } };
  }

  async homes(): Promise<readonly NativeRolloutSource[]> {
    const directory = await this.directory();
    if (!directory) return [this.single(this.legacyHome())];
    // A registered but missing HOME is an availability failure, not empty usage.
    for (const home of directory.homes) await realpath(home.codexHome);
    return directory.homes.map(home => this.source(directory, home));
  }

  async resolve(threadId: string, path: string, allowUnrouted = false): Promise<NativeRolloutSource> {
    const directory = await this.directory(threadId);
    if (!directory) {
      const source = this.single(this.legacyHome(), threadId);
      await canonicalRolloutPath(path, source.nativeHome); return source;
    }
    if (directory.route) {
      const home = directory.homes.find(h => h.generationId === directory.route!.generationId);
      if (!home) throw new Error("Native Thread HOME is unavailable");
      await canonicalRolloutPath(path, home.codexHome); return this.source(directory, home, threadId);
    }
    if (!allowUnrouted) throw new Error("Native Thread has no registered generation");
    // Historical file discovery can precede execution-route discovery. Only a
    // registered HOME may supply bytes, and the usage parser checks session ID.
    for (const home of directory.homes) {
      try { await canonicalRolloutPath(path, home.codexHome); return this.source(directory, home, threadId); }
      catch (error) { if (!(error instanceof RolloutOutsideHomeError)) throw error; }
    }
    throw new RolloutOutsideHomeError();
  }
}
