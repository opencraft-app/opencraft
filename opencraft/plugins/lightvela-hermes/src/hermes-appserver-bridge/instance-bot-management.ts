import { parseInstanceProfileBots, type HermesInstanceProfileBot } from "./instance-profile-bots";

export interface HermesBotManagementPort {
  revision(bot: HermesInstanceProfileBot): number;
  create(request: { clientRequestId: string; name: string; templateId?: string }): Promise<HermesInstanceProfileBot>;
  update(botId: string, revision: number, patch: { name?: string; subtitle?: string }): Promise<HermesInstanceProfileBot>;
  delete(botId: string, revision: number): Promise<void>;
}

const fault = (code: string, message: string) => Object.assign(new Error(message), {
  rpcCode: -32049, domainData: { code, retryable: false },
});

/** One physical Host owns this control-plane port across bridge reconnects. */
export class HermesInstanceBotManagement implements HermesBotManagementPort {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly revisions = new Map<string, { fingerprint: string; revision: number }>();
  private readonly creates = new Map<string, { params: string; result: Promise<HermesInstanceProfileBot> }>();
  constructor(private readonly instanceId: string,
    private readonly request: <T>(path: string, init?: RequestInit) => Promise<T>) {}

  private get path(): string { return `/v1/instances/${encodeURIComponent(this.instanceId)}/bots`; }

  revision(bot: HermesInstanceProfileBot): number {
    const fingerprint = JSON.stringify([bot.botId, bot.nativeProfile, bot.name, bot.description ?? "", bot.status]);
    const previous = this.revisions.get(bot.botId);
    const revision = previous === undefined ? 1 : previous.revision + Number(previous.fingerprint !== fingerprint);
    this.revisions.set(bot.botId, { fingerprint, revision });
    return revision;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private name(value: string): string {
    const name = value.trim();
    if ([...name].length < 1 || [...name].length > 60) throw fault("BOT_INVALID_NAME", "Bot 名称须为 1–60 个字符。");
    return name;
  }

  private async read(botId: string, revision?: number): Promise<HermesInstanceProfileBot> {
    const bots = parseInstanceProfileBots(await this.request(this.path), this.instanceId);
    const bot = bots.find(bot => bot.botId === botId);
    if (!bot) throw fault("BOT_NOT_FOUND", "Bot 已不存在，请刷新列表。");
    if (revision !== undefined && this.revision(bot) !== revision) throw fault("BOT_REVISION_CONFLICT", "Bot 已发生变化，请刷新后重新操作。");
    return bot;
  }

  private async write(path: string, method: string, body?: unknown): Promise<unknown> {
    try {
      return await this.request(path, { method, ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }) });
    } catch (error) {
      const status = typeof error === "object" && error !== null ? (error as { status?: number }).status : undefined;
      if (status !== undefined && status >= 400 && status < 500 && status !== 408) throw error;
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      const diagnostic = status !== undefined && Number.isInteger(status)
        ? `（HTTP ${status}${typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? ` · ${code}` : ""}）`
        : "";
      throw fault("BOT_MUTATION_OUTCOME_UNKNOWN", `操作结果尚未确认${diagnostic}，请刷新 Bot 列表核对；请勿重复创建或删除。`);
    }
  }

  create(input: { clientRequestId: string; name: string; templateId?: string }): Promise<HermesInstanceProfileBot> {
    const name = this.name(input.name);
    if (!input.clientRequestId.trim()) return Promise.reject(fault("BOT_INVALID_REQUEST", "缺少创建操作标识。"));
    const params = JSON.stringify([name, input.templateId ?? null]);
    const previous = this.creates.get(input.clientRequestId);
    if (previous) return previous.params === params ? previous.result : Promise.reject(fault("BOT_IDEMPOTENCY_CONFLICT", "创建操作标识已用于其他内容。"));
    if (this.creates.size >= 256) return Promise.reject(fault("BOT_OPERATION_LIMIT", "本次连接的创建操作过多，请重新连接后继续。"));
    const result = this.serial(async () => {
      if (input.templateId !== undefined) await this.read(input.templateId);
      const created = await this.write(this.path, "POST", {
        name, create_mode: input.templateId === undefined ? "blank" : "clone",
        ...(input.templateId === undefined ? {} : { source_bot_id: input.templateId }),
      });
      return parseInstanceProfileBots({ items: [created] }, this.instanceId)[0]!;
    });
    this.creates.set(input.clientRequestId, { params, result });
    return result;
  }

  update(botId: string, revision: number, patch: { name?: string; subtitle?: string }): Promise<HermesInstanceProfileBot> {
    return this.serial(async () => {
      await this.read(botId, revision);
      const updated = await this.write(`${this.path}/${encodeURIComponent(botId)}`, "PUT", {
        ...(patch.name === undefined ? {} : { name: this.name(patch.name) }),
        ...(patch.subtitle === undefined ? {} : { description: patch.subtitle }),
      });
      const bot = parseInstanceProfileBots({ items: [updated] }, this.instanceId)[0]!;
      if (bot.botId !== botId) throw fault("BOT_IDENTITY_MISMATCH", "更新结果与目标 Bot 不一致。");
      return bot;
    });
  }

  delete(botId: string, revision: number): Promise<void> {
    return this.serial(async () => {
      const bot = await this.read(botId, revision);
      if (bot.nativeProfile === "default") throw fault("BOT_DELETE_UNAVAILABLE", "默认 Bot 不能单独删除。");
      await this.write(`${this.path}/${encodeURIComponent(botId)}`, "DELETE");
    });
  }
}
